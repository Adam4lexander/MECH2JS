/**
 * Rotation matrices and transform blocks, exactly as render_asm computes them.
 *
 * A MATRIX is nine int32 at the 2.29 scale (1.0 = 0x20000000), row-major,
 * acting on column vectors: x' = m0 x + m1 y + m2 z. A TRANSFORM is twelve
 * int32: the matrix, then a translation (tx, ty, tz) in cm - the 0x30-byte
 * block transform_copy fixes. Every product is summed in 64 bits, shifted
 * right 29, and rounded by adding bit 28 back.
 *
 * Handedness: matrix_cross_column's cyclic order makes every matrix built
 * here right-handed, and +Z is model-space forward (matrix_rotate_vector's
 * one caller rotates (0, 0, 0x10000) to get a weapon's aim).
 */

import { fixedAcos, fixedAsin, fixedAtan2, fixedCos, fixedSin } from '../angle/trig.ts';
import { det2r29, dot3r29, mulr29 } from '../int/i64.ts';
import { quirk } from '../provenance.ts';

export type Mat3 = Int32Array; // length >= 9
export type Transform = Int32Array; // length 12

export const newTransform = (): Transform => new Int32Array(12);

/**
 * @mw2 matrix_identity 0x0003b4c1
 * @fidelity exact
 * Writes all twelve ints (identity rotation, zero translation).
 */
export function matrixIdentity(m: Int32Array): void {
  m.fill(0, 0, 12);
  m[0] = m[4] = m[8] = 0x20000000;
}

/**
 * @mw2 transform_copy 0x0003b4f0
 * @fidelity exact
 * Argument order follows the original: (src, dst).
 */
export function transformCopy(src: Transform, dst: Transform): void {
  dst.set(src.subarray(0, 12));
}

/**
 * dst = src transposed (3x3 only). Safe in place, as the original is.
 *
 * @mw2 matrix_transpose 0x0003b42b
 * @fidelity exact
 */
export function matrixTranspose(src: Mat3, dst: Mat3): void {
  dst[0] = src[0]!;
  dst[4] = src[4]!;
  dst[8] = src[8]!;
  let t = src[1]!;
  dst[1] = src[3]!;
  dst[3] = t;
  t = src[6]!;
  dst[6] = src[2]!;
  dst[2] = t;
  t = src[7]!;
  dst[7] = src[5]!;
  dst[5] = t;
}

/**
 * Applies a full transform to a point in place (rotation, then translation).
 *
 * @mw2 transform_point 0x0003aefc
 * @fidelity exact
 */
export function transformPoint(t: Transform, p: Int32Array | number[], i = 0): void {
  const x = p[i]!;
  const y = p[i + 1]!;
  const z = p[i + 2]!;
  p[i] = (dot3r29(t[0]!, x, t[1]!, y, t[2]!, z) + t[9]!) | 0;
  p[i + 1] = (dot3r29(t[3]!, x, t[4]!, y, t[5]!, z) + t[10]!) | 0;
  p[i + 2] = (dot3r29(t[6]!, x, t[7]!, y, t[8]!, z) + t[11]!) | 0;
}

/**
 * Rotates a vector in place by a 3x3; no translation.
 *
 * @mw2 matrix_rotate_vector 0x0003afba
 * @fidelity exact
 */
export function matrixRotateVector(m: Mat3, p: Int32Array | number[], i = 0): void {
  const x = p[i]!;
  const y = p[i + 1]!;
  const z = p[i + 2]!;
  p[i] = dot3r29(m[0]!, x, m[1]!, y, m[2]!, z);
  p[i + 1] = dot3r29(m[3]!, x, m[4]!, y, m[5]!, z);
  p[i + 2] = dot3r29(m[6]!, x, m[7]!, y, m[8]!, z);
}

/**
 * Overwrites one column with the cross product of the other two:
 * col0 = col1 x col2, col1 = col2 x col0, col2 = col0 x col1.
 *
 * @mw2 matrix_cross_column 0x0003b078
 * @fidelity exact
 */
export function matrixCrossColumn(m: Mat3, col: number): void {
  let a0 = 0, a1 = 0, a2 = 0, b0 = 0, b1 = 0, b2 = 0;
  if (col === 0) {
    a0 = m[1]!; a1 = m[4]!; a2 = m[7]!; b0 = m[2]!; b1 = m[5]!; b2 = m[8]!;
  } else if (col === 1) {
    a0 = m[2]!; a1 = m[5]!; a2 = m[8]!; b0 = m[0]!; b1 = m[3]!; b2 = m[6]!;
  } else if (col === 2) {
    a0 = m[0]!; a1 = m[3]!; a2 = m[6]!; b0 = m[1]!; b1 = m[4]!; b2 = m[7]!;
  }
  const r0 = det2r29(a1, b2, b1, a2);
  const r1 = det2r29(a2, b0, b2, a0);
  const r2 = det2r29(a0, b1, b0, a1);
  if (col >= 0 && col <= 2) {
    m[col] = r0;
    m[col + 3] = r1;
    m[col + 6] = r2;
  }
}

