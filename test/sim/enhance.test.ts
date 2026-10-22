// The detail enhancements against the game (AMY_SCN1): the cockpit screens'
// panes are real rectangles of the window, and lodAllNear gives the top
// detail level to the mechs mech_lod_update's policy would otherwise leave
// lower - and nothing changes with it off.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { cameraGlobals } from '../../src/sim/camera/viewer.ts';
import { projectionGlobals, viewerRefreshLodScale } from '../../src/sim/camera/projection.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { mechLodUpdate } from '../../src/sim/world/detailRecords.ts';
import { slotPanes } from '../../src/render/cockpit/cockpit.ts';
import { cropRect, PANE_WIDGETS, SCREENS, type ScreenPart } from '../../src/render/cockpit/kit.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

const levels = () => mechs.mechTable.slice(0, mechs.mechCount).map((m) => m!.detailLevel);
const setLod = (scale: number, allNear: number) => {
  projectionGlobals.lodDistanceScale = scale;
  projectionGlobals.lodAllNear = allNear;
  for (const v of new Set([cameraGlobals.mainViewer, cameraGlobals.viewerPosition])) if (v) viewerRefreshLodScale(v);
  mechLodUpdate();
};

describe.runIf(hasGameData)('detail enhancements in the game', () => {
  beforeAll(async () => {
    const src = gameSource();
    bootMission({ exe: ExeImage.fromExe(await src.read('MW2.EXE')), prj: new ProjectFile(await src.read('MW2.PRJ')), looseFiles: installFiles(), mission: 'AMY_SCN1' });
    for (let f = 0; f < 40; f++) {
      for (let i = 0; i < 9; i++) ailTimerService();
      mainLoopFrame();
    }
  });

  it("finds the cockpit screens' panes inside the window", () => {
    const panes = slotPanes((i) => {
      const win = hud.hudWidgets[i]?.window as { left: number; top: number; right: number; bottom: number } | null | undefined;
      return win ? { x: win.left, y: win.top, w: win.right - win.left + 1, h: win.bottom - win.top + 1 } : null;
    });
    // the radar draws in its own pane (the small radar's, laid over widget 0's): 13,10 to 166,163
    expect(panes.radar).toEqual({ x: 13, y: 10, w: 154, h: 154 });
    const W = defaultCanvas.xMax + 1;
    const H = defaultCanvas.yMax + 1;
    for (const name of Object.keys(PANE_WIDGETS) as Array<keyof typeof PANE_WIDGETS>) {
      const p = panes[name]!;
      expect(p, `screen ${name}`).not.toBeNull();
      expect(p.w).toBeGreaterThan(10);
      expect(p.h).toBeGreaterThan(10);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(W);
      expect(p.y + p.h).toBeLessThanOrEqual(H);
    }
  });

  it("shows each piece of the window on one screen only: the screens' pieces of their panes do not overlap", () => {
    // the panes themselves do (the speed widget's takes in half the damage display's), so a screen showing a
    // whole pane showed another widget's drawing too
    const panes = slotPanes((i) => {
      const win = hud.hudWidgets[i]?.window as { left: number; top: number; right: number; bottom: number } | null | undefined;
      return win ? { x: win.left, y: win.top, w: win.right - win.left + 1, h: win.bottom - win.top + 1 } : null;
    });
    const pieces = Object.entries(SCREENS).flatMap(([screen, parts]) => (parts as readonly ScreenPart[]).map((part) => ({ name: `${screen}/${part.pane}`, r: cropRect(panes[part.pane]!, part.crop) })));
    for (const p of pieces) expect(p.r.w * p.r.h, p.name).toBeGreaterThan(0);
    for (let i = 0; i < pieces.length; i++)
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i]!.r;
        const b = pieces[j]!.r;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${pieces[i]!.name} and ${pieces[j]!.name}`).toBe(true);
      }
  });

  it('gives every near mech the top level with lodAllNear, and changes nothing without it', () => {
    setLod(1, 0);
    const original = levels();
    setLod(1, 0);
    expect(levels()).toEqual(original);
    // far enough out that every mech is inside the nearest range: the original policy still gives 0 to one
    setLod(1000, 0);
    const zeroes = levels().filter((l, i) => l === 0 && i !== mechs.playerMechIndex).length;
    expect(zeroes).toBeLessThanOrEqual(1);
    setLod(1000, 1);
    levels().forEach((l, i) => {
      if (i !== mechs.playerMechIndex && (mechs.mechTable[i]!.flags & 2) === 0) expect(l, `mech ${i}`).toBe(0);
    });
    setLod(1, 0);
  });
});
