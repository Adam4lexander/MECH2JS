// The VFX 2D routines against models of the original's code.
//
// vfx_line_draw: the port draws the unclipped line's pixels that fall inside
// the clip rectangle; the original clips Cohen-Sutherland style with sixteen
// crossing cases and then steps a 0.32 fraction. lineModel below is that
// original, transcribed from the disassembly case by case (0x53946..0x54209),
// and the two must agree on every pixel and on the return code.
//
// vfx_shape_draw / vfx_character_draw: against a brute-force decode of the
// same bytes clipped per pixel.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ViewWindow } from '../../src/generated/classes.gen.ts';
import {
  VfxWindow,
  vfxCharacterDraw,
  vfxLineDraw,
  vfxPaneWipe,
  vfxShapeDraw,
  vfxShapeSize,
  vfxStringDraw,
  vfxWindowAllocate,
  vfxWindowClear,
} from '../../src/engine/vfx/vfx.ts';

const W = 64;
const H = 48;

function makeWindow(): VfxWindow {
  const w = new VfxWindow();
  vfxWindowAllocate(w, W, H);
  return w;
}

function pane(win: VfxWindow, l: number, t: number, r: number, b: number): ViewWindow {
  const p = new ViewWindow();
  p.canvas = win;
  p.left = l;
  p.top = t;
  p.right = r;
  p.bottom = b;
  return p;
}

function drawnSet(win: VfxWindow): Set<number> {
  const s = new Set<number>();
  win.drawn.forEach((d, i) => d && s.add(i));
  return s;
}

/** The original's clipper and stepper, for mode 0, returning drawn pixel indices and the return code. */
function lineModel(cl: number, ct: number, cr: number, cb: number, x0: number, y0: number, x1: number, y1: number): { px: Set<number>; ret: number } {
  const px = new Set<number>();
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0 || dy === 0) throw new Error('axis-aligned lines are not modelled');
  const sgnx = dx < 0 ? -1 : 0;
  const sgny = dy < 0 ? -1 : 0;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const s = sgnx ^ sgny;
  const slope = adx === ady ? 0xffffffff : Math.floor((Math.min(adx, ady) * 2 ** 32) / Math.max(adx, ady));
  const hi = (k: number) => Math.floor((k * slope + 2 ** 31) / 2 ** 32); // mul; add 0x80000000; adc; take edx
  const ceilDiv = (k: number) => {
    // edx:eax = k:0x80000000, div slope, then sbb eax,-1 (+1 unless exact)
    const n = k * 2 ** 32 + 2 ** 31;
    const q = Math.floor(n / slope);
    return q + (n - q * slope !== 0 ? 1 : 0);
  };
  const floorDiv = (k: number) => {
    // sbb eax,0: -1 when exact
    const n = k * 2 ** 32 + 2 ** 31;
    const q = Math.floor(n / slope);
    return q - (n - q * slope === 0 ? 1 : 0);
  };
  const signed = (neg: boolean, v: number) => (neg ? -v : v);
  let X0 = x0;
  let Y0 = y0;
  let X1 = x1;
  let Y1 = y1;
  const code = (x: number, y: number) => (x < cl ? 8 : 0) | (x > cr ? 4 : 0) | (y < ct ? 2 : 0) | (y > cb ? 1 : 0);
  let any = 0;
  for (let guard = 0; ; guard++) {
    if (guard > 20) throw new Error('clipper did not settle');
    const dl = code(X0, Y0);
    const dh = code(X1, Y1);
    any |= dl | dh;
    if (!dl && !dh) break;
    if (dl & dh) return { px, ret: 2 };
    if (adx >= ady) {
      if (dl & 8) { X0 = cl; Y0 = y0 + signed(s !== 0, hi(cl - x0)); }
      else if (dl & 4) { X0 = cr; Y0 = y0 + signed(s === 0, hi(x0 - cr)); }
      else if (dl & 2) { Y0 = ct; X0 = x0 + signed(s !== 0, ceilDiv(ct - y0 - 1)); }
      else if (dl & 1) { Y0 = cb; X0 = x0 + signed(s === 0, ceilDiv(y0 - cb - 1)); }
      else if (dh & 8) { X1 = cl; Y1 = y0 + signed(s === 0, hi(x0 - cl)); }
      else if (dh & 4) { X1 = cr; Y1 = y0 + signed(s !== 0, hi(cr - x0)); }
      else if (dh & 2) { Y1 = ct; X1 = x0 + signed(s === 0, floorDiv(y0 - ct)); }
      else { Y1 = cb; X1 = x0 + signed(s !== 0, floorDiv(cb - y0)); }
    } else {
      if (dl & 8) { X0 = cl; Y0 = y0 + signed(s !== 0, ceilDiv(cl - x0 - 1)); }
      else if (dl & 4) { X0 = cr; Y0 = y0 + signed(s === 0, ceilDiv(x0 - cr - 1)); }
      else if (dl & 2) { Y0 = ct; X0 = x0 + signed(s !== 0, hi(ct - y0)); }
      else if (dl & 1) { Y0 = cb; X0 = x0 + signed(s === 0, hi(y0 - cb)); }
      else if (dh & 8) { X1 = cl; Y1 = y0 + signed(s === 0, floorDiv(x0 - cl)); }
      else if (dh & 4) { X1 = cr; Y1 = y0 + signed(s !== 0, floorDiv(cr - x0)); }
      else if (dh & 2) { Y1 = ct; X1 = x0 + signed(s === 0, hi(y0 - ct)); }
      else { Y1 = cb; X1 = x0 + signed(s !== 0, hi(cb - y0)); }
    }
  }
  const sx = sgnx ? -1 : 1;
  const sy = sgny ? -1 : 1;
  let x = X0;
  let y = Y0;
  if (adx === ady) {
    for (let n = Math.abs(X1 - X0) + 1; n > 0; n--, x += sx, y += sy) px.add(y * W + x);
  } else if (adx < ady) {
    let frac = (Math.abs(Y0 - y0) * slope + 2 ** 31) % 2 ** 32;
    for (let n = Math.abs(Y1 - Y0) + 1; n > 0; n--) {
      px.add(y * W + x);
      frac += slope;
      if (frac >= 2 ** 32) { frac -= 2 ** 32; x += sx; }
      y += sy;
    }
  } else {
    let frac = (Math.abs(X0 - x0) * slope + 2 ** 31) % 2 ** 32;
    for (let n = Math.abs(X1 - X0) + 1; n > 0; n--) {
      px.add(y * W + x);
      frac += slope;
      if (frac >= 2 ** 32) { frac -= 2 ** 32; y += sy; }
      x += sx;
    }
  }
  return { px, ret: any ? 1 : 0 };
}

