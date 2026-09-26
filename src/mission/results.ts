/**
 * The mission's objective evaluation, every frame from main: each group's
 * objectives step from pending (3) to Successful (5) or Failed (6) - 8 for a
 * protect objective another group has started to lose - each table's result
 * is decided from its required objectives, and each group's current
 * objective (the first live one without a high type word) re-tasks its AI
 * when it changes (group_objective_changed). The per-type rules are the
 * upstream note on objective_evaluate's; this file follows the disassembly
 * (0x16720..0x16e71), which the decompiled C garbles in places.
 *
 * Tables are per group; objectives[i] is 0xf7 bytes at objectiveTables +
 * group * 0x2e8a + 0x3a + i * 0xf7.
 */
import { LABEL } from '../generated/labels.gen.ts';
import type { ObjectiveTarget } from '../generated/classes.gen.ts';
import { cdiv } from '../core/int/cint.ts';
import { clock } from '../engine/clock.ts';
import { registerGlobals } from '../engine/globals.ts';
import { imageI32 } from '../engine/image.ts';
import { idByName } from '../engine/resources/cache.ts';
import { trackedGlobals } from '../sim/ai/tracked.ts';
import { messagePost } from '../sim/cockpit/messages.ts';
import { groupObjectiveChanged } from '../sim/groups/orders.ts';
import { mechs } from '../sim/mech/mechGlobals.ts';
import { mechRuntime } from '../sim/mech/mechRuntime.ts';
import { soundPlay, voice, voiceQueueAnnouncement, voiceQueueClose } from '../sim/sound/sound.ts';
import { things } from '../sim/things/gameThings.ts';
import { ui } from '../sim/ui/uiContext.ts';
import { commandGlobals } from '../sim/ui/commands.ts';
import { worldObjectGetPos } from '../sim/world/worldRecords.ts';
import { missionClock } from './missionClock.ts';
import { OBJECTIVES_MAX, objectives } from './objectives.ts';
import { missionTables } from './tables/missionTables.ts';

function bootResults() {
  return {
    /** 0xa5690: int[48], per objective record: its outcome has been announced (the player's table only) */
    objectiveAnnounced: new Int32Array(OBJECTIVES_MAX),
    /** 0x9589c: the win cheat - every undecided table succeeds */
    cheatWinMission: imageI32(LABEL.cheatWinMission, 0),
  };
}

export const results = registerGlobals('results', bootResults(), () => {
  Object.assign(results, bootResults());
});

// --- the target tests ------------------------------------------------------------

/**
 * A mech (2) or gamething (4) target with any of flags 0xe - destroyed or
 * gone; a nav point (1) never is.
 *
 * @mw2 objective_target_destroyed 0x00016030
 * @fidelity exact
 */
export function objectiveTargetDestroyed(t: ObjectiveTarget): number {
  if (t.kind === 2) return mechs.mechTable[t.index & 0xff]!.flags & 0xe;
  if (t.kind === 4) return things.gameThings[t.index & 0xff]!.flags & 0xe;
  return 0;
}

/**
 * A target with flags 0x20 (identified). The group's seenByGroups bit is
 * ORed rather than ANDed with the mask, so it never matters: a target
 * identified by any group counts for every group.
 *
 * @mw2 objective_target_identified 0x000160a0
 * @fidelity exact
 */
export function objectiveTargetIdentified(t: ObjectiveTarget, _group: number): number {
  const i = t.index & 0xff;
  if (t.kind === 1) return (trackedGlobals.trackedObjects[i]!.flags & 0x20) !== 0 ? 1 : 0;
  if (t.kind === 2) return (mechs.mechTable[i]!.flags & 0x20) !== 0 ? 1 : 0;
  if (t.kind === 4) return (things.gameThings[i]!.flags & 0x20) !== 0 ? 1 : 0;
  return 0;
}

