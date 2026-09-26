// The message bars (message_post, message_bar_layout, message_bar_draw) on
// the shipped art at 640x480: where the start-up layout puts the two bars,
// the bar and its text in the window after a frame, the time a message
// shows for, and which slot a new message takes. The layout is recomputed
// here from the image's fractions and the shape's own size with plain
// arithmetic, and the drawn bar compared with the shape walked by the SHP
// parser - neither goes through the port's layout or VFX code.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { parseFont, glyphOffset, glyphWidth } from '../../src/data/formats/font.ts';
import { parseShapeTable, walkShape } from '../../src/data/formats/shp.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { simStopwatchElapsed } from '../../src/engine/clock.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { messagePost, messages } from '../../src/sim/cockpit/messages.ts';
import { defaultCanvas, display } from '../../src/sim/display/video.ts';
import { sound } from '../../src/sim/sound/mixer.ts';
import { soundCuePlay } from '../../src/sim/sound/voice.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

function boot() {
  bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
}

/** a * b / 65536 rounded half up - the 16.16 multiply the layout uses */
const r16 = (a: number, b: number) => Math.floor((a * b) / 65536 + 0.5);

describe.runIf(hasGameData)('message bars', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('lays the two bars out along the top and the bottom of the screen', () => {
    boot();
    const W = defaultCanvas.xMax + 1;
    const H = defaultCanvas.yMax + 1;
    const shp = parseShapeTable(prj.readResource('SHP', display.assetVariant + 0x4c)!).shapes[0]!;
    const bw = shp.word0 >>> 16;
    const bh = shp.word0 & 0xffff;
    // the whole screen, fitted about its centre to the shape's size
    const sx = Math.trunc((bw * 65536) / W);
    const sy = Math.trunc((bh * 65536) / H);
    const cx = W >> 1;
    const cy = H >> 1;
    const left = r16(-cx, sx) + cx;
    const right = r16(W - 1 - cx, sx) + cx;
    const top = r16(-cy, sy) + cy;
    const bottom = r16(H - 1 - cy, sy) + cy;
    const [a, b] = messages.messageSlots.map((s) => s.pane!);
    expect([a!.left, a!.top, a!.right, a!.bottom]).toEqual([0, 0, right - left, bottom - top]);
    expect([b!.left, b!.top, b!.right, b!.bottom]).toEqual([0, 2 * top, right - left, bottom + top]);
    // the bottom bar's pane ends one row past the screen: its top margin (top) is one more than the bottom one
    expect(b!.bottom).toBe(H);
    const font = parseFont(prj.readResource('FONT', display.assetVariant + 1)!);
    for (const s of messages.messageSlots) {
      expect(s.textX).toBe(r16(s.pane!.right - s.pane!.left, 0x28f));
      expect(s.textY).toBe(Math.trunc((s.pane!.bottom - s.pane!.top + 1 - font.height) / 2));
    }
  });

  it('draws the bar and its text after the HUD, until the time is up', () => {
    boot();
    for (let f = 0; f < 5; f++) frame();
    const text = 'Ammo for current weapon jettisonned.';
    expect(messagePost(text, 1, 0x16c, 0x32)).toBe(1);
    const s = messages.messageSlots[0]!;
    expect([s.inUse, s.priority, s.fontId, s.text]).toEqual([1, 0x32, 1, text]);
    expect(s.endTick).toBe(simStopwatchElapsed() + 0x16c);
    frame();
    const pitch = defaultCanvas.xMax + 1;
    const pane = s.pane!;
    const font = parseFont(prj.readResource('FONT', display.assetVariant + s.fontId)!);
    let textEnd = s.textX;
    for (const ch of text) textEnd += glyphWidth(font, ch.charCodeAt(0));
    // the bar: every pixel the shape draws, inside the pane and clear of the text's columns
    const t = parseShapeTable(prj.readResource('SHP', display.assetVariant + s.shpId)!);
    const sh = t.shapes[0]!;
    let compared = 0;
    walkShape(t, 0, (row, x0, count, run, src, at) => {
      const y = pane.top + sh.ymin + row;
      if (y > Math.min(pane.bottom, defaultCanvas.yMax)) return;
      for (let i = 0; i < count; i++) {
        const x = pane.left + sh.xmin + x0 + i;
        if (x > pane.right || (x >= s.textX && x < textEnd)) continue;
        expect(defaultCanvas.buffer[y * pitch + x], `bar pixel ${x},${y}`).toBe(run ? src[at] : src[at + i]);
        expect(defaultCanvas.drawn[y * pitch + x]).toBe(1);
        compared++;
      }
    });
    expect(compared).toBeGreaterThan(1000);
    // the first glyph, through the text colour table (0xff is not written)
    const g = glyphOffset(font, text.charCodeAt(0)) + 4;
    const gw = glyphWidth(font, text.charCodeAt(0));
    let ink = 0;
    for (let row = 0; row < font.height; row++) {
      for (let i = 0; i < gw; i++) {
        const c = display.textColourTable[font.bytes[g + row * gw + i]!]!;
        if (c === 0xff) continue;
        expect(defaultCanvas.buffer[(pane.top + s.textY + row) * pitch + pane.left + s.textX + i]).toBe(c);
        ink++;
      }
    }
    expect(ink).toBeGreaterThan(0);
    // shown while the stopwatch is below endTick, freed the frame it is not
    while (simStopwatchElapsed() + 7 < s.endTick) frame();
    expect(s.inUse).toBe(1);
    frame();
    frame();
    expect(s.inUse).toBe(0);
  });

  it('takes an empty slot, else the lowest priority not above its own, the later-ending of equals', () => {
    boot();
    const [a, b] = messages.messageSlots;
    expect(messagePost('one', 1, 0x100, 0x32)).toBe(1);
    expect(messagePost('two', 1, 0x200, 0x32)).toBe(1);
    expect([a!.text, b!.text]).toEqual(['one', 'two']);
    // both busy at 0x32: a lower priority is refused
    expect(messagePost('low', 1, 0x16c, 0x10)).toBe(0);
    // an equal one replaces the slot that ends later
    expect(messagePost('three', 1, 0x16c, 0x32)).toBe(1);
    expect([a!.text, b!.text]).toEqual(['one', 'three']);
    // a higher one replaces the lowest-priority slot
    b!.priority = 0x50;
    expect(messagePost('four', 1, 0x16c, 100)).toBe(1);
    expect([a!.text, b!.text]).toEqual(['four', 'three']);
    expect(a!.priority).toBe(100);
    // text is cut at 0xff bytes; a font below 1 becomes 1
    a!.inUse = 0;
    expect(messagePost('x'.repeat(300), 0, 0x16c, 0x32)).toBe(1);
    expect([a!.text!.length, a!.fontId]).toEqual([0xff, 1]);
  });

  it('shows a voice line as text in font 1 when speech is off', () => {
    boot();
    sound.soundConfig[4] = sound.soundConfig[4]! & ~2;
    soundCuePlay(0, -1);
    const s = messages.messageSlots[0]!;
    expect(s.inUse).toBe(1);
    expect(s.text).not.toBe('');
    expect([s.fontId, s.priority, s.endTick - simStopwatchElapsed()]).toEqual([1, 0x32, 0x71c]);
  });
});
