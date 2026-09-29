// Drawing between passes (engine/scene/present.ts) on a real mission, at a
// fixed step: the same input and ticks give the same game whether the host
// draws only at the passes or also three times between each two - the
// presented draws, the world's and the HUD's, with the player walking,
// turning and firing, leave nothing behind in the game's state or its window. And at alpha = 1 the HUD's reticle and target
// marker redrawn by the host are exactly the pixels the pass drew.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import type { WorldObject } from '../../src/generated/classes.gen.ts';
import { clock } from '../../src/engine/clock.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { objectsOnList, worldRootNode } from '../../src/engine/scene/objectLists.ts';
import { ALPHA_ONE, presentFrameBegin, presentFrameEnd } from '../../src/engine/scene/present.ts';
import { DRAWN_AFTER, DRAWN_ANCHORED, VfxWindow, vfxWindowAllocate } from '../../src/engine/vfx/vfx.ts';
import { randomCursors } from '../../src/core/random.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopStep } from '../../src/mission/mainLoop.ts';
import { SceneRenderer } from '../../src/render/SceneRenderer.ts';
import { viewer } from '../../src/sim/camera/viewer.ts';
import { presentedViewer } from '../../src/sim/camera/viewerPresent.ts';
import { hudAnchored, hudAnchoredPresent } from '../../src/sim/cockpit/overlay.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { renderPort } from '../../src/sim/display/renderPort.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { simTables } from '../../src/sim/effects/simTables.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

/** the fixed step: 9 ticks a pass, the host's default 20 passes a second */
const STEP = 9;

/** The host's side of main's render hook, as far as the latch needs it: whether the pass asked for the main view. */
const port = {
  requested: false,
  skyAndGround() {},
  objectList() {},
  sceneTreeSorted() {},
  mainView() {
    port.requested = true;
  },
};

const player = () => mechs.mechTable[mechs.playerMechIndex]!;

/** What the game holds after a pass: its clock and random cursors, every mech, every world object with its mesh choice and vertices, the window. */
function state(): string {
  const objects = [...objectsOnList(worldRootNode)].map((o: WorldObject) => {
    const m = o.currentMesh;
    let lod = -1;
    for (let b = o.meshList, i = 0; b; b = b.next, i++) if (b === m) lod = i;
    const v = m ? m.vertices.slice(0, m.vertexCount).map((x) => [x.worldX, x.worldY, x.worldZ]) : [];
    return [o.posX, o.posY, o.posZ, o.transformVersion, lod, m?.transformVersion ?? 0, v];
  });
  const ms = mechs.mechTable.slice(0, mechs.mechCount).map((m) => [m!.posX, m!.posY, m!.posZ, m!.heading, m!.loadout?.velocityX, m!.loadout?.velocityZ, m!.loadout?.status, m!.targetHandle]);
  let h = 0;
  for (let i = 0; i < defaultCanvas.buffer.length; i++) h = (Math.imul(h, 31) + defaultCanvas.buffer[i]! * 4 + defaultCanvas.drawn[i]!) | 0;
  return JSON.stringify([clock.simTick, clock.tickDelta, randomCursors(), ms, objects, h]);
}

interface Run {
  states: string[];
  /** presented frames whose reticle or target marker the host redrew */
  anchored: number;
  /** presented frames drawn from an interpolated viewer rather than the pass's own */
  interpolated: number;
  /** presented frames with a round in flight */
  shooting: number;
}

