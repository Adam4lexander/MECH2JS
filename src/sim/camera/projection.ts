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
import { matrixFromEulerOrder0, matrixTranspose, newTransform } from '../../core/math/matrix.ts';

import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const projectionGlobals = registerGlobals(
  'projection',
  {
    /** 0x970c4: detail setting; lodScale = focalScale / (lodQuality * 160); floored at 1 */
    lodQuality: 1,
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
  v.lodScale = cdiv(focal, Math.imul(projectionGlobals.lodQuality, 0xa0));
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
