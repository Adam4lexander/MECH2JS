// MW2.EXE's fifth cheat code, "You asked for it!", through main's loop: the
// render hook swapped for cheat_credits_render_hook, the view shrunk and
// closed, the two GIF pictures of VFX\ decoded into the window and faded in,
// MENU 3 (the credits) opened over them, and after it closes the old hook,
// the palette and the HUD put back.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { readCheatCodes } from '../../src/data/exe/tables/cheats.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { vfxWindowClear, type VfxWindow } from '../../src/engine/vfx/vfx.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoop, mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import { radar } from '../../src/sim/cockpit/radar.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { palettes } from '../../src/sim/world/palettes.ts';
import { cheatCredits, cheatCreditsRenderHook } from '../../src/sim/ui/cheatCredits.ts';
import { cheatHandleCommand } from '../../src/sim/ui/cheats.ts';
import { uiContextClearRequest } from '../../src/sim/ui/menuCallbacks.ts';
import { uiContextActiveRecord, uiContextFindNode } from '../../src/sim/ui/menus.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  vfxWindowClear(defaultCanvas);
  mainLoopFrame();
}

/**
 * A GIF's first image as rows of palette indices - a plain LZW decoder
 * written from the GIF87a specification, independent of engine/vfx/gif.ts,
 * so the test compares the port's pixels with the file's.
 */
function referenceDecode(g: Uint8Array): { w: number; h: number; px: Uint8Array } {
  let at = 13;
  if (g[10]! & 0x80) at += 3 << ((g[10]! & 7) + 1);
  const w = g[at + 5]! | (g[at + 6]! << 8);
  const h = g[at + 7]! | (g[at + 8]! << 8);
  const lf = g[at + 9]!;
  at += 10;
  if (lf & 0x80) at += 3 << ((lf & 7) + 1);
  const min = g[at++]!;
  const bytes: number[] = [];
  for (let n = g[at++]!; n !== 0; n = g[at++]!) for (let i = 0; i < n; i++) bytes.push(g[at++]!);
  const clear = 1 << min;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let size = min + 1;
  let bit = 0;
  const out: number[] = [];
  let prev: number[] | null = null;
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((bytes[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      size = min + 1;
      prev = null;
      continue;
    }
    if (code === clear + 1) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code]!;
    else entry = [...prev!, prev![0]!];
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]!]);
      if (dict.length === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  return { w, h, px: Uint8Array.from(out.slice(0, w * h)) };
}