/** AMY_SCN1 for `passes` passes of the scripted input, drawing between passes when `between`. */
function run(passes: number, between: boolean, check?: (layer: VfxWindow) => void): Run {
  bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
  renderPort.current = port;
  const kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
  const sr = new SceneRenderer();
  const layer = new VfxWindow();
  // throttle up, turn left a while, twist the torso; group fire, and the trigger (Space) pulled every 8 passes
  const script: Record<number, number[]> = { 145: [0x2b], 146: [0xab], 150: [0x0b, 0x8b], 170: [0xe0, 0x4b], 230: [0xe0, 0xcb], 260: [0x34], 300: [0xb4] };
  const states: string[] = [];
  let anchored = 0;
  let interpolated = 0;
  let shooting = 0;
  try {
    for (let k = 0; k < passes; k++) {
      for (const b of script[k] ?? []) kb.isr(b);
      if (k >= 150 && k % 8 === 0) kb.isr(0x39);
      if (k >= 150 && k % 8 === 4) kb.isr(0xb9);
      // the player's target: another mech, once the HUD is up
      if (k === 140) {
        for (let i = 0; i < mechs.mechCount; i++) if (i !== mechs.playerMechIndex && mechs.mechTable[i]) player().targetHandle = 0x200 | i;
      }
      for (let t = 0; t < STEP; t++) ailTimerService();
      port.requested = false;
      mainLoopStep();
      if (port.requested) sr.latch(viewer());
      if (between) {
        for (const alpha of [0, 0x5555, 0xaaaa]) {
          presentFrameBegin(alpha);
          const v = presentedViewer();
          if (v !== viewer()) interpolated++;
          if (simTables.projectiles.some((q) => q.active !== 0)) shooting++;
          sr.sync(v);
          if (layer.xMax !== defaultCanvas.xMax || layer.yMax !== defaultCanvas.yMax) vfxWindowAllocate(layer, defaultCanvas.xMax + 1, defaultCanvas.yMax + 1);
          if (hudAnchoredPresent(layer, v)) anchored++;
          presentFrameEnd();
        }
      }
      check?.(layer);
      states.push(state());
    }
  } finally {
    renderPort.current = null;
    sr.destroy();
  }
  return { states, anchored, interpolated, shooting };
}

describe.runIf(hasGameData)('presentation between passes', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('every pass covers the fixed step', () => {
    const { states } = run(40, false);
    for (const s of states.slice(2)) expect(JSON.parse(s)[1]).toBe(STEP);
  });

  it('drawing between passes leaves the game as drawing only at the passes does', () => {
    const at = run(360, false);
    const between = run(360, true);
    expect(between.anchored).toBeGreaterThan(100);
    expect(between.interpolated).toBeGreaterThan(500);
    expect(between.shooting).toBeGreaterThan(50);
    for (let k = 0; k < at.states.length; k++) expect(between.states[k], `pass ${k}`).toBe(at.states[k]);
    // and the game moved
    expect(at.states[359]).not.toBe(at.states[100]);
  }, 120000);

  it('at alpha = 1 the redrawn reticle and marker are the pass\'s own pixels', () => {
    let compared = 0;
    run(260, false, (layer) => {
      const c = hudAnchored.call;
      if (!c || !(c.reticle || c.marker)) return;
      if (layer.xMax !== defaultCanvas.xMax || layer.yMax !== defaultCanvas.yMax) vfxWindowAllocate(layer, defaultCanvas.xMax + 1, defaultCanvas.yMax + 1);
      presentFrameBegin(ALPHA_ONE);
      const drew = hudAnchoredPresent(layer, presentedViewer());
      presentFrameEnd();
      expect(drew).toBe(true);
      const w = defaultCanvas;
      let pixels = 0;
      const wrong: number[] = [];
      for (let i = 0; i < w.buffer.length; i++) {
        if (w.drawn[i] === DRAWN_AFTER) continue; // drawn over after, in either
        const inWindow = w.drawn[i] === DRAWN_ANCHORED;
        if ((layer.drawn[i] !== 0) !== inWindow || (inWindow && layer.buffer[i] !== w.buffer[i])) wrong.push(i);
        if (inWindow) pixels++;
      }
      expect(wrong).toEqual([]);
      if (pixels > 0) compared++;
    });
    expect(compared).toBeGreaterThan(50);
  }, 120000);
});
