// The detail enhancements' pure parts: every index they choose stays in the
// palette's own ramps, and the cockpit's screens come from the widget panes.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { groundFade, groundIndex } from '../../src/render/enhance/groundField.ts';
import { shadowTable } from '../../src/render/enhance/shadows.ts';
import { skyPaletteChoice } from '../../src/render/enhance/skyDetail.ts';
import { commonRamps, slotPanes } from '../../src/render/cockpit/cockpit.ts';
import { hueRun, sameHue } from '../../src/render/enhance/paletteRuns.ts';

/** A palette whose ramps run dark to light (6-bit DAC), one hue per ramp. */
function rampPalette(scale = 1): Uint8Array {
  const rgb = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const v = Math.round(((i & 15) / 15) * 63 * scale);
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = (i >> 4) & 1 ? v : v >> 1;
    rgb[i * 3 + 2] = v;
  }
  return rgb;
}

describe('ground', () => {
  it("keeps every vertex inside the ground colour's hue run, and on the colour itself at no fade", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 253 }), fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: -5000, max: 5000 }), fc.double({ min: 0, max: 1, noNaN: true }), (g, x, z, fade) => {
        const run: [number, number] = [g - 1, g + 2];
        const i = groundIndex(g, x, z, fade, run);
        expect(i).toBeGreaterThanOrEqual(run[0]);
        expect(i).toBeLessThanOrEqual(run[1]);
        expect(groundIndex(g, x, z, 0, run)).toBe(g);
      }),
    );
  });

  it("stops a colour's run where its row turns another hue (PLUMSCN1's greens beside the lakes' teal)", () => {
    const rgb = rampPalette();
    // row 0x30: greens at 0x30..0x37, teal from 0x38
    for (let k = 0; k < 16; k++) {
      const c = 6 + 3 * (k & 7);
      rgb.set(k < 8 ? [Math.round(c * 0.35), c, Math.round(c * 0.25)] : [Math.round(c * 0.3), c, c], (0x30 + k) * 3);
    }
    expect(hueRun(rgb, 0x34)).toEqual([0x30, 0x37]);
    expect(sameHue(rgb, 0x34, 0x3a)).toBe(false);
  });

  it('fades out with distance from the eye, gone well inside the grid', () => {
    expect(groundFade(0)).toBe(1);
    expect(groundFade(12)).toBe(1);
    expect(groundFade(36)).toBe(0);
    expect(groundFade(40)).toBe(0);
    expect(groundFade(30)).toBeLessThan(groundFade(20));
  });
});

describe('shadows', () => {
  it('darkens every index to a colour of its own hue, never brightening', () => {
    const rgb = rampPalette();
    const t = shadowTable(rgb);
    const lum = (i: number) => 0.3 * rgb[i * 3]! + 0.59 * rgb[i * 3 + 1]! + 0.11 * rgb[i * 3 + 2]!;
    for (let i = 0; i < 255; i++) {
      expect(lum(t[i]!)).toBeLessThanOrEqual(lum(i));
      expect(sameHue(rgb, i, t[i]!), `index ${i} -> ${t[i]}`).toBe(true);
    }
    expect(t[0xff]).toBe(0xff);
    // a bright colour lands about halfway down its ramp
    expect(t[0x2f]! & 15).toBeGreaterThanOrEqual(6);
    expect(t[0x2f]! & 15).toBeLessThanOrEqual(10);
  });
});

describe('sky', () => {
  it('takes the zenith up to three steps along the sky ramp, towards its darker end', () => {
    const c = skyPaletteChoice(rampPalette(), 0x5a);
    expect(c.top).toBe(0x57);
    expect(skyPaletteChoice(rampPalette(), 0x51).top).toBe(0x50);
  });

  it('has stars only under a dark sky', () => {
    expect(skyPaletteChoice(rampPalette(), 0x5a).star).toBe(-1);
    const night = rampPalette();
    // a dark sky, and one near-white index
    night.set([4, 4, 6], 0x52 * 3);
    night.set([60, 60, 60], 0x7f * 3);
    expect(skyPaletteChoice(night, 0x52).star).toBeGreaterThan(0);
  });
});

describe('cockpit screens', () => {
  it('take the radar, damage display, weapon list, target display and readout panes', () => {
    const rects: Record<number, { x: number; y: number; w: number; h: number }> = {
      0: { x: 10, y: 10, w: 100, h: 90 },
      2: { x: 10, y: 300, w: 80, h: 120 },
      3: { x: 500, y: 20, w: 120, h: 12 },
      7: { x: 500, y: 80, w: 130, h: 12 },
      13: { x: 480, y: 300, w: 140, h: 100 },
      14: { x: 480, y: 400, w: 140, h: 30 },
    };
    const p = slotPanes((i) => rects[i] ?? null);
    expect(p.radar).toEqual(rects[0]);
    expect(p.damage).toEqual(rects[2]);
    expect(p.weapons).toEqual({ x: 500, y: 20, w: 130, h: 72 });
    expect(p.target).toEqual(rects[13]);
    expect(p.readout).toEqual(rects[14]);
    expect(p.heat).toBeNull();
    expect(Object.values(slotPanes(() => null)).every((v) => v === null)).toBe(true);
  });

  it('are coloured in the ramps the cockpit shell uses, most used first', () => {
    expect(commonRamps([0x1043, 0x4045, 0x40c2, 0x4047, 0x5010, -1])).toEqual([0x40, 0xc0]);
    expect(commonRamps([-1, 0x3000, 0x5012])).toEqual([]);
  });
});