describe('vfx_line_draw', () => {
  it('draws exactly the pixels the original clipper and stepper draw', () => {
    const win = makeWindow();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: W - 1 }),
        fc.integer({ min: 0, max: H - 1 }),
        fc.integer({ min: 0, max: W - 1 }),
        fc.integer({ min: 0, max: H - 1 }),
        fc.integer({ min: -80, max: 140 }),
        fc.integer({ min: -80, max: 130 }),
        fc.integer({ min: -80, max: 140 }),
        fc.integer({ min: -80, max: 130 }),
        (a, b, c, d, x0, y0, x1, y1) => {
          if (x0 === x1 || y0 === y1) return;
          const cl = Math.min(a, c);
          const cr = Math.max(a, c);
          const ct = Math.min(b, d);
          const cb = Math.max(b, d);
          vfxWindowClear(win);
          const ret = vfxLineDraw(pane(win, cl, ct, cr, cb), x0 - cl, y0 - ct, x1 - cl, y1 - ct, 0, 7);
          const want = lineModel(cl, ct, cr, cb, x0, y0, x1, y1);
          expect([...drawnSet(win)].sort((p, q) => p - q)).toEqual([...want.px].sort((p, q) => p - q));
          expect(ret).toBe(want.ret);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('clamps vertical and horizontal lines and returns 2 when they miss', () => {
    const win = makeWindow();
    const p = pane(win, 10, 10, 20, 20);
    expect(vfxLineDraw(p, 5, -30, 5, 30, 0, 3)).toBe(0);
    expect([...drawnSet(win)]).toEqual(Array.from({ length: 11 }, (_, i) => (10 + i) * W + 15));
    vfxWindowClear(win);
    expect(vfxLineDraw(p, 11, 0, 11, 5, 0, 3)).toBe(2);
    expect(vfxLineDraw(p, -2, 3, 40, 3, 0, 3)).toBe(0);
    expect(drawnSet(win).size).toBe(11);
  });

  it('gives -1 for an empty window and -2 for an empty pane', () => {
    const win = makeWindow();
    expect(vfxLineDraw(pane(new VfxWindow(), 0, 0, 5, 5), 0, 0, 3, 4, 0, 1)).toBe(-1);
    expect(vfxLineDraw(pane(win, 70, 0, 80, 5), 0, 0, 3, 4, 0, 1)).toBe(-2);
  });
});

/** A one-shape SHP table: rows of tokens, rectangle xmin..xmax, ymin..ymax. */
function shapeTable(xmin: number, ymin: number, xmax: number, ymax: number, rows: number[][]): Uint8Array {
  const body = rows.flatMap((r) => [...r, 0]);
  const b = new Uint8Array(0x10 + 0x18 + body.length);
  const dv = new DataView(b.buffer);
  b.set([0x31, 0x2e, 0x31, 0x30]);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, 0x10, true);
  dv.setInt32(0x10 + 8, xmin, true);
  dv.setInt32(0x10 + 0xc, ymin, true);
  dv.setInt32(0x10 + 0x10, xmax, true);
  dv.setInt32(0x10 + 0x14, ymax, true);
  b.set(body, 0x28);
  return b;
}

