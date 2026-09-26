/**
 * The viewer's derived projection fields, from its viewport rect, zoom and
 * aspectScale: centre, half-extents, focal lengths, the normalised
 * projection scales and their shifts, a default near clip, and the LOD
 * scale. The first of the three stages the callers always run in order
 * (then viewer_build_transform, then viewer_latch_globals).
 */
import type { Viewer } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { matrixFromEulerOrder0, matrixTranspose, newTransform } from '../../core/math/matrix.ts';

import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const projectionGlobals = registerGlobals(
  'projection',
  {
    /** 0x970c4: detail setting; lodScale = focalScale / (lodQuality * 160); floored at 1 */
    lodQuality: 1,
    /**
     * @portOnly the host's multiplier on lodScale - how far every LOD step
     * (the meshes' lodKey thresholds, mech_lod_update's ranges) is pushed out.
     * 1 is the original. The VR view raises it: at a headset's resolution the
     * original's steps pop close in. Apply a change with viewerRefreshLodScale.
     */
    lodDistanceScale: 1,
  },
  () => {
    projectionGlobals.lodQuality = imageI32(LABEL.lodQuality, 1);
  },
);

/** Top set bit of a 64-bit unsigned value given as a JS number (< 2^53). */
function topBit(v: number): number {
  return v <= 0 ? 0 : Math.floor(Math.log2(v));
}

/** Normalises a product to a 16-bit mantissa: returns [mantissa (low 32 bits), shift]. */
function normalise(product: number): [number, number] {
  const lo = product % 4294967296;
  const bit = topBit(lo); // the C scans the LOW dword only
  if (bit - 0xf !== 0 && bit > 0xe) {
    const s = (bit - 0xf) & 0x1f;
    const hi = Math.floor(product / 4294967296);
    return [((lo >>> s) | (hi << (32 - s))) >>> 0, bit - 0xd];
  }
  return [lo >>> 0, 2];
}

/**
 * @mw2 viewer_update_projection 0x0003ef30
 * @fidelity partial
 * @divergence the fields +0xa8 and +0xac (secant terms from the atan tables) are not computed
 * @divergence lodScale is multiplied by the host's lodDistanceScale when that is not 1 (the VR view's detail setting)
 */
export function viewerUpdateProjection(v: Viewer): void {
  let zoom = v.zoom | 0;
  v.centreX = ((v.left + v.right + 1) >> 1) + ((v.centreOffsetX << 16) >> 16);
  v.centreY = ((v.top + v.bottom + 1) >> 1) + ((v.centreOffsetY << 16) >> 16);
  let hw = (v.right - v.left + 1) >> 1;
  if (hw < 2) hw = 1;
  v.halfWidth = hw;
  let hh = (v.bottom - v.top + 1) >> 1;
  if (hh < 2) hh = 1;
  v.halfHeight = hh;
  if (zoom > 0x100000) zoom = 0x100000;
  if (zoom < 0x8000) zoom = 0x8000;
  // zoom * aspectScale >> 16, rounded by bit 15
  const zaProd = BigInt(zoom) * BigInt(v.aspectScale | 0);
  const zAspect = Number(BigInt.asIntN(32, (zaProd >> 16n) + ((zaProd >> 15n) & 1n)));
  const [scaleY, shiftY] = normalise((zAspect >>> 0) * hw);
  const fx = zoom * hw; // uint64 product (< 2^53)
  const [scaleX, shiftX] = normalise(fx);
  const focal = fx % 4294967296 | 0;
  v.nearClip = (focal >> 0x11) + 1;
  // +0xb4: the far distance object_cull_main_view tests its bounding sphere against
  v.field_0xb4 = v.farClip;
  v.projShiftX = shiftX;
  v.projShiftY = shiftY;
  v.projScaleX = scaleX;
  v.projScaleY = scaleY;
  v.focalScale = focal;
  v.focalScaleY = ((zAspect >>> 0) * hw) % 4294967296 | 0;
  if (projectionGlobals.lodQuality < 1) projectionGlobals.lodQuality = 1;
  v.lodScale = lodScaleFor(focal);
}

/** focal / (lodQuality * 160), times the host's lodDistanceScale when it is not 1. */
function lodScaleFor(focal: number): number {
  const base = cdiv(focal, Math.imul(projectionGlobals.lodQuality, 0xa0));
  const k = projectionGlobals.lodDistanceScale;
  return k === 1 ? base : Math.min(0x7fffffff, Math.max(1, Math.round(base * k))) | 0;
}

/**
 * viewer_update_projection's last step alone: lodScale from the viewer's
 * focal length, after lodDistanceScale changes (the rest of the projection,
 * the near clip among it, stays as the game left it).
 *
 * @portOnly
 */
