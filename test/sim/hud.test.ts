// The HUD's widgets on the player's mech, built by hud_widgets_install
// through mech_std_create and drawn by player_cockpit_frame (hook 4) inside
// main's loop: the weapon regroup's invariants, the weapon list's lines, and
// the screen layout after the start-up rescale to 640x480.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import type { ViewWindow } from '../../src/generated/classes.gen.ts';
import { timerInterrupt } from '../../src/engine/timer.ts';
import { vfxWindowClear } from '../../src/engine/vfx/vfx.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import { cockpit } from '../../src/sim/cockpit/resources.ts';
import { defaultCanvas, display } from '../../src/sim/display/video.ts';
import { weaponTypes } from '../../src/sim/mech/config.ts';
import { loadoutAmmo, loadoutWeapons } from '../../src/sim/mech/loadout.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) timerInterrupt();
  mainLoopFrame();
}

/** Pixels drawn inside a pane since the last clear. */
function drawnIn(p: ViewWindow): number {
  let n = 0;
  const pitch = defaultCanvas.xMax + 1;
  for (let y = p.top; y <= p.bottom; y++) for (let x = p.left; x <= p.right; x++) n += defaultCanvas.drawn[y * pitch + x]!;
  return n;
}

describe.runIf(hasGameData)('HUD widgets', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('the display comes up at 640x480 with the "6" art and the layout rescaled', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    expect(display.assetVariant).toBe(1);
    expect([defaultCanvas.xMax, defaultCanvas.yMax]).toEqual([639, 479]);
    // design pixels (x << 16) / 319 then * 639, rounded: widget 3's pane as CPIT MW2MECH lays it out, {214, 15, 265, 22}
    const p = cockpit.dat000968e0[3]!;
    const px = (v: number, d: number, m: number) => {
      const f = Math.trunc((v * 65536) / d);
      return Math.floor((f * m) / 65536 + 0.5);
    };
    expect([p.left, p.top, p.right, p.bottom]).toEqual([px(214, 319, 639), px(15, 199, 479), px(265, 319, 639), px(22, 199, 479)]);
  });

  it('regroups the weapons by side and keeps the ammo bins pointing at their weapons', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
    const weapons = loadoutWeapons(l);
    const ammo = loadoutAmmo(l);
    const left = new Set([5, 3, 7]);
    const right = new Set([4, 1, 6]);
    for (let i = 0; i < 10; i++) {
      const w = weapons[i]!;
      if (w.type < 0) continue;
      if (left.has(w.sectionIndex)) expect(i % 2, `weapon ${i} (section ${w.sectionIndex}) on the left`).toBe(0);
      if (right.has(w.sectionIndex)) expect(i % 2, `weapon ${i} (section ${w.sectionIndex}) on the right`).toBe(1);
      for (let b = 0; b < w.numBins; b++) expect(ammo[w.binIndices[b]!]!.weaponIndex).toBe(i);
    }
    const names = weaponTypes();
    for (let k = 3; k <= 12; k++) {
      const wd = hud.hudWidgets[k]!;
      if (wd.weaponIndex < 0 || !weapons[wd.weaponIndex] || weapons[wd.weaponIndex]!.type < 0) continue;
      expect(wd.label).toBe(names[weapons[wd.weaponIndex]!.type]!.name.slice(0, 31));
    }
  });

  it('draws the weapon list while running and frames the selected weapon', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
    for (let f = 0; f < 400 && l.status !== 2; f++) frame();
    expect(l.status).toBe(2);
    vfxWindowClear(defaultCanvas);
    frame();
    const weapons = loadoutWeapons(l);
    let lines = 0;
    for (let k = 3; k <= 12; k++) {
      const wd = hud.hudWidgets[k]!;
      const pane = wd.window as ViewWindow;
      const has = wd.weaponIndex >= 0 && (weapons[wd.weaponIndex]?.type ?? -1) >= 0;
      if (!has) {
        expect(drawnIn(pane)).toBe(0);
        continue;
      }
      lines++;
      expect(drawnIn(pane), `widget ${k}`).toBeGreaterThan(0);
      if (wd.weaponIndex === l.selectedWeapon) {
        // the frame: the pane's top-left corner is drawn
        expect(defaultCanvas.drawn[pane.top * (defaultCanvas.xMax + 1) + pane.left]).toBe(1);
      }
    }
    expect(lines).toBeGreaterThan(0);
  });
});
