/**
 * Small geometric questions the AI asks about a mech - how far it is off its
 * desired heading, whether it can jump, a probe ray to one side of it - and
 * the target setter the behaviours use to aim at something. The weapons'
 * dodge warning (weapon_fire_alert_target) reaches them in Phase 3; the rest
 * of their callers are the AI behaviours (Phase 5).
 */
import { cmod } from '../../core/int/cint.ts';
import { transformPoint } from '../../core/math/matrix.ts';
import { quirk } from '../../core/provenance.ts';
import type { MechEntity, Ray } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { raySetPoints } from '../../engine/collision/ray.ts';
import { imageI32 } from '../../engine/image.ts';
import { sceneNodeTransform } from '../../engine/scene/sceneGraph.ts';
import { aiValidateCurrentTarget } from './targeting.ts';

/**
 * desiredHeading - heading, wrapped once into -180..180 degrees (both are
 * 16.16 degrees; a difference already more than a turn out stays out).
 *
 * @mw2 mech_heading_error 0x000230d0
 * @fidelity exact
 */
export function mechHeadingError(mech: MechEntity): number {
  let error = (mech.desiredHeading - mech.heading) | 0;
  if (0xb40000 < error) return (error - 0x1680000) | 0;
  if (error < -0xb40000) error = (error + 0x1680000) | 0;
  return error;
}

/**
 * 1 when the mech has more than 5 jump fuel, working jets (jetDeltaY != 0)
 * and its heat's whole part below maxHeat.
 *
 * @mw2 mech_can_jump 0x0002e3d0
 * @fidelity exact
 */
export function mechCanJump(mech: MechEntity, maxHeat: number): number {
  const l = mech.loadout!;
  if (5 < l.jumpFuel && l.jetDeltaY !== 0 && l.heatLevel >> 16 < maxHeat) return 1;
  return 0;
}

/**
 * Makes `handle` the mech's target (sign-extended from 16 bits) and asks
 * ai_validate_current_target whether it holds; true when that returns > 0.
 * Validation also points desiredHeading at the target, which is what the
 * callers read next.
 *
 * @mw2 ai_bearing_to_target 0x00022850
 * @fidelity exact
 */
export function aiBearingToTarget(mech: MechEntity, handle: number): boolean {
  mech.targetHandle = (handle << 16) >> 16;
  return 0 < aiValidateCurrentTarget(mech);
}

/** probeDirections (0x96374): 16 {dx, dz} dword pairs, read from the image */
function probeDirection(i: number): { dx: number; dz: number } {
  return { dx: imageI32(LABEL.probeDirections + i * 8, 0), dz: imageI32(LABEL.probeDirections + i * 8 + 4, 0) };
}

/**
 * A level probe ray from the mech (or, with fromFlank, from its flank: the
 * body-space point (+/-(radius - 1), y, 0), y as below) to the body-space
 * point (length / dx, 0, length / dz) of probeDirections[direction] - the
 * table entry mirrored to (16 - direction) % 16 for a negative side; a zero
 * component stays 0. Both points go through the mech node's world transform;
 * the ray runs at the mech's own height, posY, at both ends.
 *
 * @mw2 mech_probe_ray 0x0002df30
 * @fidelity exact
 */
export function mechProbeRay(mech: MechEntity, outRay: Ray, side: number, direction: number, length: number, fromFlank: number): void {
  const l = mech.loadout!;
  const t = sceneNodeTransform(mech.node!);
  const d16 = (direction << 16) >> 16;
  const idx = side < 0 ? cmod(0x10 - d16, 0x10) : d16;
  const dir = probeDirection(idx);
  let px = dir.dx;
  let pz = dir.dz;
  if (px !== 0) px = (length / px) | 0;
  if (pz !== 0) pz = (length / pz) | 0;
  const end = [px, 0, pz];
  transformPoint(t, end);
  let sx: number;
  let sz: number;
  if (fromFlank === 0) {
    sx = mech.posX;
    sz = mech.posZ;
  } else {
    // the flank point's y is the end point's transformed y, the slot the first transform wrote (0x2e00e..0x2e023)
    quirk('mech_probe_ray: the flank point is transformed with the probe end\'s world y as its body-space y', 'mech_probe_ray');
    const start = [side < 0 ? (1 - l.radius) | 0 : (l.radius - 1) | 0, end[1]!, 0];
    transformPoint(t, start);
    sx = start[0]!;
    sz = start[2]!;
  }
  raySetPoints(outRay, sx, mech.posY, sz, end[0]!, mech.posY, end[2]!);
}
