/**
 * The game world and three.js, reconciled.
 *
 * The game's world is LEFT-handed: +X right, +Y up, +Z forward (established
 * by viewer_project_point and triangle_normal's facing note). Its camera
 * rotation R = Ry(yaw) Rx(pitch) Rz(roll) maps camera-local axes (x right,
 * y up, z forward) to world; viewer_build_transform stores R^T for
 * world-to-view. three.js is right-handed with the camera looking down -Z.
 *
 * One mirror S = diag(1, 1, -1) converts both: three = S * game. A game
 * transform (R, t) becomes (S R S, S t), and the game camera's local frame
 * maps onto three's camera frame by the same S (forward +Z -> -Z). Screen x
 * and y are unchanged, so a polygon that appears counter-clockwise on the
 * game's screen does on three's - three's default front face (CCW) is the
 * game's visible side.
 *
 * Positions are cm; the render boundary converts to metres (1/100) only for
 * precision comfort in float32 - relative geometry is unchanged.
 *
 * @portOnly
 */
import { Matrix4 } from 'three';

export const CM_TO_UNITS = 1 / 100;
const ONE = 0x20000000; // 2.29

/** A 12-int game transform block (3x3 row-major 2.29, then tx, ty, tz cm) as a three.js world matrix. */
export function blockToMatrix4(t: Int32Array | ArrayLike<number>, out = new Matrix4()): Matrix4 {
  const r = (i: number) => t[i]! / ONE;
  // S R S flips the sign of entries that mix z with x or y.
  out.set(
    r(0), r(1), -r(2), t[9]! * CM_TO_UNITS,
    r(3), r(4), -r(5), t[10]! * CM_TO_UNITS,
    -r(6), -r(7), r(8), -t[11]! * CM_TO_UNITS,
    0, 0, 0, 1,
  );
  return out;
}

/** A game position (cm) as three.js coordinates. */
export function toThree(x: number, y: number, z: number): [number, number, number] {
  return [x * CM_TO_UNITS, y * CM_TO_UNITS, -z * CM_TO_UNITS];
}

/** three.js coordinates back to a game position (cm, rounded to int). */
export function fromThree(x: number, y: number, z: number): [number, number, number] {
  return [Math.round(x / CM_TO_UNITS) | 0, Math.round(y / CM_TO_UNITS) | 0, Math.round(-z / CM_TO_UNITS) | 0];
}
