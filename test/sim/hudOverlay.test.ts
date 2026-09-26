// The status gauges, the compass and the objectives display, drawn by
// player_cockpit_frame through main's loop into the VFX window: what they
// draw is checked against the sim values the code reads - the speed text
// against '%d kph' of the velocity norm rendered independently, the throttle
// bar's height against the throttle, the heat bar against its layout - and
// that the compass and objectives draw in their widgets' panes.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import type { ViewWindow } from '../../src/generated/classes.gen.ts';
import { timerInterrupt } from '../../src/engine/timer.ts';
import { cacheLoadResource } from '../../src/engine/resources/cache.ts';
import { VfxWindow, vfxStringDraw, vfxWindowAllocate, vfxWindowClear } from '../../src/engine/vfx/vfx.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { damageDisplay } from '../../src/sim/cockpit/damageDisplay.ts';
import { gauges } from '../../src/sim/cockpit/gauges.ts';
import { widget, widgetPane } from '../../src/sim/cockpit/hud.ts';
import { objectivesHud } from '../../src/sim/cockpit/objectivesHud.ts';
import { defaultCanvas, display } from '../../src/sim/display/video.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) timerInterrupt();
  mainLoopFrame();
}

/** Drawn pixels of the window inside a pane, as screen indices. */
function drawnIn(p: ViewWindow): number[] {
  const w = defaultCanvas;
  const pitch = w.xMax + 1;
  const out: number[] = [];
  for (let y = Math.max(0, p.top); y <= Math.min(w.yMax, p.bottom); y++) for (let x = Math.max(0, p.left); x <= Math.min(w.xMax, p.right); x++) if (w.drawn[y * pitch + x]) out.push(y * pitch + x);
  return out;
}

/** The pixels vfx_string_draw makes of `text` at (x, y) in `p`, on an empty window of the same size. */
function textPixels(p: ViewWindow, x: number, y: number, text: string, ink: number): Map<number, number> {
  const w = new VfxWindow();
  vfxWindowAllocate(w, defaultCanvas.xMax + 1, defaultCanvas.yMax + 1);
  const pane = { ...p, canvas: w } as ViewWindow;
  const table = Uint8Array.from({ length: 256 }, (_, i) => i);
  table[0xe] = ink;
  vfxStringDraw(pane, x, y, cacheLoadResource(display.assetVariant + 1, 'FONT')!, text, table);
  const m = new Map<number, number>();
  w.drawn.forEach((d, i) => d && m.set(i, w.buffer[i]!));
  return m;
}

function expectText(p: ViewWindow, x: number, y: number, text: string, ink: number) {
  const want = textPixels(p, x, y, text, ink);
  expect(want.size).toBeGreaterThan(0);
  for (const [i, c] of want) {
    expect(defaultCanvas.drawn[i], `pixel ${i} of '${text}'`).toBe(1);
    expect(defaultCanvas.buffer[i]).toBe(c);
  }
}

describe.runIf(hasGameData)('HUD gauges, compass and objectives', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('draws the speed, throttle, heat, compass and objectives from the sim', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    expect(display.assetVariant).toBe(1);
    const kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    const l = p.loadout!;
    for (let f = 0; f < 400 && l.status !== 2; f++) frame();
    expect(l.status).toBe(2);
    const L = damageDisplay.gaugeLayout;
    // hud_gauge_layout_init has made the layout pixels: the throttle bar fits widget 17
    const w17 = widget(0x11);
    expect(L[1]).toBeGreaterThan(0);
    expect(L[1]).toBeLessThan(w17.height);

    // standing still: 0 kph, and the throttle bar one pixel high (value 0, height v + 1)
    vfxWindowClear(defaultCanvas);
    frame();
    const tp17 = w17.textPos as Int32Array;
    expectText(widgetPane(w17), tp17[0]!, tp17[1]!, '0 kph', 0xe);

    kb.isr(0x0b); // THROTTLE_FULL
    kb.isr(0x8b);
    for (let f = 0; f < 200; f++) frame();
    vfxWindowClear(defaultCanvas);
    frame();
    // the speed text: ((4 * max + mid + min) >> 2) / 0x2712 of the velocity, times 1.5, truncated
    const v = [Math.abs(l.velocityX), Math.abs(l.velocityY), Math.abs(l.velocityZ)].sort((a, b) => b - a);
    const kph = Math.trunc(Math.trunc(((v[0]! * 4 + v[1]! + v[2]!) >> 2) / 0x2712) * 1.5);
    expect(kph).toBeGreaterThan(0);
    expectText(widgetPane(w17), tp17[0]!, tp17[1]!, `${kph} kph`, 0xe);
    // the throttle bar: settled near full, it stands min(length, value) + 1 high
    // THROTTLE_FULL is a preset (1017); the gauge's target is (throttle << 16) * length / 0x400
    const thr = p.control!.throttle;
    expect(thr).toBeGreaterThan(900);
    const target = Math.trunc((thr * 65536 * L[1]!) / 0x400);
    expect(gauges.throttleLowpass[1]).toBe(target);
    expect(Math.abs((gauges.throttleLowpass[0]! >> 16) - (target >> 16))).toBeLessThanOrEqual(1);
    const pane17 = widgetPane(w17);
    const pitch = defaultCanvas.xMax + 1;
    const colX = pane17.left + L[6]!;
    let high = 0;
    for (let y = pane17.top + L[7]!; y >= pane17.top && defaultCanvas.drawn[y * pitch + colX]; y--) high++;
    // hud_draw_bar_vertical draws each column from y up to y - height inclusive, height = v + 1: v + 2 rows;
    // the frame's top line (y = [3]) continues the column when the bar reaches it
    const vv = Math.min(L[1]!, gauges.throttleLowpass[0]! >> 16);
    expect(high).toBe(vv + 2 + (L[7]! - vv - 2 === L[3]! ? 1 : 0));

    // the heat bar in widget 19: its rows cover x .. x + length + 1, shaded from
    // the colour groups 3 (ends), 7 or 0xb (middle): 1..3, 5..7, 9..11
    const pane19 = widgetPane(widget(0x13));
    const hx = pane19.left + L[8]!;
    const hy = pane19.top + L[9]!;
    for (let x = hx; x <= hx + L[10]!; x++) {
      const i = hy * pitch + x;
      expect(defaultCanvas.drawn[i], `heat bar x=${x}`).toBe(1);
      expect([1, 2, 3, 5, 6, 7, 9, 10, 11]).toContain(defaultCanvas.buffer[i]);
    }
    expectText(pane19, (widget(0x13).textPos as Int32Array)[0]!, (widget(0x13).textPos as Int32Array)[1]!, 'Heat', 0xe);

    // the compass tape draws inside widget 23
    expect(drawnIn(widgetPane(widget(0x17))).length).toBeGreaterThan(50);

    // objectives: nothing until the display is on, then the heading in 6
    const w15 = widget(0xf);
    const inPane15 = drawnIn(widgetPane(w15)).length;
    objectivesHud.objectivesDisplayOn = 1;
    vfxWindowClear(defaultCanvas);
    frame();
    const tp15 = w15.textPos as Int32Array;
    expectText(widgetPane(w15), tp15[0]!, tp15[1]!, 'MISSION OBJECTIVES', 6);
    expect(drawnIn(widgetPane(w15)).length).toBeGreaterThan(inPane15);
  });
});
