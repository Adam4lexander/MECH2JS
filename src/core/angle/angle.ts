/**
 * The game's angle unit: 16.16 fixed-point DEGREES. A full turn is
 * 360 << 16 = 0x1680000. Established by fixed_cos (sin of angle + 0x5a0000,
 * exactly 90 degrees), matrix_to_euler's pole substitute 0x5a0000, and
 * fixed_atan2's |y| == |x| shortcut returning 0x2d0000 (45 degrees).
 *
 * @portOnly constants and conversions for the editor and render boundary
 */

export const DEG = 0x10000;
export const QUARTER_TURN = 0x5a0000;
export const HALF_TURN = 0xb40000;
export const FULL_TURN = 0x1680000;

/** For display and the render boundary only - never feed back into the sim. */
export const angleToDegrees = (a: number): number => a / DEG;
export const angleToRadians = (a: number): number => ((a / DEG) * Math.PI) / 180;
export const degreesToAngle = (d: number): number => Math.round(d * DEG) | 0;

/** 1.0 at the 2.29 scale of sines and rotation matrices. */
export const ONE_2_29 = 0x20000000;
export const fix229ToFloat = (v: number): number => v / ONE_2_29;
export const fix1616ToFloat = (v: number): number => v / 65536;
