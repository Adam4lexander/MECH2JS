// The detail enhancements' pure parts: every index they choose stays in the
// palette's own ramps, and the cockpit's screens come from the widget panes.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { copyDrawWords, groundFade, groundLevel } from '../../src/render/enhance/groundField.ts';
import { NOT_DRAWN } from '../../src/render/materials/indexedMaterial.ts';
import type { MeshEntry } from '../../src/render/SceneRenderer.ts';
import { shadowTable } from '../../src/render/enhance/shadows.ts';
import { skyPaletteChoice } from '../../src/render/enhance/skyDetail.ts';
import { commonRamps, slotPanes } from '../../src/render/cockpit/cockpit.ts';
import { groundShades, hueRun, luminance, sameHue } from '../../src/render/enhance/paletteRuns.ts';

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
  it('keeps every vertex on a shade level 0..4, and on the ground colour itself (2) at no fade', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: -5000, max: 5000 }), fc.double({ min: 0, max: 1, noNaN: true }), (x, z, fade) => {
        const l = groundLevel(x, z, fade);
        expect(Number.isInteger(l) && l >= 0 && l <= 4).toBe(true);
        expect(groundLevel(x, z, 0)).toBe(2);
      }),
    );
  });

  it("finds the ground's shades anywhere in the palette, not in its row: 0xef ends its row, beside other hues", () => {
    const rgb = new Uint8Array(768);
    // the ground: a brown at the end of row 0xe0, whose other colours are blues
    rgb.set([20, 14, 8], 0xef * 3);
    for (let k = 0; k < 15; k++) rgb.set([4, 10, 30 + k], (0xe0 + k) * 3);
    // its shades elsewhere, in row 0x60
    const at = (i: number, c: number[]) => rgb.set(c, i * 3);
    at(0x60, [16, 11, 6]);
    at(0x61, [18, 13, 7]);
    at(0x62, [22, 15, 9]);
    at(0x63, [24, 17, 10]);
    expect(groundShades(rgb, 0xef)).toEqual([0x60, 0x61, 0xef, 0x62, 0x63]);
  });

  it('never takes another hue, even among near-blacks (JACKSCN1: a blue beside its dark brown ground)', () => {
    const rgb = new Uint8Array(768).fill(40);
    rgb.set([4, 2, 0], 0xef * 3);
    rgb.set([1, 5, 8], 0xed * 3);
    rgb.set([1, 5, 9], 0xee * 3);
    const s = groundShades(rgb, 0xef);
    expect(s).not.toContain(0xed);
    expect(s).not.toContain(0xee);
  });

  it('runs dark to light, and leaves the ground flat in a palette with no shades of it', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 768, maxLength: 768 }), fc.integer({ min: 0, max: 254 }), (bytes, g) => {
        const rgb = bytes.map((v) => v & 63);
        const s = groundShades(rgb, g);
        expect(s[2]).toBe(g);
        for (let i = 1; i < 5; i++) expect(luminance(rgb, s[i]!)).toBeGreaterThanOrEqual(luminance(rgb, s[i - 1]!));
      }),
    );
    const flat = new Uint8Array(768).fill(20);
    expect(groundShades(flat, 0xef)).toEqual([0xef, 0xef, 0xef, 0xef, 0xef]);
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

describe("the scrounge field's copies", () => {
  // one quad (a fan of 2 triangles, slots for 3) that is also a sprite (6 slots after the fan)
  const SPRITE = 0x3005;
  const src = {
    block: { polygonCount: 1, polygons: [{ vertexCount: 4 }] },
    draw: new Float32Array(15).fill(NOT_DRAWN),
    polyStart: Int32Array.of(0),
    polyTris: Int32Array.of(3),
    spriteStart: Int32Array.of(9),
  } as unknown as Pick<MeshEntry, 'block' | 'draw' | 'polyStart' | 'polyTris' | 'spriteStart'>;
  const fan = new Float32Array(1).fill(NOT_DRAWN);
  const sprite = new Float32Array(1).fill(NOT_DRAWN);
  const out = new Float32Array(15).fill(NOT_DRAWN);
  const draw = (fanWord: number, tris: number, spriteWord: number) => {
    src.draw.fill(NOT_DRAWN);
    src.draw.fill(fanWord, 0, tris * 3);
    src.draw.fill(spriteWord, 9, 15);
  };
  const words = () => [...new Set(out.subarray(0, 9))].concat([...new Set(out.subarray(9))]);

  it('drop the black fans enhanced imaging drew once it ends', () => {
    draw(NOT_DRAWN, 0, SPRITE);
    expect(copyDrawWords(src, fan, sprite, out)).toBe(true);
    expect(words()).toEqual([NOT_DRAWN, SPRITE]);
    // enhanced imaging: filled black (word 0) and outlined; no sprite
    draw(0, 2, NOT_DRAWN);
    expect(copyDrawWords(src, fan, sprite, out)).toBe(true);
    expect([...out.subarray(0, 6)]).toEqual(Array(6).fill(0));
    expect([...out.subarray(6)]).toEqual(Array(9).fill(NOT_DRAWN));
    // and off again: the sprite, and no fan under it
    draw(NOT_DRAWN, 0, SPRITE);
    expect(copyDrawWords(src, fan, sprite, out)).toBe(true);
    expect(words()).toEqual([NOT_DRAWN, SPRITE]);
  });

  it('keep what they had while the game does not draw the patch, and draw the whole fan of a clipped one', () => {
    draw(NOT_DRAWN, 0, NOT_DRAWN);
    expect(copyDrawWords(src, fan, sprite, out)).toBe(false);
    expect(words()).toEqual([NOT_DRAWN, SPRITE]);
    // near-clipped to one triangle in the game's view: the copies are unclipped, so both of theirs are drawn
    draw(0x44f0, 1, NOT_DRAWN);
    expect(copyDrawWords(src, fan, sprite, out)).toBe(true);
    expect([...out.subarray(0, 9)]).toEqual([...Array(6).fill(0x44f0), NOT_DRAWN, NOT_DRAWN, NOT_DRAWN]);
    expect(copyDrawWords(src, fan, sprite, out)).toBe(false);
  });
});