/** squared distance as the unsigned 64-bit compare `<= r * r` the original makes. @portOnly */
function within(dx: number, dy: number, dz: number, r2: bigint): boolean {
  const d2 = BigInt(dx | 0) ** 2n + BigInt(dy | 0) ** 2n + BigInt(dz | 0) ** 2n;
  return d2 <= r2;
}

/**
 * The group's leader within reach of the target: 20000 of a mech or
 * gamething, a nav point's own range (20000 when not positive). The
 * player's leader reaching an unidentified nav point while its flags carry
 * 0x2000 identifies it (flags 0x20, seenByGroups, sound 0xe7).
 *
 * @mw2 objective_target_reached 0x00016190
 * @fidelity exact
 */
export function objectiveTargetReached(t: ObjectiveTarget, group: number): number {
  const li = mechs.groupTable[group]!.leaderMechIndex;
  if (li < 0) return 0;
  const L = mechs.mechTable[li]!;
  const i = t.index & 0xff;
  if (t.kind === 1) {
    const o = trackedGlobals.trackedObjects[i]!;
    let r = o.range;
    if (r < 1) r = 20000;
    if (!within((L.posX - o.x) | 0, (L.posY - o.y) | 0, (L.posZ - o.z) | 0, BigInt(r) ** 2n)) return 0;
    if (mechs.playerMechIndex === li && ((L.flags >> 8) & 0x20) !== 0 && (o.flags & 0x20) === 0 && o.inUse !== 0) {
      o.flags = (o.flags | 0x20) & 0xffff;
      o.seenByGroups = (o.seenByGroups | (1 << (L.groupId & 0x1f))) & 0xffff;
      soundPlay(0xe7, 100, 0x40, 5, 0x50);
    }
    return 1;
  }
  if (t.kind === 2) {
    const m = mechs.mechTable[i]!;
    return within((L.posX - m.posX) | 0, (L.posY - m.posY) | 0, (L.posZ - m.posZ) | 0, 400000000n) ? 1 : 0;
  }
  if (t.kind === 4) {
    const [x, y, z] = worldObjectGetPos(things.gameThings[i]!.geomIndex);
    return within((L.posX - x) | 0, (L.posY - y) | 0, (L.posZ - z) | 0, 400000000n) ? 1 : 0;
  }
  return 0;
}

// --- announcements -------------------------------------------------------------------

/**
 * Collapses each run of whitespace after a character to one space, in place
 * (the ctype table at 0x952c8, bit 2: tab, LF, VT, FF, CR, space).
 *
 * @mw2 game_boot_sub_015f00 0x00015f00
 * @fidelity exact
 */
export function gameBootSub015f00(s: string): string {
  const space = (c: string) => c === ' ' || (c >= '\t' && c <= '\r');
  let out = '';
  let i = 0;
  while (i < s.length) {
    out += s[i]!;
    i++;
    if (i < s.length && space(s[i]!)) {
      while (i < s.length && space(s[i]!)) i++;
      out += ' ';
    }
  }
  return out;
}

/**
 * Loads '<name>.sfl' from the development directory when one was scanned.
 *
 * @mw2 dev_dir_load_sfl 0x0001a9b0
 * @fidelity partial
 * @divergence no development ('keating') directory exists for the port, as none ships with the game: always null, which is what the shipped game gets
 */
export function devDirLoadSfl(_name: string): Uint8Array | null {
  return null;
}

/**
 * Announces an objective's outcome for the player's group, once per record:
 * '<text> successful' with its success sound (state 5) or '<text> failed'
 * with its failure sound (6), shown only when the objective is listed and
 * its text does not begin with a space; whitespace collapsed; queued as a
 * sound message (0x50).
 *
 * @mw2 mission_result_format 0x00016400
 * @fidelity exact
 */
