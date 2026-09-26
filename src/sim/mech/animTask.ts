/**
 * The animation player and the gait selection that drives it.
 *
 * An ANIM resource (sim/mech/anim.ts) is a set of tracks sharing one frame
 * table; a TSK task of type 3 (anim_player_step) binds one track to one
 * scene node of the gamepiece the mission file is defining, and plays it.
 * Each gamepiece has exactly one CONTROLLING task (its TSK role value is
 * above 0x7f): only that one publishes the reached animation state and the
 * frame events to the MechEntity. The others follow the same frame table on
 * their own node, evaluating the same entity state.
 *
 * The entity fields the player works on (MechEntity +0x80..+0x94):
 *   motionFlags bit 0  an animation is playing (set by the controlling task
 *                      when there is a target or a state; cleared when it
 *                      ends with no target - and by the movement tick when
 *                      the mech leaves the ground or fires its jets)
 *   motionFlags bit 1  frame event 0x10 (the step MASC rolls on)
 *   motionFlags bit 3  frame event flags2 0x08 (the step sound)
 *   animState          the state (label) being played: 0 walk, 1 run,
 *                      2 walk backwards, -1 none
 *   animTarget         the state wanted, from mech_anim_select_gait
 *   gaitBand           0..3 from the throttle ramp; scales the frame time
 *   animFrameTicks     ticks per frame, anim_scale_by_gait(gaitBand, v1)
 *
 * Units: ticks of the 182 Hz clock; track values are added to the node's
 * translation (cm) or Euler angles (16.16 degrees) spread over a frame.
 */
import type { MechEntity, SceneNode } from '../../generated/classes.gen.ts';
import { AnimTask } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { divergence, quirk } from '../../core/provenance.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { sceneNodeRotateEuler, sceneNodeTranslate, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { objectGetNode } from '../../engine/scene/worldObject.ts';
import { taskGlobals } from '../../engine/tasks/taskList.ts';
import { detailRecordNode } from '../world/detailRecords.ts';
import { projectDetailFind, projectMangleId, projectObjectFind } from '../world/projectMaps.ts';
import { anim, type AnimTrackLive } from './anim.ts';
import { mechs, MECH_TABLE_SIZE } from './mechGlobals.ts';

export const animPlayer = registerGlobals(
  'animPlayer',
  {
    /**
     * 0x95a48: why anim_player_step gave up - 1 no current gamepiece at INIT,
     * 2 a task with role 0, 3 no node for the object id, 4 a disabled task
     * ticked, 5 no entity, 6 no base frame time, 7 animFrameTicks 0. Nothing
     * reads it.
     */
    animPlayerError: imageI32(LABEL.animPlayerError, 0),
    /**
     * 0xf43bc: per mech index, the animation state whose transition sound
     * last played (-2: settled). terrain_table_reset fills it with -2.
     */
    mechLastAnimState: new Int32Array(MECH_TABLE_SIZE),
  },
  () => {
    animPlayer.animPlayerError = imageI32(LABEL.animPlayerError, 0);
    animPlayer.mechLastAnimState = new Int32Array(MECH_TABLE_SIZE);
  },
);

/**
 * mechLastAnimState[0..59] = -2, before the mission's first frame.
 *
 * @mw2 terrain_table_reset 0x0001f440
 * @fidelity exact
 */
export function terrainTableReset(): void {
  animPlayer.mechLastAnimState.fill(-2);
}

/**
 * A frame time scaled by gait band: x1.5 in band 1, x0.75 in band 3.
 *
 * @mw2 anim_scale_by_gait 0x0001b190
 * @fidelity exact
 */
export function animScaleByGait(band: number, t: number): number {
  const b = band >>> 0;
  if (b === 1) return (t + (t >> 1)) | 0;
  if (b === 3) return (t - (t >> 2)) | 0;
  return t | 0;
}

/** Watcom atoi (clib_sub_0628fa): white space, a sign, digits. */
function atoi(s: string): number {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1]!, 10) | 0 : 0;
}

/** sscanf(s, "%ld,%d,%d", ...): the values it converts before the first mismatch; the rest stay 0. */
function scanThree(s: string): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  let at = 0;
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      if (s[at] !== ',') break;
      at++;
    }
    const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s.slice(at));
    if (!m) break;
    out[i] = parseInt(m[1]!, 10) | 0;
    at += m[0].length;
  }
  return out;
}

