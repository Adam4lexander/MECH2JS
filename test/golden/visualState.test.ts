// The mission VM's visual and misc state (contract section C), driven by the
// real MW2.PRJ / MW2.EXE and checked against the decompilation's listings and
// against the C read field by field.
//
// Correspondence, not counts: the 3dbitmap test prints the PORT'S TABLES in
// listing/bitmap3d.txt's format and compares line by line, so a slot bound to
// the wrong block, a frame appended to its neighbour's block or a period on
// the wrong slot changes a line. The loader tests compare every stored value
// with an independent decode of the same bytes.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { Chunk } from '../../src/data/bwd/stream.ts';
import { parseAnim } from '../../src/data/formats/anim.ts';
import { LABEL } from '../../src/generated/labels.gen.ts';
import { MeshBlock, MeshVertex, Projectile, SceneNode, SimSlot, WorldObject, MechEntity } from '../../src/generated/classes.gen.ts';
import { resetAllGlobals } from '../../src/engine/globals.ts';
import { setBootImage } from '../../src/engine/image.ts';
import { clock } from '../../src/engine/clock.ts';
import { idByName, setMainProject } from '../../src/engine/resources/cache.ts';
import { bitmap3d, bitmap3dAddFrame, bitmap3dAnimate, bitmap3dReset, bitmap3dSetEnable, bitmap3dSetId, bitmap3dSetSec, bitmap3dSetFrame } from '../../src/sim/world/bitmap3d.ts';
import { palettes, paletteSlotSetResource, paletteStartFade, paletteFadeStep, paletteApplyPending } from '../../src/sim/world/palettes.ts';
import { lighting } from '../../src/sim/world/environment.ts';
import { dayCycle, dayCycleInit, dayCycleTick } from '../../src/sim/world/dayCycle.ts';
import { frameProj, framePrjAdd } from '../../src/sim/world/framePrj.ts';
import { anim2d, anim2dAdd } from '../../src/sim/world/anim2d.ts';
import { scrounge, scroungeInstall } from '../../src/sim/world/scrounge.ts';
import { simTables, simTablesReset, PROJECTILE_COUNT, SIM_SLOT_COUNT } from '../../src/sim/effects/simTables.ts';
import { trackedGlobals, trackedObjectCreate, trackedObjectRemove } from '../../src/sim/ai/tracked.ts';
import { anim, animEnsureLoaded } from '../../src/sim/mech/anim.ts';
import { cockpit, resLoadCockpit, resLoadHdi } from '../../src/sim/cockpit/resources.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { planet } from '../../src/sim/world/planet.ts';
import { gameSource, hasDecompiled, hasGameData, readListing } from '../support/env.ts';
import { diffLines, lines, padL } from '../support/listing.ts';
import { namedStreams, type NamedStream, pyFixed, resourceNames } from '../support/bwdHelpers.ts';

const BITMAP_TAGS = new Set(['BMPJ', 'BMID', 'BSEC', 'BMEN']);

/**
 * project_chunk_exec's four 3dbitmap branches (sim_objects.c, 0x4e5d0),
 * transcribed here because the interpreter depends on files other work owns.
 * Returns the slot a BMID/BSEC/BMEN touched, for the listing's slot order.
 */
function execBitmapChunk(c: Chunk): number | null {
  switch (c.tag) {
    case 'BMPJ': {
      let id = c.i16(8);
      if (id === -1) id = idByName(8, c.str(10));
      if (id !== -1) bitmap3dAddFrame(id, -1);
      return null;
    }
    case 'BMID':
      bitmap3dSetId(c.i16(8), -1);
      return c.i16(8);
    case 'BSEC':
      bitmap3dSetSec(c.i16(8), c.i16(10));
      bitmap3dSetEnable(c.i16(8), 1);
      return c.i16(8);
    case 'BMEN':
      bitmap3dSetEnable(c.i16(8), c.i16(10));
      return c.i16(8);
  }
  return null;
}

function chunkOf(tag: string, payload: number[]): Chunk {
  const bytes = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) bytes[i] = i < tag.length ? tag.charCodeAt(i) : 0;
  new DataView(bytes.buffer).setUint32(4, bytes.length, true);
  bytes.set(payload, 8);
  return new Chunk(bytes, tag, bytes.length, 0);
}
const le16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];