export function missionResultFormat(table: number, record: number, state: number): number {
  if (table !== mechs.playerGroupIndex) return 1;
  if (results.objectiveAnnounced[record] !== 0) return 1;
  const o = objectives.objectiveTables[table]!.objectives[record]!;
  let text = '';
  let sound = 0;
  let sfl: Uint8Array | null = null;
  if (state === 5) {
    text = `${o.text} successful`;
    sound = o.successSound;
    sfl = devDirLoadSfl(o.successSoundName);
  } else if (state === 6) {
    text = `${o.text} failed`;
    sound = o.failureSound;
    sfl = devDirLoadSfl(o.failureSoundName);
  }
  const shown = text[0] === ' ' || o.listed === 0 ? '' : text;
  voiceQueueAnnouncement({ soundId: sound, text: gameBootSub015f00(shown), buffer: sfl });
  results.objectiveAnnounced[record] = 1;
  return 1;
}

/**
 * The player's table's result announced: 'Mission successful' (2) or
 * 'Mission failed' (3) with the table's sound, 'Mission time exceeded' (4)
 * with BET68.
 *
 * @mw2 mission_result_text 0x000164f0
 * @fidelity exact
 */
export function missionResultText(table: number, result: number): number {
  if (table !== mechs.playerGroupIndex) return 1;
  const t = objectives.objectiveTables[table]!;
  let text: string;
  let sound: number;
  let sfl: Uint8Array | null;
  if (result === 2) {
    text = 'Mission successful';
    sound = t.successSound;
    sfl = devDirLoadSfl(t.successSoundName);
  } else if (result === 3) {
    text = 'Mission failed';
    sound = t.failureSound;
    sfl = devDirLoadSfl(t.failureSoundName);
  } else if (result === 4) {
    text = 'Mission time exceeded';
    sound = idByName(0xb, 'BET68');
    sfl = devDirLoadSfl('BET68');
  } else {
    // the C queues its uninitialised stack block here; no caller passes another result
    return 1;
  }
  voiceQueueAnnouncement({ soundId: sound, text, buffer: sfl });
  return 1;
}

// --- evaluation -------------------------------------------------------------------------

/**
 * Prerequisite i of an objective is met: its named objective is complete
 * (code 1 'C': state 5 or 6), successful (2 'S': 5) or failed (3 'F': 6).
 *
 * @mw2 objective_prereq_met 0x000165b0
 * @fidelity exact
 */
export function objectivePrereqMet(table: number, record: number, i: number): number {
  const p = objectives.objectiveTables[table]!.objectives[record]!.prerequisites[i]!;
  const s = objectives.objectiveTables[p.table]!.objectives[p.objective]!.state & 0xff;
  if (p.condition === 1 && (s === 5 || s === 6)) return 1;
  if (p.condition === 2 && s === 5) return 1;
  if (p.condition === 3 && s === 6) return 1;
  return 0;
}

/**
 * Live: not yet Successful or Failed, and either the start type (0x10) or
 * its prerequisites met - any one (prereqAll 0) or all, up to the first
 * empty entry.
 *
 * @mw2 objective_is_active 0x00016650
 * @fidelity exact
 */
export function objectiveIsActive(table: number, record: number): number {
  const o = objectives.objectiveTables[table]!.objectives[record]!;
  if (o.state === 5 || o.state === 6) return 0;
  if (o.type >>> 0 === 0x10) return 1;
  let all = 1;
  for (let i = 0; i < 8; i++) {
    if (o.prerequisites[i]!.condition === 0) break;
    const met = objectivePrereqMet(table, record, i);
    if (o.prereqAll === 0) {
      if (met !== 0) return 1;
    } else {
      all &= met;
      if (all === 0) return 0;
    }
  }
  return o.prereqAll !== 0 ? 1 : 0;
}

