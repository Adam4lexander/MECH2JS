// The hand-built cockpits: every design builds round its mech's canopy, its
// screens sit where the flat view and the headset both show them, and it
// leaves the view straight ahead - and through its glass - clear.
import { describe, expect, it } from 'vitest';
import { canopyOf, fittedTris } from '../../src/render/cockpit/canopy.ts';
import { CANOPY } from '../../src/render/cockpit/glass.ts';
import { anglesOf, cropRect, dir, fitRect, Kit, Mat, SCREENS, type V3 } from '../../src/render/cockpit/kit.ts';
import { buildDesign, DESIGNS } from '../../src/render/cockpit/designs/index.ts';

/** Whether the ray from the eye along `d` meets triangle abc (Moller-Trumbore). */
function rayHits(d: V3, a: V3, b: V3, c: V3): boolean {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2]! - d[2] * e2[1]!, d[2] * e2[0]! - d[0] * e2[2]!, d[0] * e2[1]! - d[1] * e2[0]!];
  const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
  if (Math.abs(det) < 1e-12) return false;
  const t0 = [-a[0], -a[1], -a[2]];
  const u = (t0[0]! * p[0]! + t0[1]! * p[1]! + t0[2]! * p[2]!) / det;
  if (u < 0 || u > 1) return false;
  const q = [t0[1]! * e1[2]! - t0[2]! * e1[1]!, t0[2]! * e1[0]! - t0[0]! * e1[2]!, t0[0]! * e1[1]! - t0[1]! * e1[0]!];
  const v = (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!) / det;
  if (v < 0 || u + v > 1) return false;
  return (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det > 0;
}

const tris = (k: Kit) => Array.from({ length: k.pos.length / 9 }, (_, i) => [0, 1, 2].map((j) => k.pos.slice(i * 9 + j * 3, i * 9 + j * 3 + 3) as V3) as [V3, V3, V3]);

describe('cockpit designs', () => {
  it('has a design for every canopy, and a canopy for every design', () => {
    expect(Object.keys(DESIGNS).sort()).toEqual(Object.keys(CANOPY).sort());
  });

  for (const d of Object.values(DESIGNS)) {
    describe(d.name, () => {
      const k = buildDesign(d);

      it('shows all six screens, each once and with all its parts', () => {
        const screens = new Map<number, string>();
        for (const s of k.slots) screens.set(s.screen, s.name);
        expect([...screens.values()].sort()).toEqual(Object.keys(SCREENS).sort());
        for (const [i, name] of screens) expect(k.slots.filter((s) => s.screen === i).map((s) => s.part)).toEqual(SCREENS[name as keyof typeof SCREENS]);
      });

      it('keeps its screens in the flat view and within reach', () => {
        for (const i of new Set(k.slots.map((s) => s.screen))) {
          // the screen's centre: the middle of its parts' corners
          const cs = k.slots.filter((s) => s.screen === i).flatMap((s) => s.corners);
          const s = k.slots.find((q) => q.screen === i)!;
          const c = cs.reduce<V3>((m, p) => [m[0] + p[0] / cs.length, m[1] + p[1] / cs.length, m[2] + p[2] / cs.length], [0, 0, 0]);
          const a = anglesOf(c);
          expect(a.pitch, `${s.name} pitch`).toBeLessThan(-14);
          expect(a.pitch, `${s.name} pitch`).toBeGreaterThan(-34);
          expect(Math.abs(a.yaw), `${s.name} yaw`).toBeLessThan(44);
          expect(a.dist, `${s.name} distance`).toBeGreaterThan(0.4);
          expect(a.dist, `${s.name} distance`).toBeLessThan(0.9);
        }
      });

      it('leaves the view straight ahead clear', () => {
        const hit = tris(k).some(([a, b, c]) => rayHits([0, 0, -1], a, b, c));
        expect(hit).toBe(false);
      });

      it('keeps its glass open: nothing but the canopy frame across it, above the console', () => {
        const glass = canopyOf(CANOPY[d.key]!);
        // every direction 6 degrees apart, from above the console up, with glass 4 degrees all round it (the
        // walls are tiled in 5 cm squares, so the glass's very edge is the wall's); the frame follows the
        // canopy's own edges across it, so its bars are allowed
        const all = tris(k);
        const solid = all.filter((_, i) => k.mat[i * 3] !== Mat.frame);
        const clear = (yaw: number, pitch: number) => [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]].every(([dy, dp]) => glass.sees(dir(yaw + dy!, pitch + dp!, 1)));
        let probes = 0;
        for (let pitch = -8; pitch <= 60; pitch += 6)
          for (let yaw = -60; yaw <= 60; yaw += 6) {
            const v = dir(yaw, pitch, 1);
            if (!clear(yaw, pitch)) continue;
            probes++;
            const blocked = solid.some(([a, b, c]) => rayHits(v, a, b, c));
            expect(blocked, `blocked at ${yaw}, ${pitch}`).toBe(false);
          }
        expect(probes).toBeGreaterThan(10);
      });

      it('colours every face with a known material and a shade on the ramp', () => {
        for (const m of k.mat) expect(m >= Mat.hull && m <= Mat.lampGreen).toBe(true);
        for (const s of k.shade) expect(s >= 0 && s <= 15).toBe(true);
      });
    });
  }
});

