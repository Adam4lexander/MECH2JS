// The damage display (hudWidgets[2]) through main's loop: once the player's
// mech runs, player_cockpit_frame draws it every frame. In mode 1 (the
// diagram) a section that is destroyed turns palette index 6 of its regions
// to colour 0 - the diagram redrawn through damageColourRemap[6] = 0,
// clipped to each region's pane - and changes nothing outside the regions.
// In mode 2 (the armour bars) a destroyed section's bar is all "lost", drawn
// in 0xf3 and its shades 0xf2, 0xf1.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import type { ViewWindow } from '../../src/generated/classes.gen.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { vfxWindowClear } from '../../src/engine/vfx/vfx.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { damageDisplay, damageDisplayModeCycle } from '../../src/sim/cockpit/damageDisplay.ts';
import { hud, widget, widgetPane } from '../../src/sim/cockpit/hud.ts';
import { cockpit } from '../../src/sim/cockpit/resources.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { mechApplyDamage } from '../../src/sim/mech/damage.ts';
import { loadoutSections } from '../../src/sim/mech/loadout.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  vfxWindowClear(defaultCanvas);
  mainLoopFrame();
}

const W = () => defaultCanvas.xMax + 1;
const inPane = (p: ViewWindow, x: number, y: number) => x >= p.left && x <= p.right && y >= p.top && y <= p.bottom;

describe.runIf(hasGameData)('damage display', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('draws the diagram while running, and a destroyed arm recolours its regions and empties its bar', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
    for (let f = 0; f < 400 && l.status !== 2; f++) frame();
    expect(l.status).toBe(2);
    expect(hud.damageDisplayMode).toBe(1);
    const w = widget(2);
    expect(w.visible).toBe(1);
    const d = damageDisplay;
    const dp = d.diagramPane;
    // the diagram is centred in the widget's box
    expect(dp.right - dp.left).toBeLessThan(w.width);
    expect(dp.left).toBeGreaterThanOrEqual(w.left);

    frame();
    const width = W();
    let drawn = 0;
    for (let y = dp.top; y <= dp.bottom; y++) for (let x = dp.left; x <= dp.right; x++) drawn += defaultCanvas.drawn[y * width + x]!;
    expect(drawn).toBeGreaterThan(0);
    const before = defaultCanvas.buffer.slice();
    const beforeDrawn = defaultCanvas.drawn.slice();

    // regions 7 and 8 show section 5 (the right arm, 1-based as mech_apply_damage takes it)
    expect(d.damageDiagramSections[7]).toBe(5);
    expect(d.damageDiagramSections[8]).toBe(5);
    const arm = loadoutSections(l)[4]!;
    for (let k = 0; k < 50 && (arm.flags & 0x2000) === 0; k++) mechApplyDamage(l, 50 << 16, 5);
    expect(arm.flags & 0x2000).not.toBe(0);

    frame();
    const regions = cockpit.dat0009667c;
    const arms = [regions[7]!, regions[8]!];
    const others = regions.filter((_, i) => i !== 7 && i !== 8 && i !== 15);
    let turned = 0;
    for (let y = dp.top; y <= dp.bottom; y++) {
      for (let x = dp.left; x <= dp.right; x++) {
        const i = y * width + x;
        if (!beforeDrawn[i]) continue;
        const inArm = arms.some((r) => inPane(r, x, y));
        const inOther = others.some((r) => inPane(r, x, y));
        if (inArm && !inOther && before[i] === 6) {
          expect(defaultCanvas.buffer[i]).toBe(0);
          turned++;
        } else if (!inArm && !inOther) {
          // outside every region the diagram is the same shape draw
          expect(defaultCanvas.buffer[i]).toBe(before[i]);
        }
      }
    }
    expect(turned).toBeGreaterThan(0);

    // mode 2: the armour bars. Section 4 (index of the right arm) has one full-width bar
    damageDisplayModeCycle();
    expect(hud.damageDisplayMode).toBe(2);
    frame();
    const pane = widgetPane(w);
    const bx = pane.left + d.barOrigins[8]!;
    const top = pane.top + d.barOrigins[9]!;
    const gone = new Set([0xf1, 0xf2, 0xf3]);
    let lost = 0;
    for (let y = top; y <= top + d.barScale[1]!; y++) {
      for (let x = bx; x < bx + d.barScale[0]!; x++) {
        const i = y * width + x;
        if (defaultCanvas.drawn[i] && gone.has(defaultCanvas.buffer[i]!)) lost++;
      }
    }
    expect(lost).toBeGreaterThan(0);
    // the head's bar (section 0) is intact: some of it in the "armour left" shades 0xd..0xf
    const hx = pane.left + d.barOrigins[0]!;
    const hy = pane.top + d.barOrigins[1]!;
    let left = 0;
    for (let y = hy; y <= hy + d.barScale[1]!; y++) {
      for (let x = hx; x < hx + d.barScale[0]!; x++) {
        const i = y * width + x;
        if (defaultCanvas.drawn[i] && defaultCanvas.buffer[i]! >= 0xd && defaultCanvas.buffer[i]! <= 0xf) left++;
      }
    }
    expect(left).toBeGreaterThan(0);

    // the cycle runs 1..5 and wraps
    hud.damageDisplayMode = 5;
    damageDisplayModeCycle();
    expect(hud.damageDisplayMode).toBe(1);
  });
});