describe.runIf(hasGameData && hasDecompiled)('mission VM visual state (contract C)', () => {
  let prj: ProjectFile;
  let exe: ExeImage;
  let streams: NamedStream[];

  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    setMainProject(prj);
    setBootImage(exe);
    streams = namedStreams(prj);
  });
  beforeEach(() => resetAllGlobals());

  it('bitmap3d.txt: every stream replayed through the ported 3dbitmap functions', () => {
    const cnames = resourceNames(prj, 'CEL');
    const MODES = new Map<number, string>([[0, 'stopped'], [2, 'once']]);
    const out: string[] = [];
    let replayed = 0;
    for (const s of streams) {
      const chunks = s.chunks.filter((c) => BITMAP_TAGS.has(c.tag));
      if (!chunks.length) continue;
      replayed++;
      resetAllGlobals(); // each stream from the image's state: bitmap3dNeedsReset -2
      const order: number[] = [];
      for (const c of chunks) {
        const slot = execBitmapChunk(c);
        if (slot !== null && !order.includes(slot)) order.push(slot);
      }
      const b = bitmap3d;
      const blocks = b.bitmap3dFrames.filter((blk) => blk[0]!.celId >= 1).length;
      out.push(`${s.name} (BWD ${s.rid})  ${order.length} slots, ${blocks} frame blocks`);
      for (const slot of order) {
        const st = b.bitmap3dTable[slot]!;
        const bound = st.state !== -2;
        const frames: string[] = [];
        if (bound) {
          for (const f of b.bitmap3dFrames[st.block]!) {
            if (f.celId < 1) break;
            frames.push(cnames.get(f.celId) ?? `?CEL ${f.celId}`);
          }
        }
        // the dump says 'unset' where no BSEC ran: the C then holds 0, or the
        // 0x2d set_id / set_enable default (no BSEC in MW2.PRJ uses 45)
        const period =
          st.ticksPerFrame === 0 || st.ticksPerFrame === 0x2d
            ? 'period unset (0x2d default when the slot is set up)'
            : `every ${st.ticksPerFrame} ticks (${pyFixed(st.ticksPerFrame / 182.0, 2)} s)`;
        out.push(
          `  slot ${padL(slot, 3)}  ${period}  mode ${st.playMode} ${MODES.get(st.playMode) ?? 'loop'}  ${padL(frames.length, 2)} frames: ` +
            (frames.length ? frames.join(' ') : bound ? '-' : 'NO BMID - not bound to a block'),
        );
      }
      out.push('');
    }
    const want = lines(readListing('bitmap3d.txt')).slice(7); // the seven header lines are dump totals
    const d = diffLines(want, out, 50);
    // The one expected difference: MW2_MAP2's slot 0 is set by BSEC with no
    // BMID. The dump gives it mode 1; in the C bitmap3d_set_enable refuses to
    // write playMode while the slot is still in bitmap3d_reset's -2 state, so
    // it stays 0 (the period IS written - set_sec has no such test).
    expect(d).toEqual([
      {
        line: 352,
        want: '  slot   0  every 18 ticks (0.10 s)  mode 1 loop   0 frames: NO BMID - not bound to a block',
        got: '  slot   0  every 18 ticks (0.10 s)  mode 0 stopped   0 frames: NO BMID - not bound to a block',
      },
    ]);
    expect(replayed).toBeGreaterThan(30);
  });

  it('bitmap3d_add_frame / set_id: blocks, the advance and the 0x2d default, per the C', () => {
    bitmap3dAddFrame(0, -1); // below 1: refused, but the lazy reset has run
    expect(bitmap3d.bitmap3dNeedsReset).toBe(0);
    expect(bitmap3d.bitmap3dTable[5]!.state).toBe(-2);
    expect(bitmap3dAddFrame(100, -1)).toBe(0); // first frame of block 0: flag 0
    expect(bitmap3d.dat00096cfc).toBe(0);
    expect(bitmap3dSetId(5, -1)).toBe(1);
    expect(bitmap3d.bitmap3dTable[5]!.ticksPerFrame).toBe(0); // one-frame block keeps its period
    expect(bitmap3dAddFrame(101, -1)).toBe(0); // advances to block 1
    expect(bitmap3dAddFrame(102, -1)).toBe(0); // second frame: flag 1
    expect(bitmap3d.dat00096cfc).toBe(1);
    expect(bitmap3dSetId(6, -1)).toBe(1);
    const s6 = bitmap3d.bitmap3dTable[6]!;
    expect([s6.block, s6.frame, s6.state, s6.playMode, s6.ticksPerFrame]).toEqual([1, 0, 1, 1, 0x2d]);
    expect(bitmap3d.bitmap3dFrames[0]!.slice(0, 2).map((f) => f.celId)).toEqual([100, -1]);
    expect(bitmap3d.bitmap3dFrames[1]!.slice(0, 3).map((f) => f.celId)).toEqual([101, 102, -1]);
    // a full block refuses the 33rd frame
    for (let i = 0; i < 32; i++) expect(bitmap3dAddFrame(200 + i, 9)).toBe(0);
    expect(bitmap3dAddFrame(300, 9)).toBe(-1);
    expect(bitmap3dSetId(0x200, 0)).toBe(0);
    expect(bitmap3dSetId(0, 0x200)).toBe(0);
  });

  it('bitmap3d_animate: whole periods, remainder kept, wrap at the first empty frame, play-once stops', () => {
    bitmap3dReset();
    for (const id of [11, 12, 13]) bitmap3dAddFrame(id, 0);
    bitmap3dSetId(3, 0); // block 0, mode 1, 0x2d (the flag is set)
    bitmap3dSetSec(3, 10);
    const s = bitmap3d.bitmap3dTable[3]!;
    // bitmap3d_reset leaves lastStepTick -1 and set_id does not touch it, so
    // the first step counts from tick -1: 1001 ticks, 100 frames of a 3-cycle
    clock.simTick = 1000;
    bitmap3dAnimate();
    expect([s.frame, s.lastStepTick]).toEqual([1, 999]);
    bitmap3dSetFrame(3, 0); // as effect_spawn rewinds: lastStepTick 0
    bitmap3dAnimate(); // stamps lastStepTick, 0 elapsed
    expect([s.frame, s.lastStepTick]).toEqual([0, 1000]);
    clock.simTick = 1025; // 2 periods, 5 left over
    bitmap3dAnimate();
    expect([s.frame, s.lastStepTick]).toEqual([2, 1020]);
    clock.simTick = 1030; // one more: frame 3 is empty, wraps to 0
    bitmap3dAnimate();
    expect([s.frame, s.lastStepTick]).toEqual([0, 1030]);
    bitmap3dSetEnable(3, 2); // play once
    clock.simTick = 1060; // 3 periods: 1, 2, 0 - ending on frame 0 is not below the start frame 0, so it plays on
    bitmap3dAnimate();
    expect([s.frame, s.playMode]).toEqual([0, 2]);
    clock.simTick = 1070; // 0 -> 1
    bitmap3dAnimate();
    expect([s.frame, s.playMode]).toEqual([1, 2]);
    clock.simTick = 1090; // 1 -> 2 -> 0: below 1, so it stops at frame 0
    bitmap3dAnimate();
    expect([s.frame, s.playMode]).toEqual([0, 0]);
    // set_frame: empty frame refused, 0x20 wraps to 0, lastStepTick zeroed
    s.lastStepTick = 77;
    bitmap3dSetFrame(3, 5);
    expect([s.frame, s.lastStepTick]).toEqual([0, 77]);
    bitmap3dSetFrame(3, 2);
    expect([s.frame, s.lastStepTick]).toEqual([2, 0]);
    bitmap3dSetFrame(3, 0x20);
    expect(s.frame).toBe(0);
  });

  it('PALG: slots 0..0x13 take the chunk shorts, and 0x11 is ZAPPED in every PALG', () => {
    const pal = resourceNames(prj, 'PAL');
    let n = 0;
    for (const s of streams) {
      for (const c of s.chunks) {
        if (c.tag !== 'PALG') continue;
        n++;
        resetAllGlobals();
        // project_chunk_exec's PALG branch
        for (let g = 0; g < 4; g++) {
          paletteSlotSetResource(c.i16(8 + g * 8), g * 4);
          paletteSlotSetResource(c.i16(10 + g * 8), g * 4 + 1);
          paletteSlotSetResource(c.i16(12 + g * 8), g * 4 + 2);
          paletteSlotSetResource(c.i16(14 + g * 8), g * 4 + 3);
        }
        paletteSlotSetResource(c.i16(0x28), 0x10);
        paletteSlotSetResource(c.i16(0x2a), 0x11);
        paletteSlotSetResource(c.i16(0x2c), 0x12);
        paletteSlotSetResource(c.i16(0x2e), 0x13);
        const ids = Array.from(palettes.paletteResourceIds);
        expect(ids).toEqual(Array.from({ length: 20 }, (_, k) => c.i16(8 + k * 2)));
        expect(pal.get(ids[0x11]!)).toMatch(/ZAP/i);
      }
    }
    expect(n).toBe(46);
  });

  it('palette_start_fade / fade_step: step counts and the return leg, per the C', () => {
    resetAllGlobals();
    for (let k = 0; k < 20; k++) palettes.paletteResourceIds[k] = 1 + k;
    palettes.paletteCurrentSlot = 0;
    clock.tickDelta = 4;
    // flash: half of 0x16c each way; (0xb6 << 16) / 4 >> 16 = 45 steps
    expect(paletteStartFade(0x11, 0x16c, 1)).toBe(1);
    expect([palettes.paletteFadeTarget, palettes.paletteFadeReturnTo, palettes.paletteFadeStepsLeft, palettes.paletteFadeReturnSteps]).toEqual([0x11, 0, 45, 45]);
    expect(paletteStartFade(4, 100, 1)).toBe(0); // a flash is refused while a fade runs
    for (let i = 0; i < 45; i++) paletteFadeStep();
    // the return leg: the first leg has just ended (stepsLeft 0), so it is a
    // mode-0 fade from the slot now on screen, 0x11, back to 0
    expect([palettes.paletteCurrentSlot, palettes.paletteFadeTarget, palettes.paletteFadeReturnTo, palettes.paletteFadeStepsLeft, palettes.paletteFadeReturnSteps]).toEqual([0x11, 0, 0x11, 11, 0]);
    // a mode-0 fade started while another runs restarts from its in-between colours (from -1)
    expect(paletteStartFade(4, 8, 0)).toBe(1);
    expect([palettes.paletteFadeTarget, palettes.paletteFadeReturnTo, palettes.paletteFadeStepsLeft]).toEqual([4, -1, 2]);
    expect(paletteStartFade(0, 45, 0)).toBe(1);
    for (let i = 0; i < 11; i++) paletteFadeStep();
    expect([palettes.paletteCurrentSlot, palettes.paletteRestorePending]).toEqual([0, 1]);
    palettes.paletteRestoreSlot = 8;
    paletteApplyPending();
    expect([palettes.paletteCurrentSlot, palettes.paletteRestorePending]).toEqual([8, 0]);
    clock.tickDelta = 0;
    expect(paletteStartFade(4, 100, 0)).toBe(1);
    expect(palettes.paletteFadeStepsLeft).toBe(0x14);
    clock.tickDelta = 1000; // (5 << 16) / 1000 < 0x10000: one step
    palettes.paletteFadeStepsLeft = 0;
    expect(paletteStartFade(4, 5, 2)).toBe(1);
    expect([palettes.paletteFadeStepsLeft, palettes.paletteFadeReturnSteps]).toEqual([1, 1]);
  });

  it('environment, palette, day-cycle and table globals boot to the image', () => {
    const i32 = (a: number) => exe.i32(a);
    const L = lighting;
    const expected: [string, number, number][] = [
      ['lumaTableId', L.lumaTableId, i32(0x96cf0)],
      ['lightDimDistance', L.lightDimDistance, i32(0x97064)],
      ['lightDimFlag', L.lightDimFlag, i32(0x9705c)],
      ['groundColour', L.groundColour, i32(0x96eac)],
      ['skyColour', L.skyColour, i32(0x96ea8)],
      ['horizonBandHeight', L.horizonBandHeight, i32(0x97088)],
      ['hrzmChunkValue', L.hrzmChunkValue, i32(0x96eb0)],
      ['climChunkValue', L.climChunkValue, i32(0x957b8)],
      ['missionMusicResource', L.missionMusicResource, i32(0xa5680)],
      ['timeOfDay', L.timeOfDay, i32(0x957c8)],
      ['dayOfYear', L.dayOfYear, i32(0x957c4)],
      ['daysPerYear', L.daysPerYear, i32(0x957c0)],
      ['dayLengthSeconds', L.dayLengthSeconds, i32(0x957bc)],
      ['ambientTemperature', L.ambientTemperature, i32(0x957d0)],
      ['ejectDisabled', L.ejectDisabled, i32(0x957d4)],
      ['damageShadeRaises', L.damageShadeRaises, i32(0x96ebc)],
      ['effectLightsAllowed', L.effectLightsAllowed, i32(0x9ee50)],
      ['skyEnabled', L.skyEnabled, i32(0x9703c)],
      ['groundEnabled', L.groundEnabled, i32(0x97040)],
      ['horizonBandEnabled', L.horizonBandEnabled, i32(0x97044)],
      ['jetClimbLimit', L.jetClimbLimit, i32(0x961e4)],
      ['mapHeightHigh', L.mapHeightHigh, i32(0x955bc)],
      ['mapHeightLow', L.mapHeightLow, i32(0x955b8)],
      ['slopeThreshold', L.slopeThreshold, i32(0x961e8)],
      ['lightObjectFlag', L.lightObjectFlag, i32(0x954fc)],
      ['lightObjectFollow', L.lightObjectFollow, i32(0x95500)],
      ['lightObjectRecord', L.lightObjectRecord, i32(0x95504)],
      ['paletteCurrentSlot', palettes.paletteCurrentSlot, i32(0x9709c)],
      ['paletteRestoreSlot', palettes.paletteRestoreSlot, i32(0x970a8)],
      ['paletteBaseSlot', palettes.paletteBaseSlot, i32(0x970a4)],
      ['paletteFadeStepsLeft', palettes.paletteFadeStepsLeft, i32(0x970b8)],
      ['bitmap3dNeedsReset', bitmap3d.bitmap3dNeedsReset, i32(0x96cec)],
      ['frameProjCount', frameProj.frameProjCount, i32(0x95518)],
      ['anim2dCount', anim2d.anim2dCount, i32(0x9552c)],
      ['projectileSlotFill', simTables.projectileSlotFill, i32(0x9ebb8)],
      ['xploSlotFill', simTables.xploSlotFill, i32(0x9ebbc)],
      ['trackedObjectCount', trackedGlobals.trackedObjectCount, i32(0x96288)],
      ['animTrackBase', anim.animTrackBase, i32(0x95a54)],
      ['animCacheCount', anim.animCacheCount, i32(0x95a58)],
      ['dayPhase', dayCycle.dayPhase, i32(0x957a8)],
      ['dayCycleEnabled', dayCycle.dayCycleEnabled, exe.u8(0xa55e8)],
      ['infraredOn', dayCycle.infraredOn, exe.u8(0xa55e9)],
      ['scroungeTileSize', scrounge.scroungeTileSize, i32(0x95aec)],
    ];
    for (const [name, got, want] of expected) expect({ name, got }).toEqual({ name, got: want });
    // the addresses above are typed out independently of the port's LABEL use; spot-check they agree
    expect(LABEL.lumaTableId).toBe(0x96cf0);
    expect(LABEL.xploSlotFill).toBe(0x9ebbc);
    expect(L.hiddenText).toBe(exe.cstrAt(0xfe100, 64));
    expect(L.missionMusicName).toBe(exe.cstrAt(0xa5684, 64));
    expect(L.viewportModes).toHaveLength(11);
    L.viewportModes.forEach((w, i) => {
      expect([w.left, w.top, w.right, w.bottom]).toEqual([1, 2, 3, 4].map((k) => i32(0x14fd30 + i * 0x14 + k * 4)));
    });
    expect(Array.from(dayCycle.dayPhasePaletteSlot)).toEqual([0, 1, 2, 3, 4].map((k) => i32(0x95788 + k * 8)));
    expect(Array.from(dayCycle.dayPhaseFadeTicks)).toEqual([0, 1, 2, 3, 4].map((k) => i32(0x9578c + k * 8)));
    expect(Array.from(palettes.paletteResourceIds)).toEqual(Array.from({ length: 20 }, (_, k) => i32(0x14fce0 + k * 4)));
    cockpit.dat000968e0.forEach((w, i) => {
      expect([w.left, w.top, w.right, w.bottom]).toEqual([1, 2, 3, 4].map((k) => i32(0x968e0 + i * 0x14 + k * 4)));
    });
  });

  it('sim_tables_reset writes exactly the fields the C writes', () => {
    // fill every field with a distinct non-zero value first, so a field the
    // port forgets to write - or writes when the C does not - shows
    const node = new SceneNode();
    simTables.projectiles.forEach((p, i) => {
      let k = 1;
      for (const f of Object.keys(p) as (keyof Projectile)[]) if (typeof p[f] === 'number') (p as unknown as Record<string, number>)[f] = i * 100 + k++;
      p.node = node;
    });
    simTables.simSlots.forEach((s, i) => {
      let k = 1;
      for (const f of Object.keys(s) as (keyof SimSlot)[]) if (typeof s[f] === 'number') (s as unknown as Record<string, number>)[f] = i * 100 + k++;
      s.node = node;
    });
    simTables.missileCamPose.fill(7);
    simTables.dat000a5630.fill(9);
    simTables.projectileSlotFill = 12;
    simTables.xploSlotFill = 13;
    const attacker = simTables.projectiles.map((p) => p.attackerMechIndex);
    simTablesReset();
    // sim_objects.c sim_tables_reset + projectile_clear (0x50540, 0x50660)
    simTables.projectiles.forEach((p, i) => {
      expect({ ...p, node: p.node }).toEqual({
        ...new Projectile(),
        id: -1,
        node: null,
        effectIndex: 0xff,
        impactFlags: 0xff,
        effectHigh: 0xffff,
        attackerMechIndex: attacker[i], // projectile_clear leaves it
      });
    });
    expect(simTables.projectiles).toHaveLength(PROJECTILE_COUNT);
    simTables.simSlots.forEach((s) => {
      expect({ ...s }).toEqual({ ...new SimSlot(), node: null, bitmapSlot: -1, typeIndex: -1 });
    });
    expect(simTables.simSlots).toHaveLength(SIM_SLOT_COUNT);
    expect(Array.from(simTables.missileCamPose)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(simTables.dat000a5630.every((b) => b === 0)).toBe(true);
    // the fill cursors are never reset
    expect([simTables.projectileSlotFill, simTables.xploSlotFill]).toEqual([12, 13]);
  });

  it('ANIM: every ANIM chunk through anim_ensure_loaded registers its tracks as the resource holds them', () => {
    let loads = 0;
    let hits = 0;
    for (const s of streams) {
      for (const c of s.chunks) {
        if (c.tag !== 'ANIM') continue;
        const ref = c.ref(8);
        const before = anim.animCacheCount;
        const r = animEnsureLoaded(ref);
        if (r === -1) {
          hits++;
          continue;
        }
        expect(r).toBe(1);
        expect(anim.animCacheCount).toBe(before + 1);
        loads++;
        const id = ref.id; // resolved and written back
        const a = parseAnim(prj.readResource('ANIM', id)!);
        const base = anim.animTrackBase;
        expect(anim.animCache[before]).toEqual({ id: c.i16(8), base });
        for (const t of a.tracks) {
          const tr = anim.animTracks[t.slot + base]!;
          expect(Array.from(tr.values as Int32Array)).toEqual(Array.from(t.values));
          expect([tr.channel, tr.frameCount, tr.field_0x0]).toEqual([t.channel, a.frameCount, 0]);
          expect(tr.frameTable.map((f) => [f.flags, f.flags2, ...[0, 1, 2, 3].map((k) => (f.args.charCodeAt(k) << 24) >> 24)])).toEqual(
            a.frames.map((f) => [f.flags, f.flags2, ...f.args]),
          );
          expect(tr.frames).toBe(tr.frameTable[0]);
        }
      }
    }
    // animTrackHighest stays 0 without anim tasks, so every ANIM lands at base 0
    expect(anim.animTrackBase).toBe(0);
    expect(loads).toBeGreaterThan(0);
    expect(loads + hits).toBeGreaterThan(loads);
  });

  it('CPIT and every HUD resource load into the cockpit tables as the bytes say', () => {
    const cpitIds = Array.from({ length: 100 }, (_, i) => i).filter((i) => prj.resourceSize('CPIT', i) > 0);
    expect(cpitIds.length).toBe(1);
    for (const id of cpitIds) {
      const b = prj.readResource('CPIT', id)!;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const s = (o: number) => dv.getInt16(o, true);
      expect(resLoadCockpit({ id, name: '' })).toBe(1);
      const rect = (o: number) => [s(o), s(o + 2), s(o) + s(o + 4) - 1, s(o + 2) + s(o + 6) - 1];
      cockpit.dat000955e8.forEach((w, i) => expect([w.left, w.top, w.right, w.bottom]).toEqual(rect(i * 8)));
      cockpit.dat000968e0.forEach((w, i) => expect([w.left, w.top, w.right, w.bottom]).toEqual(rect(40 + i * 8)));
      expect(Array.from(cockpit.dat0009572c)).toEqual([s(160), s(162)]);
    }
    const hudIds = Array.from({ length: 100 }, (_, i) => i).filter((i) => prj.resourceSize('HUD', i) > 0);
    expect(hudIds.length).toBe(18);
    for (const id of hudIds) {
      const b = prj.readResource('HUD', id)!;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const n = (o: number) => dv.getInt32(o, true);
      expect(resLoadHdi({ id, name: '' })).toBe(1);
      expect(Array.from(cockpit.dat0009623c)).toEqual(Array.from({ length: 10 }, (_, k) => n(k * 4)));
      expect(Array.from(cockpit.dat000fe0e8)).toEqual([n(0x28), n(0x2c), n(0x30)]);
      for (let r = 0; r < 15; r++) {
        const v = [0, 4, 8, 12].map((k) => n(0x34 + r * 16 + k));
        const ok = v.every((x) => x >= 0 && x <= 100);
        const w = cockpit.dat0009667c[r]!;
        expect([w.left, w.top, w.right, w.bottom]).toEqual(ok ? v : [0, 0, 0, 0]);
      }
    }
  });

  it('ANM2: the one chunk in MW2.PRJ adds SNOWCLR to slot 0; the eighth add is refused', () => {
    const found = streams.flatMap((s) => s.chunks.filter((c) => c.tag === 'ANM2'));
    expect(found).toHaveLength(1);
    expect(anim2dAdd(found[0]!)).toBe(0);
    const a = anim2d.anim2dSlots[0]!;
    expect([a.state, a.flags, a.ticksPerFrame, a.startTick, a.shpId, a.frameCount, a.shp]).toEqual([0, 0, 18, 0, 175, 0, null]);
    expect(resourceNames(prj, 'SHP').get(175)).toBe('SNOWCLR');
    const one = chunkOf('ANM2', [...le16(1), ...le16(9), ...le16(1), ...le16(33)]);
    for (let i = 1; i < 7; i++) expect(anim2dAdd(one)).toBe(i);
    expect(anim2dAdd(one)).toBe(0xffff);
    expect(anim2dAdd(chunkOf('ANM2', [...le16(1), ...le16(9), ...le16(2), ...le16(33)]))).toBe(0xffff);
  });

  it('frame_prj_add: the first call clears the table; 96 records then -1', () => {
    expect(frameProj.frameProjCount).toBe(-1);
    expect(framePrjAdd(0x12345, -3, 7)).toBe(0);
    expect(frameProj.frameProjTable[0]).toEqual({ field_0x0: 0x2345, field_0x4: -3, field_0x6: 7 });
    expect(frameProj.frameProjTable[1]).toEqual({ field_0x0: -1, field_0x4: 0, field_0x6: 0 });
    for (let i = 1; i < 96; i++) expect(framePrjAdd(i, 0, 0)).toBe(i);
    expect(framePrjAdd(1, 1, 1)).toBe(-1);
    expect(frameProj.frameProjCount).toBe(96);
  });

  it('day_cycle_init / tick: phase boundaries, the two warm-up calls, the 2 s first fade', () => {
    lighting.dayLengthSeconds = 2400; // hour 100 s
    lighting.timeOfDay = 1650; // phase 1 (700 <= t < 1700)
    planet.gravity = 1940;
    for (let k = 0; k < 20; k++) palettes.paletteResourceIds[k] = 1 + k;
    clock.tickDelta = 2;
    dayCycleInit();
    expect(Array.from(dayCycle.dayPhaseStart)).toEqual([500, 700, 1700, 1900]);
    expect(planet.gravitySetting).toBe(Math.trunc((1940 * 65536) / 0x794));
    clock.simTick = 0;
    dayCycleTick();
    dayCycleTick();
    expect([dayCycle.dayCycleWarmup, dayCycle.dayPhase]).toEqual([2, -1]);
    dayCycleTick(); // phase 1 -> slot 2, the first fade 0x16c ticks
    expect([dayCycle.dayPhase, dayCycle.dayCycleWarmup, palettes.paletteFadeTarget, palettes.paletteBaseSlot, palettes.paletteRestoreSlot]).toEqual([1, 3, 0, 0, 0]);
    expect(palettes.paletteFadeStepsLeft).toBe(0x16c / 2);
    palettes.paletteFadeStepsLeft = 0;
    clock.simTick = 0x71c - 1; // not yet
    dayCycleTick();
    expect(lighting.timeOfDay).toBe(1650);
    clock.simTick = 182 * 60; // start + 60 s = 1710: phase 2 (dusk, slot 4)
    dayCycleTick();
    expect([lighting.timeOfDay, dayCycle.dayPhase, palettes.paletteFadeTarget]).toEqual([1710, 2, 4]);
    expect(palettes.paletteFadeStepsLeft).toBe(3640 / 2);
    palettes.paletteFadeStepsLeft = 0;
    clock.simTick = 182 * 800; // 1650 + 800 = 2450 % 2400 = 50: wrapped, next day, phase 3 (night)
    dayCycleTick();
    expect([lighting.timeOfDay, lighting.dayOfYear, dayCycle.dayPhase, palettes.paletteFadeTarget]).toEqual([50, 1, 3, 8]);
    // PROVPLT1 starts at -20000 s: C's % keeps it negative, so night
    lighting.timeOfDay = -20000;
    dayCycleInit();
    dayCycle.dayCycleWarmup = 3;
    dayCycle.dayCycleNextTick = 0;
    clock.simTick = 182;
    dayCycleTick();
    expect([lighting.timeOfDay, dayCycle.dayPhase]).toEqual([-(19999 % 2400), 3]);
  });

  it('tracked_object_create / remove: shift down and renumber handles past the removed one', () => {
    const m0 = new MechEntity();
    m0.index = 0;
    m0.groupId = 3;
    const m1 = new MechEntity();
    m1.index = 1;
    mechs.mechTable[0] = m0;
    mechs.mechTable[1] = m1;
    mechs.mechCount = 2;
    mechs.playerMechIndex = 1;
    expect(trackedObjectCreate(0, 1, 2, 3)).toBe(0);
    expect(trackedObjectCreate(0, 4, 5, 6)).toBe(1);
    expect(trackedObjectCreate(0, 7, 8, 9)).toBe(2);
    const t0 = trackedGlobals.trackedObjects[0]!;
    expect([t0.inUse, t0.flags, t0.targetHandle, t0.groupId, t0.range, t0.name, t0.followNode]).toEqual([1, 0x401, 0x200, 3, 3000, '!', null]);
    m0.targetPrimary = 0x102;
    m0.targetSecondary = 0x101;
    m0.returnWaypoint = 0x102;
    m0.targetHandle = 0x102;
    m1.targetHandle = 0x102; // the player's is not renumbered
    expect(trackedObjectRemove(1, 0x101)).toBe(-1); // not mech 1's
    expect(trackedObjectRemove(0, 0x001)).toBe(-1); // no 0x100 type bit
    expect(trackedObjectRemove(0, 0x101)).toBe(2);
    expect(trackedGlobals.trackedObjects.slice(0, 2).map((t) => [t.x, t.y, t.z])).toEqual([
      [1, 2, 3],
      [7, 8, 9],
    ]);
    expect([m0.targetPrimary, m0.targetSecondary, m0.returnWaypoint, m0.targetHandle, m1.targetHandle]).toEqual([0x101, 0x101, 0x101, 0x101, 0x102]);
    trackedGlobals.trackedObjectCount = 0x80;
    expect(trackedObjectCreate(0, 0, 0, 0)).toBe(-1);
  });

  it('scrounge_install: tile size from the mesh extent, a third without children', () => {
    const mk = (xs: [number, number][]) => {
      const node = new SceneNode();
      const obj = new WorldObject();
      const mesh = new MeshBlock();
      mesh.vertices = xs.map(([x, z]) => Object.assign(new MeshVertex(), { modelX: x, modelZ: z }));
      mesh.vertexCount = xs.length;
      obj.meshList = mesh;
      node.userData = obj;
      return node;
    };
    const a = mk([
      [-30000, 0],
      [30000, 100],
      [0, -1000],
    ]);
    scroungeInstall(a); // extent 60000 / 3 = 20000 -> (1 + 1) * 0x4000
    expect([scrounge.scroungeTileSize, scrounge.scroungeHysteresis, scrounge.scroungeActive, scrounge.scroungeNode]).toEqual([0x8000, 0, 1, a]);
    expect(scrounge.dat000f43ac).toBe(((0x8000 >> 3) + 0x8000) >> 1);
    const b = mk([
      [0, 0],
      [100, 70000],
    ]);
    b.firstChild = new SceneNode();
    scroungeInstall(b); // extent 70000 -> (4 + 1) * 0x4000
    expect([scrounge.scroungeTileSize, scrounge.scroungeHysteresis]).toEqual([5 * 0x4000, 1]);
    const flat = mk([[5, 5]]);
    scroungeInstall(flat); // no extent: nothing changes
    expect(scrounge.scroungeNode).toBe(b);
  });
});