/**
 * out = a * b (3x3 only; never touches out's translation).
 *
 * @mw2 matrix_multiply 0x0003b20c
 * @fidelity exact
 */
export function matrixMultiply(a: Mat3, b: Mat3, out: Mat3): void {
  const r = scratchMul;
  for (let row = 0; row < 3; row++) {
    const a0 = a[row * 3]!;
    const a1 = a[row * 3 + 1]!;
    const a2 = a[row * 3 + 2]!;
    for (let c = 0; c < 3; c++) r[row * 3 + c] = dot3r29(a0, b[c]!, a1, b[c + 3]!, a2, b[c + 6]!);
  }
  for (let k = 0; k < 9; k++) out[k] = r[k]!;
}
const scratchMul = new Int32Array(9);

/**
 * out = outer(inner(v)): rotation outer.R * inner.R, translation
 * outer applied to inner.T. Built in scratch, so out may alias either input.
 *
 * @mw2 transform_compose 0x0003b3c5
 * @fidelity exact
 */
export function transformCompose(outer: Transform, inner: Transform, out: Transform): void {
  const s = scratchCompose;
  matrixMultiply(outer, inner, s);
  s[9] = inner[9]!;
  s[10] = inner[10]!;
  s[11] = inner[11]!;
  transformPoint(outer, s, 9);
  out.set(s);
}
const scratchCompose = new Int32Array(12);

/**
 * Inverse of a rigid transform: transpose the rotation, rotate the negated
 * translation by it. Positional in the decompilation, with no direct caller;
 * ported for completeness under its positional name.
 *
 * @mw2 render_asm_sub_03b462 0x0003b462
 * @fidelity exact
 */
export function renderAsmSub03b462(src: Transform, dst: Transform): void {
  const p = [-src[9]! | 0, -src[10]! | 0, -src[11]! | 0];
  matrixTranspose(src, dst);
  dst[9] = dst[10] = dst[11] = 0;
  transformPoint(dst, p);
  dst[9] = p[0]!;
  dst[10] = p[1]!;
  dst[11] = p[2]!;
}

/**
 * Builds a transform from three 16.16-degree angles and a translation.
 * order & 3 picks the composition (0 = Ry*Rx*Rz, 1 = Rx*Ry*Rz, 2 = Rx*Rz*Ry,
 * 3 = leave the 3x3 untouched); order & 4 negates the sines and transposes,
 * reversing the order. Single-angle fast paths ignore the order.
 *
 * @mw2 matrix_from_euler 0x0003b522
 * @fidelity exact
 */
export function matrixFromEuler(out: Transform, pitch: number, yaw: number, roll: number, tx: number, ty: number, tz: number, order: number): void {
  pitch |= 0;
  yaw |= 0;
  roll |= 0;
  if (pitch === 0) {
    if (yaw === 0) {
      matrixIdentity(out);
      if (roll !== 0) {
        out[0] = out[4] = fixedCos(roll);
        out[3] = fixedSin(roll);
        out[1] = -out[3]! | 0;
      }
      return setT(out, tx, ty, tz);
    }
    if (roll === 0) {
      matrixIdentity(out);
      out[0] = out[8] = fixedCos(yaw);
      out[2] = fixedSin(yaw);
      out[6] = -out[2]! | 0;
      return setT(out, tx, ty, tz);
    }
  } else if (yaw === 0 && roll === 0) {
    matrixIdentity(out);
    out[4] = out[8] = fixedCos(pitch);
    out[7] = fixedSin(pitch);
    out[5] = -out[7]! | 0;
    return setT(out, tx, ty, tz);
  }
  const cp = fixedCos(pitch);
  const cy = fixedCos(yaw);
  const cr = fixedCos(roll);
  let sp = fixedSin(pitch);
  let sy = fixedSin(yaw);
  let sr = fixedSin(roll);
  if ((order & 4) !== 0) {
    sp = -sp | 0;
    sy = -sy | 0;
    sr = -sr | 0;
  }
  const o = order & 3;
  if (o === 0) {
    out[0] = (mulr29(cr, cy) + mulr29(mulr29(sr, sp), sy)) | 0;
    out[3] = mulr29(cp, sr);
    out[6] = (mulr29(mulr29(cy, sr), sp) - mulr29(cr, sy)) | 0;
    out[2] = mulr29(cp, sy);
    out[5] = -sp | 0;
    out[8] = mulr29(cp, cy);
    matrixCrossColumn(out, 1);
  } else if (o === 1) {
    out[0] = mulr29(cr, cy);
    out[3] = (mulr29(cp, sr) + mulr29(mulr29(cr, sp), sy)) | 0;
    out[6] = (mulr29(sr, sp) - mulr29(mulr29(cr, cp), sy)) | 0;
    out[2] = sy;
    out[5] = -mulr29(cy, sp) | 0;
    out[8] = mulr29(cp, cy);
    matrixCrossColumn(out, 1);
  } else if (o === 2) {
    out[0] = mulr29(cr, cy);
    out[3] = (mulr29(sp, sy) + mulr29(mulr29(cp, cy), sr)) | 0;
    out[6] = (mulr29(mulr29(cy, sr), sp) - mulr29(cp, sy)) | 0;
    out[1] = -sr | 0;
    out[4] = mulr29(cr, cp);
    out[7] = mulr29(cr, sp);
    matrixCrossColumn(out, 2);
  }
  if ((order & 4) !== 0) matrixTranspose(out, out);
  setT(out, tx, ty, tz);
}