export function viewerRefreshLodScale(v: Viewer): void {
  if (projectionGlobals.lodQuality < 1) projectionGlobals.lodQuality = 1;
  v.lodScale = lodScaleFor(v.focalScale);
}

const scratch = newTransform();

/**
 * The view transform from the viewer's own pose: matrix_from_euler_order0
 * of (pitch, yaw, roll, pos), transposed into rotation (camera-to-world
 * becomes world-to-view) and its translation into translationX/Y/Z.
 *
 * @mw2 viewer_build_transform 0x0003f230
 * @fidelity exact
 */
export function viewerBuildTransform(v: Viewer): void {
  matrixFromEulerOrder0(scratch, v.pitch, v.yaw, v.roll, v.posX, v.posY, v.posZ);
  matrixTranspose(scratch, v.rotation);
  v.translationX = scratch[9]!;
  v.translationY = scratch[10]!;
  v.translationZ = scratch[11]!;
}

/** low 32 bits of (a0*b0 + a1*b1 + a2*b2) >> 27, rounded by bit 26 - the projector's 64-bit dot */
function dot3r27(a0: number, b0: number, a1: number, b1: number, a2: number, b2: number): number {
  const s = BigInt(a0 | 0) * BigInt(b0 | 0) + BigInt(a1 | 0) * BigInt(b1 | 0) + BigInt(a2 | 0) * BigInt(b2 | 0);
  return Number(BigInt.asIntN(32, (s >> 27n) + ((s >> 26n) & 1n)));
}

/**
 * Projects a world point to the screen, in place: p becomes (screen x,
 * screen y, view depth). Rows 0 and 1 of the view rotation premultiplied by
 * projScaleX / projScaleY (16.16, rounded) and row 2 give 64-bit dots that
 * are taken >> 27 rounded; x and y are then (n << projShift) / depth, + 2
 * >> 2, about the viewport centre, y flipped within the viewport's height.
 * Returns 1 when the point is in front of the near clip (depth > 4 x
 * nearClip) and inside left..right, top..bottom; otherwise 0, with a depth
 * at or behind the eye divided by as |depth| (0 as 1).
 *
 * @mw2 viewer_project_point 0x0003f320
 * @fidelity exact
 * @divergence the original reads the globals viewer_latch_globals left at the last draw (viewTranslation, the premultiplied rows, viewDepthRow, projShift, centre and bounds, viewNearClipScaled); the port computes the same values from the viewer passed in, which callers make viewerPosition - the viewer the last draw latched, except while the cockpit shell pass had its near clip at 8
 */
export function viewerProjectPoint(v: Viewer, p: number[]): number {
  const nearLimit = Math.imul(v.nearClip, 4);
  const r = v.rotation;
  const dx = (p[0]! - v.translationX) | 0;
  const dy = (p[1]! - v.translationY) | 0;
  let depth = (p[2]! - v.translationZ) | 0;
  const psx = v.projScaleX | 0;
  const psy = v.projScaleY | 0;
  const sx = dot3r27(dx, mulr16(psx, r[0]!), dy, mulr16(psx, r[1]!), mulr16(psx, r[2]!), depth);
  const sy = dot3r27(dx, mulr16(psy, r[3]!), dy, mulr16(psy, r[4]!), mulr16(psy, r[5]!), depth);
  depth = dot3r27(dx, r[6]!, dy, r[7]!, r[8]!, depth);
  p[2] = depth;
  let rejected: boolean;
  if (nearLimit < depth) {
    rejected = false;
  } else {
    rejected = true;
    if (depth < 0) depth = -depth | 0;
    else if (depth === 0) depth = 1;
  }
  p[0] = (((sdivShl(sx, v.projShiftX & 0x1f, depth) + 2) >> 2) + v.centreX) | 0;
  p[1] = (v.bottom - v.top - ((((sdivShl(sy, v.projShiftY & 0x1f, depth) + 2) >> 2) + v.centreY) | 0)) | 0;
  if (rejected || p[0] < v.left || v.right < p[0] || p[1] < v.top || v.bottom < p[1]) return 0;
  return 1;
}

/**
 * lodQuality = 2 (low) for 0, 1 (high) otherwise.
 *
 * @mw2 lod_quality_set 0x0003f9b0
 * @fidelity exact
 */
export function lodQualitySet(_unused: number, on: number): void {
  projectionGlobals.lodQuality = on === 0 ? 2 : 1;
}

/**
 * @mw2 lod_quality_is_high 0x0003f990
 * @fidelity exact
 */
export function lodQualityIsHigh(): boolean {
  return projectionGlobals.lodQuality === 1;
}