/** The frame's args[i] as the signed char the code reads. */
function arg(f: { args: string }, i: number): number {
  return ((f.args.charCodeAt(i) || 0) << 24) >> 24;
}

function frameAt(t: AnimTrackLive, i: number): { flags: number; flags2: number; args: string } {
  return t.frameTable[i] ?? { flags: 0, flags2: 0, args: '' };
}

function initTask(argText: string, tick: number): number {
  const cg = mechs.currentGamepiece;
  if (!cg) {
    animPlayer.animPlayerError = 1;
    return 0;
  }
  const t = new AnimTask();
  taskGlobals.currentTask!.data = t;
  t.node = null;
  t.track = null;
  t.enabled = 0;
  t.baseFrameTicks = 0;
  t.flags = 0;
  t.entity = cg;
  // the string is cut at its first ';' (the chunk's own bytes are overwritten)
  const semi = argText.indexOf(';');
  const head = semi >= 0 ? argText.slice(0, semi) : argText;
  if (semi >= 0) {
    const [v1, v2, v3raw] = scanThree(argText.slice(semi + 1));
    const v3 = (v3raw + anim.animTrackBase) | 0;
    if (anim.animTrackHighest < v3) anim.animTrackHighest = v3;
    if (v2 === 0) {
      t.enabled = 0;
      animPlayer.animPlayerError = 2;
    } else {
      t.enabled = 1;
      if (0x7f < v2) t.flags |= 1;
    }
    t.baseFrameTicks = v1;
    t.track = (v3 >= 0 ? anim.animTracks[v3] : null) ?? null;
    if (v3 < 0 || v3 >= anim.animTracks.length) divergence('anim_player_step: a track index outside animTracks reads past the table in the original; the port binds no track', 'anim_player_step');
    t.frame = -1;
    t.frameTimeLeft = 0;
    t.valueLeft = 0;
    t.lastTick = tick;
    t.entity!.animFrameTicks = v1;
    t.entity!.animState = -1;
  } else {
    divergence('anim_player_step: an anim task with no ";" leaves frame, times and lastTick as static_malloc left them; the port has them 0', 'anim_player_step');
  }
  const id = projectMangleId(atoi(head));
  const rec = projectDetailFind(id);
  let node: SceneNode | null = null;
  if (rec !== -1) node = detailRecordNode(rec);
  else {
    const obj = projectObjectFind(id);
    if (obj) node = objectGetNode(obj);
  }
  t.node = node;
  if (!t.node) animPlayer.animPlayerError = 3;
  return 1;
}