/**
 * Steps one objective (see the file note): finished or not live, it is
 * marked not started; otherwise its start is stamped, its type's condition
 * taken over the targets - destroy (1, 2) all destroyed, protect (4) none
 * and all destroyed, identify (8) all identified, identify+req (0x20) all
 * identified and every other required objective successful, reach (0x100)
 * all reached by the leader (for another group, only while it is the
 * group's current objective), avoid (0x2000) none reached - with an empty
 * target list meeting the condition; then the time limit, and the new state
 * by type: timers (0, 0x200, 0x400, 0x800) succeed when the limit runs out;
 * protect as the note says; WIN (0x10000) / LOSE (0x20000) decide another
 * table; toggle listed (0x40000), force fail (0x80000) and force succeed
 * (0x100000) act on another objective and succeed; every other type
 * succeeds on its condition, fails on the limit.
 *
 * @mw2 objective_evaluate 0x00016720
 * @fidelity exact
 */
export function objectiveEvaluate(table: number, record: number): void {
  const T = objectives.objectiveTables[table]!;
  const o = T.objectives[record]!;
  let state = 3;
  let cond = true;
  let allDestroyed = true;
  if (o.state === 5 || o.state === 6 || objectiveIsActive(table, record) === 0) {
    o.started = 0;
    return;
  }
  const secs = missionClock.missionSeconds;
  if (o.startedAt === -1) {
    o.started = 1;
    o.startedAt = secs;
  }
  const type = o.type >>> 0;
  const n = o.targetCount & 0xff;
  if (type === 1 || type === 2) {
    for (let i = 0; i < n; i++) cond = cond && objectiveTargetDestroyed(o.targets[i]!) !== 0;
  } else if (type === 4) {
    for (let i = 0; i < n; i++) {
      const d = objectiveTargetDestroyed(o.targets[i]!);
      cond = cond && d === 0;
      allDestroyed = allDestroyed && d !== 0;
    }
  } else if (type === 8) {
    for (let i = 0; i < n; i++) cond = cond && objectiveTargetIdentified(o.targets[i]!, table) !== 0;
  } else if (type === 0x20) {
    for (let i = 0; i < n; i++) cond = cond && objectiveTargetIdentified(o.targets[i]!, table) !== 0;
    for (let k = 0; k < T.count; k++) if (T.objectives[k]!.isPrerequisite !== 0 && record !== k) cond = cond && (T.objectives[k]!.state & 0xff) === 5;
  } else if (type === 0x100) {
    if (table !== mechs.playerGroupIndex) cond = cond && record === objectives.groupCurrentObjective[table];
    for (let i = 0; i < n; i++) cond = cond && objectiveTargetReached(o.targets[i]!, table) !== 0;
  } else if (type === 0x2000) {
    for (let i = 0; i < n; i++) cond = cond && objectiveTargetReached(o.targets[i]!, table) === 0;
  }
  const limitReached = !(o.timeLimit < 0 || o.startedAt < 0) && o.timeLimit < ((missionClock.missionSeconds - o.startedAt) | 0);
  let announce = -1; // mission_result_format(table, record, announce) at 0x16e4c
  const tables = missionTables.missionTableCount;
  const at = (o.actionTable << 16) >> 16;
  const other = () => {
    const t = objectives.objectiveTables[at];
    if (!t) throw new Error(`objective_evaluate: action table ${at} lies outside objectiveTables`);
    return t;
  };
  const ao = (o.actionObjective << 16) >> 16;
  if (type === 0 || type === 0x200 || type === 0x400 || type === 0x800) {
    if (limitReached) state = announce = 5;
  } else if (type === 4) {
    if (limitReached) {
      if (cond) state = announce = 5;
      else state = 6;
    } else {
      if (!cond) {
        state = table === mechs.playerGroupIndex ? 6 : 8;
        missionResultFormat(table, record, 6);
      }
      if (allDestroyed) state = 6;
    }
  } else if (type === 0x10000 || type === 0x20000) {
    // the bound is > count, so actionTable == missionTableCount passes
    if (tables < at) return finish(o, state);
    const t = other();
    t.result = type === 0x10000 ? 2 : 3;
    missionResultText(at, t.result);
    state = 5;
    t.decidedAt = missionClock.missionSeconds;
    announce = 5;
  } else if (type === 0x40000) {
    if (tables < at || other().count < ao) return finish(o, state);
    const x = other().objectives[ao]!;
    x.listed = x.listed === 0 ? 1 : 0;
    state = announce = 5;
  } else if (type === 0x80000 || type === 0x100000) {
    if (tables < at || other().count < ao) return finish(o, state);
    const x = other().objectives[ao]!;
    if (x.state === 6 || x.state === 5) return finish(o, state);
    x.state = type === 0x80000 ? 6 : 5;
    x.changedAt = secs;
    missionResultFormat(at, ao, x.state);
    state = announce = 5;
  } else if (cond) state = announce = 5;
  else if (limitReached) state = announce = 6;
  if (announce !== -1) missionResultFormat(table, record, announce);
  finish(o, state);
}

