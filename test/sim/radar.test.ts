// The radar (hudWidgets[0]'s display) end to end through main's loop: the
// RADAR module loaded and laid out, the small radar asked for at start and
// opened through its pane transition while the mech powers up, then drawn
// every running frame as an orthographic view from above the player - the
// player's marker at the centre, a seen enemy mech as a blip in the
// direction and at the distance it lies, the range readout.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { fixedCos, fixedSin } from '../../src/core/angle/trig.ts';
import { mulr16 } from '../../src/core/int/fx16.ts';
import type { MechEntity } from '../../src/generated/classes.gen.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { sceneNodeGetWorldPos, sceneNodeSetOrigin, sceneNodeWalk } from '../../src/engine/scene/sceneGraph.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { mapViewRenderHook, radar, vfxVideoSub012330, vfxVideoSub012370, vfxVideoSub0123d0, vfxVideoSub012410 } from '../../src/sim/cockpit/radar.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import { mainLoop } from '../../src/mission/mainLoop.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { vfxWindowClear } from '../../src/engine/vfx/vfx.ts';
import { mechAllegiance } from '../../src/sim/groups/groups.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  // a clean window each frame, so what a frame draws can be measured
  vfxWindowClear(defaultCanvas);
  mainLoopFrame();
}

/** The window pixels written inside the rectangle, as indices. */
function drawnIn(l: number, t: number, r: number, b: number): Set<number> {
  const w = defaultCanvas.xMax + 1;
  const s = new Set<number>();
  for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) if (defaultCanvas.drawn[y * w + x]) s.add(y * w + x);
  return s;
}

describe.runIf(hasGameData)('radar', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('opens the small radar and draws a seen enemy where it lies', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    expect(radar.module).not.toBeNull();
    // start: off, the small radar asked for
    expect(radar.mode).toBe(0);
    expect(radar.requested).toBe(1);
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    let opened = false;
    for (let f = 0; f < 400 && p.loadout!.status !== 2; f++) {
      frame();
      if (radar.mode === 1) opened = true;
    }
    expect(p.loadout!.status).toBe(2);
    expect(opened).toBe(true);
    frame();
    expect(radar.mode).toBe(1);
    expect(radar.phase).toBe(4);
    const d = radar.module!.modes[1]!;
    const pane = d.pane;
    // 1311..17039 / 1311..22282 of the screen's 639 x 479
    expect([pane.left, pane.top, pane.right, pane.bottom]).toEqual([13, 10, 166, 163]);
    expect(d.rangeText.text).toBe('R: 1.0km');
    const base = drawnIn(pane.left, pane.top, pane.right, pane.bottom);
    expect(base.size).toBeGreaterThan(100);

    // an enemy 400 m straight ahead of the player's legs, marked seen
    let enemy: MechEntity | null = null;
    for (let i = 0; i < mechs.mechCount; i++) {
      const m = mechs.mechTable[i];
      if (m && i !== mechs.playerMechIndex && m.gamepieceClass === 1 && mechAllegiance(i) === 1) {
        enemy = m;
        break;
      }
    }
    expect(enemy).not.toBeNull();
    const en = enemy!;
    const aim = sceneNodeGetWorldPos(p.aimNode!);
    const dist = 40000;
    const place = () => {
      en.posX = (aim[0] + mulr16(fixedSin(p.heading) >> 13, dist)) | 0;
      en.posZ = (aim[2] + mulr16(fixedCos(p.heading) >> 13, dist)) | 0;
      en.posY = aim[1];
      sceneNodeSetOrigin(en.node!, en.posX, en.posY, en.posZ);
      sceneNodeWalk(en.node!);
    };
    en.flags &= ~0x1400;
    place();
    frame();
    const without = drawnIn(pane.left, pane.top, pane.right, pane.bottom);
    en.flags |= 0x400;
    place();
    frame();
    const withBlip = drawnIn(pane.left, pane.top, pane.right, pane.bottom);
    const w = defaultCanvas.xMax + 1;
    const added = [...withBlip].filter((i) => !without.has(i));
    expect(added.length).toBeGreaterThan(0);
    const cx = added.reduce((s, i) => s + (i % w), 0) / added.length;
    const cy = added.reduce((s, i) => s + Math.floor(i / w), 0) / added.length;
    // 400 m of a 2 km-wide view across the pane's 154 pixels: 30.8 pixels up from the centre
    const px = (pane.right - pane.left + 1) >> 1;
    const py = (pane.bottom - pane.top + 1) >> 1;
    const upp = Math.trunc(d.range / (pane.right - pane.left + 1));
    expect(Math.abs(cx - (pane.left + px))).toBeLessThan(3);
    expect(Math.abs(pane.top + py - dist / upp - cy)).toBeLessThan(3);
  });

  it('zooms and cycles as the commands ask', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    for (let f = 0; f < 400 && p.loadout!.status !== 2; f++) frame();
    frame();
    const d = radar.module!.modes[1]!;
    vfxVideoSub012410(1);
    expect(d.range).toBe(100000);
    expect(d.zoomScale).toBe(0x20000);
    vfxVideoSub012410(1);
    vfxVideoSub012410(1);
    expect(d.range).toBe(400000); // 25000 is below the least, 50000: it wraps to the most
    vfxVideoSub012410(2);
    expect(d.range).toBe(50000); // 800000 is above the most: it wraps to the least
    vfxVideoSub012410(0);
    expect(d.range).toBe(200000);
    frame();
    expect(d.rangeText.text).toBe('R: 1.0km');
    vfxVideoSub012410(1);
    vfxVideoSub012410(1);
    frame();
    expect(d.rangeText.text).toBe('R: 250.0m');
    vfxVideoSub012330();
    frame();
    expect(radar.mode).toBe(2);
    vfxVideoSub012330();
    frame();
    expect(radar.mode).toBe(0);
  });

  it('opens the map through the render hook and closes it back to the radar', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const hook = () => {};
    mainLoop.renderHook = hook;
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    for (let f = 0; f < 400 && p.loadout!.status !== 2; f++) frame();
    frame();
    expect(radar.mode).toBe(1);
    vfxVideoSub0123d0();
    expect(radar.requested).toBe(3);
    frame();
    // 3: the render hook is the map's and 4 is asked for; the next step takes it up
    expect(mainLoop.renderHook).toBe(mapViewRenderHook);
    frame();
    expect(vfxVideoSub012370()).toBe(true);
    expect(hud.hudReticleOn).toBe(0);
    expect(hud.hudTargetMarkerOn).toBe(0);
    // the map fills the whole screen with the ground colour
    expect(drawnIn(0, 0, defaultCanvas.xMax, defaultCanvas.yMax).size).toBe((defaultCanvas.xMax + 1) * (defaultCanvas.yMax + 1));
    vfxVideoSub0123d0();
    frame();
    expect(mainLoop.renderHook).toBe(hook);
    frame();
    frame();
    expect(radar.mode).toBe(1);
    expect(hud.hudReticleOn).toBe(1);
    expect(hud.hudTargetMarkerOn).toBe(1);
  });
});