function tickTask(tick: number): number {
  const t = taskGlobals.currentTask?.data as AnimTask | null | undefined;
  if (!t) return 0;
  if (!t.node) return 0;
  const e = t.entity;
  if (!e) {
    animPlayer.animPlayerError = 5;
    return 0;
  }
  if (t.enabled === 0) {
    animPlayer.animPlayerError = 4;
    return 0;
  }
  const elapsed = (tick - t.lastTick) | 0;
  t.lastTick = tick;
  if ((e.motionFlags & 1) === 0) {
    if ((t.flags & 1) === 0) return 1;
    if (e.animTarget !== -1 || e.animState !== -1) {
      e.motionFlags = (e.motionFlags | 1) & 0xff;
      e.animFrameTicks = animScaleByGait(e.gaitBand, t.baseFrameTicks);
    }
    return 1;
  }
  if (t.baseFrameTicks === 0) {
    animPlayer.animPlayerError = 6;
    return 0;
  }
  if (e.animFrameTicks === 0) {
    animPlayer.animPlayerError = 7;
    return 0;
  }
  const track = t.track as AnimTrackLive | null;
  if (!track) {
    divergence('anim_player_step: a task with no track dereferences 0 in the original; the port stops the task', 'anim_player_step');
    return 0;
  }
  // this tick's share of what is left of the frame's value, never past it
  let step = t.frameTimeLeft < 1 ? t.valueLeft : ((Math.imul(elapsed, t.valueLeft) / t.frameTimeLeft) | 0);
  const left = t.valueLeft;
  if (left < 0 ? step < left : step > left) step = left;
  const ch = track.channel | 0;
  if (ch < 3) {
    // unsigned routing: a negative channel moves nothing
    const u = ch >>> 0;
    sceneNodeTranslate(t.node, u === 0 ? step : 0, u === 1 ? step : 0, u === 2 ? step : 0);
  } else {
    sceneNodeRotateEuler(t.node, ch === 3 ? step : 0, ch === 4 ? step : 0, ch === 5 ? step : 0, 0);
  }
  sceneNodeWalk(t.node);
  t.valueLeft = (t.valueLeft - step) | 0;
  t.frameTimeLeft = (t.frameTimeLeft - elapsed) | 0;
  if (t.frame === -1) {
    t.frame = 0;
    t.frameTimeLeft = 0;
    e.animState = 0;
  }
  if (0 < t.frameTimeLeft) return 1;

  // the frame is over: advance, then let the frame just finished redirect
  const old = t.frame;
  t.frame = (old + 1) | 0;
  t.frameTimeLeft = (t.frameTimeLeft + e.animFrameTicks) | 0;
  if (t.frameTimeLeft < -e.animFrameTicks) t.frameTimeLeft = -e.animFrameTicks | 0;
  const f = frameAt(track, old);
  let cond = 0;
  let target = 0;
  if (f.flags & 0x40) {
    target = arg(f, 1);
    cond = e.animTarget === target ? 1 : 0;
  }
  if (f.flags & 0x80) {
    target = arg(f, 1);
    cond |= e.animTarget !== -1 && e.animTarget !== e.animState ? 1 : 0;
  }
  if (f.flags2 & 1) {
    target = arg(f, 2);
    cond |= e.animTarget === -1 ? 1 : 0;
  }
  if (cond) {
    // TRANSITION: find the target's label toward it, then its entry point for the current state
    cond = 0;
    const dir = e.animState < target ? 1 : -1;
    let i = old;
    for (;;) {
      i = (i + dir) | 0;
      if (track.frameCount <= i) i = -1;
      if (i === -1) break;
      const g = frameAt(track, i);
      if (g.flags & 1 && arg(g, 0) === target) break;
    }
    if (i !== -1) {
      for (let found = false; !found; ) {
        if (i < track.frameCount) {
          const g = frameAt(track, i);
          if (g.flags2 & 2 && arg(g, 3) === e.animState) found = true;
          // QUIRK (0x1af9a): the index steps on past the entry frame it found
          i = (i + 1) | 0;
        } else {
          i = -1;
          found = true;
        }
      }
    }
    if (i !== -1) {
      quirk('anim_player_step: a transition lands one frame past the entry frame it finds', 'anim_player_step');
      t.frame = i;
      cond = 1;
    }
  }
  if (cond === 0 && f.flags & 0xc) {
    // LOOP: unconditional (0x08), or (0x04) unless animTarget is one of args[0..3]
    let back = true;
    if (f.flags & 4) {
      back = false;
      for (let j = 0; j < 4; j++) {
        const a = arg(f, j);
        if (a === -1) break;
        back = a === ((e.animTarget << 24) >> 24);
        if (back) break;
      }
    }
    if (back) {
      let i = old - 1;
      // frames[-1] is read before the index is tested (a byte before the table); either way the loop ends at -1
      while ((frameAt(track, i).flags & 2) === 0 && i >= 0) i--;
      t.frame = i;
    }
  }
  if ((cond === 0 && frameAt(track, old).flags2 & 4) || track.frameCount <= t.frame) {
    t.frameTimeLeft = 0;
    t.frame = -1;
  }
  if (t.frame !== -1) t.valueLeft = (t.valueLeft + (track.values as Int32Array)[t.frame]!) | 0;
  if ((t.flags & 1) === 0) return 1;
  if (cond) e.animState = target;
  e.motionFlags &= 0xfd;
  e.motionFlags &= 0xf7;
  if (t.frame === -1) {
    if (e.animTarget !== -1) return 1;
    e.motionFlags &= 0xfe;
    e.animState = e.animTarget;
    return 1;
  }
  e.animFrameTicks = animScaleByGait(e.gaitBand, t.baseFrameTicks);
  const g = frameAt(track, t.frame);
  if (g.flags & 0x10) e.motionFlags |= 2;
  if (g.flags2 & 8) e.motionFlags |= 8;
  return 1;
}

