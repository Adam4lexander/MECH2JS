/**
 * A chassis's canopy (glass.ts) as a design builds round it: its exterior's
 * glass seated about the eye (fit), whether the eye sees glass in a given
 * direction, the edges its frame follows, and how far it reaches from
 * straight ahead.
 *
 * @portOnly
 */
import type { CanopySource } from './glass.ts';
import { dir, type Glass, type V3 } from './kit.ts';

/** facets meeting at more than this (degrees) are framed along their shared edge */
const CREASE = 10;

/** The ray from the eye along `d` against triangle abc (Moller-Trumbore): whether it meets it ahead. */
function rayHits(d: V3, t: Float32Array, i: number): boolean {
  const ax = t[i]!, ay = t[i + 1]!, az = t[i + 2]!;
  const e1x = t[i + 3]! - ax, e1y = t[i + 4]! - ay, e1z = t[i + 5]! - az;
  const e2x = t[i + 6]! - ax, e2y = t[i + 7]! - ay, e2z = t[i + 8]! - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const u = (-ax * px - ay * py - az * pz) / det;
  if (u < 0 || u > 1) return false;
  const qx = -ay * e1z + az * e1y, qy = -az * e1x + ax * e1z, qz = -ax * e1y + ay * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
  if (v < 0 || u + v > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) / det > 0;
}

function normalOf(t: Float32Array, i: number): V3 {
  const e1: V3 = [t[i + 3]! - t[i]!, t[i + 4]! - t[i + 1]!, t[i + 5]! - t[i + 2]!];
  const e2: V3 = [t[i + 6]! - t[i]!, t[i + 7]! - t[i + 1]!, t[i + 8]! - t[i + 2]!];
  return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
}

/** The canopy seated as its fit says: grown about its centre, lifted along its area-weighted normal, moved, and any bridge added. */
export function fittedTris(src: CanopySource): Float32Array {
  const raw = [...src.tris, ...(src.fit?.bridge ?? [])];
  const t = Float32Array.from(raw);
  const grow = src.fit?.grow ?? 1;
  if (grow !== 1) {
    const c: V3 = [0, 0, 0];
    for (let i = 0; i < t.length; i++) c[i % 3] = c[i % 3]! + t[i]! / (t.length / 3);
    for (let i = 0; i < t.length; i++) t[i] = c[i % 3]! + (t[i]! - c[i % 3]!) * grow;
  }
  let off: V3 = [0, 0, 0];
  const lift = src.fit?.normal ?? 0;
  if (lift) {
    // over the exterior's own triangles only: the normal is theirs
    const n: V3 = [0, 0, 0];
    const own = Float32Array.from(src.tris);
    for (let i = 0; i < own.length; i += 9) {
      const c = normalOf(own, i);
      n[0] += c[0];
      n[1] += c[1];
      n[2] += c[2];
    }
    const l = Math.hypot(...n) || 1;
    off = [(n[0] / l) * lift, (n[1] / l) * lift, (n[2] / l) * lift];
  }
  const mv = src.fit?.move ?? [0, 0, 0];
  for (let i = 0; i < t.length; i += 3) {
    t[i] = t[i]! + off[0] + mv[0];
    t[i + 1] = t[i + 1]! + off[1] + mv[1];
    t[i + 2] = t[i + 2]! + off[2] + mv[2];
  }
  return t;
}

/**
 * The frame's edges: every edge of one triangle only (the glass's outline)
 * and, unless the fit says outlineOnly, every edge two facets share at more
 * than CREASE degrees (the canopy's facets, as its exterior shows them).
 */
function edgesOf(t: Float32Array, src: CanopySource): Glass['edges'] {
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  const byEdge = new Map<string, { a: V3; b: V3; normals: V3[] }>();
  for (let i = 0; i < t.length; i += 9) {
    const n = normalOf(t, i);
    const l = Math.hypot(...n) || 1;
    const nn: V3 = [n[0] / l, n[1] / l, n[2] / l];
    for (let j = 0; j < 3; j++) {
      const p = i + j * 3;
      const q = i + ((j + 1) % 3) * 3;
      const ka = key(t[p]!, t[p + 1]!, t[p + 2]!);
      const kb = key(t[q]!, t[q + 1]!, t[q + 2]!);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = byEdge.get(k) ?? { a: [t[p]!, t[p + 1]!, t[p + 2]!], b: [t[q]!, t[q + 1]!, t[q + 2]!], normals: [] };
      e.normals.push(nn);
      byEdge.set(k, e);
    }
  }
  const out: Glass['edges'] = [];
  const cos = Math.cos((CREASE * Math.PI) / 180);
  for (const e of byEdge.values()) {
    if (e.normals.length === 1) out.push({ a: e.a, b: e.b, boundary: true });
    else if (e.normals.length === 2 && !src.fit?.outlineOnly) {
      const [m, n] = e.normals as [V3, V3];
      // facets wound either way: the angle between their planes
      if (Math.abs(m[0] * n[0] + m[1] * n[1] + m[2] * n[2]) < cos) out.push({ a: e.a, b: e.b, boundary: false });
    }
  }
  return out;
}

/** A design's glass from its chassis's canopy (glass.ts). */
export function canopyOf(src: CanopySource): Glass {
  const t = fittedTris(src);
  const sees = (d: V3) => {
    for (let i = 0; i < t.length; i += 9) if (rayHits(d, t, i)) return true;
    return false;
  };
  /** how far out from straight ahead, at `theta` degrees round (0 right, 90 up), the glass still is: 120 when all the way round */
  const reach = (theta: number) => {
    const c = Math.cos((theta * Math.PI) / 180);
    const s = Math.sin((theta * Math.PI) / 180);
    for (let r = 1; r <= 120; r++) if (!sees(dir(r * c, Math.max(-89, Math.min(89, r * s)), 1))) return r - 1;
    return 120;
  };
  return { tris: t, sees, edges: edgesOf(t, src), right: reach(0), up: reach(90), left: reach(180), down: reach(270) };
}

/** A plain window for a chassis without a canopy: a flat pane a metre ahead, 40 degrees either side and 25 up and down. */
export const PLAIN_CANOPY: CanopySource = (() => {
  const x = Math.tan((40 * Math.PI) / 180);
  const y = Math.tan((25 * Math.PI) / 180);
  return { tris: [-x, -y, -1, x, -y, -1, x, y, -1, -x, -y, -1, x, y, -1, -x, y, -1] };
})();