describe('vfx_shape_draw', () => {
  // 6 x 3: row 0 skip 1, run 3 of 5; row 1 string 9 8 7 6 5 4; row 2 skip 5, string 2 (colour 0 drawn)
  const t = shapeTable(-2, -1, 3, 1, [[1, 1, 6, 5], [13, 9, 8, 7, 6, 5, 4], [1, 5, 3, 0]]);
  const want = (ox: number, oy: number, cl: number, ct: number, cr: number, cb: number) => {
    const m = new Map<number, number>();
    const put = (x: number, y: number, c: number) => {
      if (x >= cl && x <= cr && y >= ct && y <= cb) m.set(y * W + x, c);
    };
    for (let i = 0; i < 3; i++) put(ox - 2 + 1 + i, oy - 1, 5);
    [9, 8, 7, 6, 5, 4].forEach((c, i) => put(ox - 2 + i, oy, c));
    put(ox - 2 + 5, oy + 1, 0);
    return m;
  };

  it('draws the token stream wholly inside, clipped, and not at all outside', () => {
    const win = makeWindow();
    for (const [x, y, l, tp, r, b] of [
      [10, 10, 0, 0, 63, 47],
      [1, 1, 0, 0, 63, 47],
      [20, 20, 19, 20, 21, 20],
      [5, 5, 4, 3, 30, 30],
    ] as const) {
      vfxWindowClear(win);
      const p = pane(win, l, tp, r, b);
      expect(vfxShapeDraw(p, t, 0, x - l, y - tp)).toBe(0);
      const m = want(x, y, Math.max(l, 0), Math.max(tp, 0), Math.min(r, W - 1), Math.min(b, H - 1));
      expect([...drawnSet(win)].sort((a, c) => a - c)).toEqual([...m.keys()].sort((a, c) => a - c));
      for (const [i, c] of m) expect(win.buffer[i]).toBe(c);
    }
    vfxWindowClear(win);
    expect(vfxShapeDraw(pane(win, 0, 0, 10, 10), t, 0, 40, 5)).toBe(-3);
    expect(drawnSet(win).size).toBe(0);
    expect(vfxShapeSize(t, 0)).toBe((6 << 16) | 3);
  });
});

/** A font of height 2 whose glyph 'A' is 3 wide: 0xff background, 14 ink. */
function font(): Uint8Array {
  const b = new Uint8Array(0x10 + 128 * 4 + 4 + 6 + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 2, true);
  const empty = 0x10 + 128 * 4;
  for (let i = 0; i < 128; i++) dv.setUint32(0x10 + i * 4, empty + 4 + 6, true);
  dv.setUint32(0x10 + 65 * 4, empty, true);
  dv.setUint32(empty, 3, true);
  b.set([14, 0xff, 14, 0xff, 14, 0xff], empty + 4);
  return b;
}

describe('vfx_character_draw / vfx_string_draw', () => {
  it('maps glyph bytes through the colour table, skips 0xff and returns the full width when clipped', () => {
    const win = makeWindow();
    const table = Uint8Array.from({ length: 256 }, (_, i) => i);
    table[14] = 42;
    const f = font();
    const p = pane(win, 10, 10, 11, 30);
    expect(vfxCharacterDraw(p, 0, 0, f, 65, table)).toBe(3);
    // columns 10..11 only; row 0 has ink at 0 and 2, row 1 at 1
    expect([...drawnSet(win)].sort((a, c) => a - c)).toEqual([10 * W + 10, 11 * W + 11]);
    expect(win.buffer[10 * W + 10]).toBe(42);
    vfxWindowClear(win);
    vfxStringDraw(pane(win, 0, 0, 63, 47), 1, 1, f, 'AA', table);
    expect([...drawnSet(win)].sort((a, c) => a - c)).toEqual([W + 1, W + 3, W + 4, W + 6, 2 * W + 2, 2 * W + 5]);
  });

  it('copies every byte without a colour table', () => {
    const win = makeWindow();
    vfxCharacterDraw(pane(win, 0, 0, 63, 47), 0, 0, font(), 65, null);
    expect(drawnSet(win).size).toBe(6);
    expect(win.buffer[1]).toBe(0xff);
  });
});

describe('vfx_pane_wipe', () => {
  it('fills the pane clipped to the window', () => {
    const win = makeWindow();
    expect(vfxPaneWipe(pane(win, 60, 45, 70, 50), 9)).toBe(0);
    expect(drawnSet(win).size).toBe(4 * 3);
  });
});