describe('screen fitting', () => {
  it('fits a pane whole inside its slot, centred', () => {
    expect(fitRect(1, 1)).toEqual([0, 0, 1, 1]);
    expect(fitRect(2, 1)).toEqual([0, 0.25, 1, 0.75]);
    expect(fitRect(0.5, 1)).toEqual([0.25, 0, 0.75, 1]);
    expect(fitRect(0.5, 1, 'left')).toEqual([0, 0, 0.5, 1]);
    expect(fitRect(2, 1, 'left')).toEqual([0, 0.25, 1, 0.75]);
  });

  it('crops a pane to whole pixels', () => {
    expect(cropRect({ x: 551, y: 313, w: 85, h: 157 }, [0.85, 0.15, 1, 1])).toEqual({ x: 623, y: 337, w: 13, h: 133 });
    expect(cropRect({ x: 10, y: 20, w: 30, h: 40 })).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it("places each screen's parts inside it, clear of each other", () => {
    for (const [name, parts] of Object.entries(SCREENS)) {
      const ps = parts.map((p) => p.place);
      for (const [u0, v0, u1, v1] of ps) {
        expect(u0 >= 0 && v0 >= 0 && u1 <= 1 && v1 <= 1 && u0 < u1 && v0 < v1, name).toBe(true);
      }
      for (let i = 0; i < ps.length; i++)
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i]!;
          const b = ps[j]!;
          expect(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], name).toBe(true);
        }
    }
  });
});

describe('screen layout on a face', () => {
  it('keeps every screen inside the face, clear of the others and of the decor strip', async () => {
    const { layoutScreens } = await import('../../src/render/cockpit/archetypes.ts');
    const { frameAt } = await import('../../src/render/cockpit/kit.ts');
    for (const [w, h, rows] of [
      [0.44, 0.25, [['target', 'radar']]],
      [0.28, 0.25, [['status']]],
      [0.28, 0.25, [['weapons'], ['damage', 'throttle']]],
      [0.42, 0.26, [['target', 'radar']]],
      [0.42, 0.26, [['weapons', 'throttle'], ['damage', 'status']]],
    ] as const) {
      const k = new Kit();
      const f = frameAt([0, 0, -1], [0, 0, 1]);
      const l = layoutScreens(k, { f, w, h }, rows.map((r) => [...r]));
      // each screen's glass: the extent of its parts' pieces
      const rects = [...new Set(k.slots.map((s) => s.screen))].map((i) => {
        const cs = k.slots.filter((s) => s.screen === i).flatMap((s) => s.corners);
        const xs = cs.map((c) => c[0]);
        const ys = cs.map((c) => c[1]);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      });
      expect(rects.length).toBe(rows.flat().length);
      for (const r of rects) {
        // the screen and its bezel (12 mm round it) on the face
        expect(r.x0 - 0.012).toBeGreaterThanOrEqual(-w / 2);
        expect(r.x1 + 0.012).toBeLessThanOrEqual(w / 2);
        // below the top trim (topTrim: 7 to 11 mm down)
        expect(r.y1 + 0.012).toBeLessThanOrEqual(h / 2 - 0.012);
        // above the decor strip
        expect(r.y0).toBeGreaterThan(l.decorY + 0.015);
      }
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]!;
          const b = rects[j]!;
          const apart = a.x1 <= b.x0 + 1e-9 || b.x1 <= a.x0 + 1e-9 || a.y1 <= b.y0 + 1e-9 || b.y1 <= a.y0 + 1e-9;
          expect(apart).toBe(true);
        }
    }
  });
});