/** 0x16e53: the state stored, and the change time stamped unless still pending. @portOnly */
function finish(o: { state: number; changedAt: number }, state: number): void {
  o.state = state;
  if (state !== 3) o.changedAt = missionClock.missionSeconds;
}

/**
 * Every frame: missionSeconds, then per table - evaluate every objective;
 * while undecided, decide from the required (M) objectives: all Successful
 * (or the win cheat) 2, any Failed (6 or 8) 3, the table's time limit run
 * out 4, the player out (its own table) 3 - announced, the time stamped;
 * once decided, for the player's table (unless hangAround), 'Press any key
 * to exit...' after 3 s and the quit request after 20, while no sound
 * message plays; then the current objective - the first live one whose
 * type has no high word, or -1 - re-tasking the group when it changes.
 *
 * @mw2 mission_results_update 0x00016e80
 * @fidelity exact
 */
export function missionResultsUpdate(): void {
  missionClock.missionSeconds = cdiv(clock.simTick | 0, 0xb6);
  for (let table = 0; table < missionTables.missionTableCount; table++) {
    const T = objectives.objectiveTables[table]!;
    for (let k = 0; k < T.count; k++) objectiveEvaluate(table, k);
    if (T.result === 0) {
      let allOk = true;
      let failed = false;
      for (let k = 0; k < T.count; k++) {
        const o = T.objectives[k]!;
        if (o.isPrerequisite === 0) continue;
        const s = o.state & 0xff;
        if (s === 5) continue;
        allOk = false;
        if (s === 6 || s === 8) failed = true;
      }
      let decided = true;
      if (allOk || results.cheatWinMission !== 0) T.result = 2;
      else if (failed) T.result = 3;
      else if (0 < T.timeLimit && T.timeLimit <= ((missionClock.missionSeconds - T.startTime) | 0)) T.result = 4;
      else if (mechRuntime.playerOut !== 0 && table === mechs.playerGroupIndex) T.result = 3;
      else decided = false;
      if (decided) {
        missionResultText(table, T.result);
        T.decidedAt = missionClock.missionSeconds;
      }
    } else if (table === mechs.playerGroupIndex && commandGlobals.hangAround === 0) {
      voiceQueueClose(1);
      const since = (missionClock.missionSeconds - T.decidedAt) | 0;
      if (voice.voiceQueueHead === null) {
        if (ui.exitPromptShown === 0 && 3 < since) {
          messagePost('Press any key to exit...', 1, 0x1554, 100);
          ui.exitPromptShown = 1;
        } else if (0x14 < since) {
          ui.quitCountdown = (ui.quitCountdown + 2) | 0;
          ui.quitRequested = 1;
        }
      }
    }
    let current = -1;
    for (let k = 0; k < T.count; k++) {
      if (objectiveIsActive(table, k) !== 0 && (T.objectives[k]!.type >>> 16) === 0) {
        current = k;
        break;
      }
    }
    if (current !== objectives.groupCurrentObjective[table]) {
      objectives.groupCurrentObjective[table] = current;
      groupObjectiveChanged(table);
    }
  }
}