function setT(out: Transform, tx: number, ty: number, tz: number): void {
  out[9] = tx | 0;
  out[10] = ty | 0;
  out[11] = tz | 0;
}

/**
 * @mw2 matrix_from_euler_order0 0x0003b88b
 * @fidelity exact
 */
export function matrixFromEulerOrder0(out: Transform, pitch: number, yaw: number, roll: number, tx: number, ty: number, tz: number): void {
  matrixFromEuler(out, pitch, yaw, roll, tx, ty, tz, 0);
}

/**
 * Drift correction for a rotation that is repeatedly multiplied. Read from
 * the x87 disassembly (0x3ad00..0x3aef9), which the decompiled C reduces to
 * bare stores: each triple (a, b, c) is loaded, s = K / sqrt(a²+b²+c²) with
 * K = 2^29 (the double at 0x90fec), and a*s, b*s, c*s are stored truncated
 * toward zero. It does this for the three ROWS (0,1,2), (3,4,5), (6,7,8),
 * then the three COLUMNS (0,3,6), (1,4,7), (2,5,8). There is no
 * orthogonalisation step - only unit length, rows then columns.
 *
 * The x87 sequence is fild a, b, c; (a*a + b*b) + c*c; fsqrt; fdivr K;
 * then each times s - this order, at the FPU's 53-bit precision
 * (core/int/x87.ts), which doubles reproduce exactly.
 * CORRECTION (2026-09-28): this was partial, on the assumption the x87
 * kept 64-bit precision.
 *
 * @mw2 matrix_renormalise 0x0003ad00
 * @fidelity exact
 */
export function matrixRenormalise(m: Mat3): void {
  const K = 536870912.0;
  const tri = (i: number, j: number, k: number): void => {
    const a = m[i]!;
    const b = m[j]!;
    const c = m[k]!;
    const s = K / Math.sqrt(a * a + b * b + c * c);
    m[i] = Math.trunc(a * s) | 0;
    m[j] = Math.trunc(b * s) | 0;
    m[k] = Math.trunc(c * s) | 0;
  };
  tri(0, 1, 2);
  tri(3, 4, 5);
  tri(6, 7, 8);
  tri(0, 3, 6);
  tri(1, 4, 7);
  tri(2, 5, 8);
}

/**
 * sqrt(a*a + b*b) on the x87, truncated toward zero. The FPU runs at
 * 53-bit precision (core/int/x87.ts), so each product, the sum and the
 * square root round as doubles do.
 * CORRECTION (2026-09-28): this was partial, on the assumption the x87
 * kept 64-bit precision.
 *
 * @mw2 int_hypot 0x0003ac00
 * @fidelity exact
 */
export function intHypot(a: number, b: number): number {
  return Math.trunc(Math.sqrt(a * a + b * b)) | 0;
}

/**
 * Decomposes a rotation into (pitch, yaw, roll). Keeps both quirks the
 * annotation records: near a pole the pitch sign is mirrored, and in the
 * fully degenerate case the quarter turn goes to YAW with pitch 0.
 *
 * @mw2 matrix_to_euler 0x0003b8af
 * @fidelity exact
 */
export function matrixToEuler(m: Mat3): { pitch: number; yaw: number; roll: number } {
  const m5 = m[5]!;
  let pitch: number;
  let yaw: number;
  let roll: number;
  if (m5 < 0x1ff7ceda && -0x1ff7ceda < m5) {
    pitch = -fixedAsin(m5) | 0;
  } else {
    const h = intHypot(m[2]!, m[8]!);
    if (h < 0x1e8481) {
      quirk('matrix_to_euler degenerate pole: quarter turn written to yaw, pitch 0', 'matrix_to_euler');
      yaw = m5 > -1 ? -0x5a0000 : 0x5a0000;
      pitch = 0;
      roll = fixedAtan2(m[1]!, m[0]!);
      return { pitch, yaw, roll };
    }
    quirk('matrix_to_euler near-pole branch mirrors the pitch sign', 'matrix_to_euler');
    pitch = fixedAcos(h);
    if (m5 < 0) pitch = -pitch | 0;
  }
  yaw = fixedAtan2(m[2]!, m[8]!);
  roll = fixedAtan2(m[3]!, m[4]!);
  return { pitch, yaw, roll };
}