describe('canopies', () => {
  it('see glass straight ahead, for every chassis', () => {
    for (const [key, src] of Object.entries(CANOPY)) expect(canopyOf(src).sees([0, 0, -1]), key).toBe(true);
  });

  it('are seated as their fit says', () => {
    const quad = [-1, 0, -1, 1, 0, -1, 1, 1, -2, -1, 0, -1, 1, 1, -2, -1, 1, -2];
    // lifted 0.5 along the area-weighted normal (the plane y - z = 1, normal (0, 1, 1) / sqrt 2 as wound)
    const lifted = fittedTris({ tris: quad, fit: { normal: 0.5 } });
    const n = Math.SQRT1_2 * 0.5;
    expect(lifted[1]).toBeCloseTo(n, 5);
    expect(lifted[2]).toBeCloseTo(-1 + n, 5);
    expect(Array.from(fittedTris({ tris: quad, fit: { move: [1, 2, 3] } })).slice(0, 3)).toEqual([0, 2, 2]);
    // grown about its centre: the centre stays, the corners move out
    const grown = fittedTris({ tris: quad, fit: { grow: 2 } });
    const centre = (t: Float32Array, c: number) => t.filter((_, i) => i % 3 === c).reduce((s, v) => s + v, 0) / (t.length / 3);
    for (const c of [0, 1, 2]) expect(centre(grown, c)).toBeCloseTo(centre(Float32Array.from(quad), c), 5);
    expect(grown[0]).toBeCloseTo(-2, 5);
    expect(fittedTris({ tris: quad, fit: { bridge: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }).length).toBe(27);
  });

  it('frame a flat pane round its outline, and a folded one along its fold too', () => {
    const pane = canopyOf({ tris: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1] });
    expect(pane.edges.filter((e) => e.boundary).length).toBe(4);
    expect(pane.edges.filter((e) => !e.boundary).length).toBe(0);
    // two panes meeting at 90 degrees along x = 0
    const folded = canopyOf({ tris: [-1, -1, -1, 0, -1, -2, 0, 1, -2, -1, -1, -1, 0, 1, -2, -1, 1, -1, 0, -1, -2, 1, -1, -1, 1, 1, -1, 0, -1, -2, 1, 1, -1, 0, 1, -2] });
    expect(folded.edges.filter((e) => !e.boundary).length).toBe(1);
    expect(canopyOf({ tris: [-1, -1, -1, 0, -1, -2, 0, 1, -2, -1, -1, -1, 0, 1, -2, -1, 1, -1, 0, -1, -2, 1, -1, -1, 1, 1, -1, 0, -1, -2, 1, 1, -1, 0, 1, -2], fit: { outlineOnly: true } }).edges.filter((e) => !e.boundary).length).toBe(0);
  });

  it('reach as far as the glass goes: a pane 45 degrees either side reaches 45', () => {
    const pane = canopyOf({ tris: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1] });
    expect(pane.right).toBe(45);
    expect(pane.left).toBe(45);
    expect(pane.up).toBe(45);
    expect(pane.down).toBe(45);
  });
});