describe.runIf(hasGameData)('cheat 4: the pictures and the credits', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
    for (const n of ['VFXJK.BIN', 'VFXHD.BIN']) files.set(`VFX/${n}`, await src.read(`VFX/${n}`));
  });

  it('shrinks the view, shows both pictures, opens MENU 3 and puts everything back', () => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    for (let f = 0; f < 5; f++) frame();
    const view = mainLoop.renderHook;
    expect(view).not.toBeNull();
    expect(hud.hudEnabled).toBe(1);
    const code = readCheatCodes(exe)[4]!.typed;
    for (let i = 0; i < code.length; i++) cheatHandleCommand(0x700 | code.charCodeAt(i));
    expect(mainLoop.renderHook).toBe(cheatCreditsRenderHook);
    expect(cheatCredits.cheatCreditsSavedHook).toBe(view);
    expect(cheatCredits.cheatCreditsState).toBe(0);

    // states 0..3: the view, the shrink and the close - the HUD hidden from 2 on
    const seen = new Set<number>();
    let hudOffInClose = true;
    for (let f = 0; f < 2000 && cheatCredits.cheatCreditsState !== 5; f++) {
      frame();
      seen.add(cheatCredits.cheatCreditsState);
      if (cheatCredits.cheatCreditsState === 3 && hud.hudEnabled !== 0) hudOffInClose = false;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
    expect(hudOffInClose).toBe(true);

    // state 4 ran: vfxjk decoded into a 320x211 pane at the centre, and faded in
    const jk = files.get('VFX/VFXJK.BIN')!;
    expect(cheatCredits.cheatCreditsPicture).toBe(jk);
    expect(cheatCredits.cheatCreditsPictureShown).toBe(1);
    const pane = cheatCredits.cheatCreditsPicturePane;
    // 640x480 scaled about its centre (320, 240) by 320/640 and 211/480,
    // rounded: one column wider than the picture, as layout_pane_scale_about_centre rounds
    expect([pane.left, pane.top, pane.right, pane.bottom]).toEqual([160, 135, 480, 345]);
    const W = defaultCanvas.xMax + 1;
    const H = defaultCanvas.yMax + 1;
    frame(); // state 5 redraws it
    const ref = referenceDecode(jk);
    let mismatches = 0;
    let compared = 0;
    for (let y = 0; y < ref.h; y++) {
      const sy = pane.top + y;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < ref.w; x++) {
        compared++;
        if (defaultCanvas.buffer[sy * W + pane.left + x] !== ref.px[y * ref.w + x]) mismatches++;
      }
    }
    expect(compared).toBe(320 * 211);
    expect(mismatches).toBe(0);
    // the fade ended on the picture's palette (6-bit) for every colour it shows
    const gpal = new Set(ref.px);
    for (const c of gpal) for (let k = 0; k < 3; k++) expect(palettes.dac[c * 3 + k]).toBe(jk[13 + c * 3 + k]! >> 2);

    // state 5 -> 6: vfxhd in the same pane, from its top row
    palettes.dacPlayback.length = 0;
    for (let f = 0; f < 200 && cheatCredits.cheatCreditsState !== 6; f++) frame();
    expect(cheatCredits.cheatCreditsState).toBe(6);
    const hd = files.get('VFX/VFXHD.BIN')!;
    // the fades the host plays back carry the window as each ran: the fade
    // out over vfxjk, the fade in over vfxhd (not the later picture throughout)
    const fades = palettes.dacPlayback;
    expect(fades.length).toBeGreaterThan(2);
    const at = (w: VfxWindow, x: number, y: number) => w.buffer[(pane.top + y) * W + pane.left + x];
    const differs = ref.px.findIndex((v, i) => v !== referenceDecode(hd).px[i]);
    const dx = differs % ref.w;
    const dy = Math.floor(differs / ref.w);
    expect(at(fades[0]!.window, dx, dy)).toBe(ref.px[differs]);
    expect(at(fades[fades.length - 1]!.window, dx, dy)).toBe(referenceDecode(hd).px[differs]);
    expect(cheatCredits.cheatCreditsPicture).toBe(hd);
    frame();
    const ref2 = referenceDecode(hd);
    expect(ref2.h).toBe(200);
    let bad = 0;
    for (let y = 0; y < ref2.h; y++)
      for (let x = 0; x < ref2.w; x++) if (defaultCanvas.buffer[(pane.top + y) * W + pane.left + x] !== ref2.px[y * ref2.w + x]) bad++;
    expect(bad).toBe(0);

    // state 6 -> 7: MENU 3 opened over the picture
    for (let f = 0; f < 200 && cheatCredits.cheatCreditsState !== 7; f++) frame();
    expect(cheatCredits.cheatCreditsState).toBe(7);
    frame();
    expect(uiContextFindNode(3)!.active & 0xff).toBe(1);
    expect(uiContextActiveRecord()).toBe(uiContextFindNode(3)!.record);
    for (let f = 0; f < 20; f++) frame();
    expect(cheatCredits.cheatCreditsState).toBe(7);

    // closing the menu: 0xff, then 0x111 ticks later everything back
    uiContextClearRequest(3);
    frame();
    frame();
    expect(uiContextActiveRecord()).toBeNull();
    expect(cheatCredits.cheatCreditsState).toBe(0xff);
    for (let f = 0; f < 200 && cheatCredits.cheatCreditsState !== 0; f++) frame();
    expect(cheatCredits.cheatCreditsState).toBe(0);
    expect(mainLoop.renderHook).toBe(view);
    expect(cheatCredits.cheatCreditsPicture).toBeNull();
    expect(radar.viewportRestorePending).toBe(0);
    expect(hud.hudEnabled).toBe(1);
    frame();
    expect(mainLoop.renderHook).toBe(view);
  });
});