/**
 * The TSK anim task (type 3). INIT (message 0) binds the task: its argument
 * is "<object id>;<frame ticks>,<role>,<track>". TICK (1) plays one step of
 * its track on its node and, when a frame ends, walks the frame table: the
 * frame's transition, loop and end flags decide the next frame. Any other
 * message (DESTROY, REBUILT) returns 1.
 *
 * @mw2 anim_player_step 0x0001aad0
 * @fidelity exact
 * @divergence the task record is a JS object (static_malloc(0x28) in the original); a missing track or an out-of-range track index stops the task instead of reading stray memory
 */
export const animPlayerStep = registerCode('anim_player_step', 0x1aad0, (mode: number, argText: unknown, tick: number): number => {
  const m = mode >>> 0;
  if (m === 0) return initTask(typeof argText === 'string' ? argText : '', tick | 0);
  if (m === 1) return tickTask(tick | 0);
  return 1;
});

/**
 * animTarget = -1, gaitBand = 0.
 *
 * @mw2 mech_anim_clear_request 0x0001f490
 * @fidelity exact
 */
export function mechAnimClearRequest(e: MechEntity): void {
  e.gaitBand = 0;
  e.animTarget = -1;
}

/**
 * 0x95b04: the transition sound table - [1] the sound for settling into
 * walk from walking backwards, [5 + state * 4 + target] the sound for going
 * from one state to another (-1: none). Read from the image.
 */
function transitionSound(index: number): number {
  return imageI32(0x95b04 + index * 4, -1);
}

/**
 * Plays the sound for a change of animation state, once per change
 * (mechLastAnimState).
 *
 * QUIRK: called with no position vector (the step sound did not play), the
 * original writes the viewer-relative vector through the null pointer
 * (address 0, harmless under DOS/4GW) and then plays from it - the same
 * vector either way.
 *
 * @mw2 mech_play_anim_transition_sound 0x0001f630
 * @fidelity partial
 * @divergence sound_play_at is Phase 7: the sound is chosen and the bookkeeping kept, but nothing plays
 */
export function mechPlayAnimTransitionSound(e: MechEntity): void {
  const last = animPlayer.mechLastAnimState;
  const i = e.index;
  const prev = last[i]!;
  const fire = (e.animTarget !== e.animState && e.animState !== prev) || (e.animState === e.animTarget && prev !== -2);
  if (!fire) return;
  const id = e.animState === 0 && prev === 2 ? transitionSound(1) : transitionSound(5 + e.animState * 4 + e.animTarget);
  if (id !== -1) divergence('mech_play_anim_transition_sound: sound_play_at is Phase 7; the transition sound does not play', 'mech_play_anim_transition_sound');
  last[i] = e.animState === e.animTarget ? -2 : e.animState;
}

/**
 * Picks the movement animation from the throttle ramp (loadout
 * ramps[4].current, 0x400 = stopped): above 0x420, gaitBand 1 (under
 * 0x500), 2 (under 0x700) or 3, with animTarget 0 (walk) or, in band 3, 1
 * (run); band 3 is capped to 2 while walking backwards; reverseDirection
 * makes the target 2 (backwards). Gamepiece class 4 jumps straight to the
 * target. Then the step sound and, for the player, the transition sound.
 *
 * @mw2 mech_anim_select_gait 0x0001f4f0
 * @fidelity partial
 * @divergence sound_play_at is Phase 7: the step sound's flag is consumed but nothing plays
 */
export function mechAnimSelectGait(e: MechEntity): void {
  const v0 = e.loadout!.ramps[4]!.current;
  if (v0 < 0x421) {
    e.animTarget = -1;
    e.gaitBand = 0;
  } else {
    let v = (v0 - 0x400) | 0;
    if (v < 0) v = 0;
    e.animTarget = 0;
    if (v < 0x100) e.gaitBand = 1;
    else if (v < 0x300) e.gaitBand = 2;
    else {
      e.gaitBand = 3;
      e.animTarget = 1;
    }
    if (e.animState === 2 && 2 < e.gaitBand >>> 0) e.gaitBand = 2;
    if (e.control!.reverseDirection !== 0) e.animTarget = 2;
    if (e.gamepieceClass === 4) e.animState = e.animTarget;
  }
  if (e.animSoundId !== -1 && e.motionFlags & 8) {
    e.motionFlags &= 0xf7;
    divergence('mech_anim_select_gait: sound_play_at is Phase 7; the step sound does not play', 'mech_anim_select_gait');
  }
  if (mechs.playerMechIndex === e.index) mechPlayAnimTransitionSound(e);
}
