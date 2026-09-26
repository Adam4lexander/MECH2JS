/**
 * PTBL (keyword path, tag 66): one named path for task_object_track.
 * path_table_load appends it to projectPaths (ProjectPath in mw2_types.h):
 *
 *   +0x08  char[64]  ProjectPath.name (strncpy 0x40), what a track task's
 *                    third word names
 *   +0x48  points of 0x1c bytes, (size - 0x48) / 0x1c of them
 *            +0x00/+0x04/+0x08  int x, y, z  -> PathPoint.x/y/z as-is
 *            +0x0c/+0x10/+0x14  int pitch, yaw, roll in WHOLE degrees;
 *                               path_table_load shifts each << 16
 *            +0x18  int duration: time to the next point (PathPoint.duration)
 *
 * path_table_load refuses the chunk (returns 0, nothing stored) once 0x40
 * paths are loaded or when the count is not below 0x41 - see ProjectPath for
 * why 0x40 points would already overflow.
 */
import type { Chunk } from '../stream.ts';

export const PTBL_POINTS_AT = 0x48;
export const PTBL_POINT_SIZE = 0x1c;

export interface PtblPoint {
  /** +0x00 PathPoint.x, cm */
  x: number;
  /** +0x04 PathPoint.y, the vertical */
  y: number;
  /** +0x08 PathPoint.z */
  z: number;
  /** +0x0c whole degrees as stored; PathPoint.pitch is this << 16 */
  pitch: number;
  /** +0x10 whole degrees as stored; PathPoint.yaw is this << 16 */
  yaw: number;
  /** +0x14 whole degrees as stored; PathPoint.roll is this << 16 */
  roll: number;
  /** +0x18 PathPoint.duration, time to the next point */
  duration: number;
}

export interface PtblChunk {
  /** +0x08 ProjectPath.name, at most 64 characters */
  name: string;
  /** (size - 0x48) / 0x1c points, the count path_table_load stores as pointCount */
  points: PtblPoint[];
}

/**
 * Reads a PTBL chunk at the offsets path_table_load reads it. The angles are
 * returned as stored (whole degrees), not shifted.
 *
 * @portOnly the read half of path_table_load
 */
export function decodePtbl(c: Chunk): PtblChunk {
  const n = c.size >= PTBL_POINTS_AT ? Math.floor((c.size - PTBL_POINTS_AT) / PTBL_POINT_SIZE) : 0;
  return {
    name: c.str(0x08, 0x40),
    points: Array.from({ length: n }, (_, i) => {
      const o = PTBL_POINTS_AT + i * PTBL_POINT_SIZE;
      return {
        x: c.i32(o),
        y: c.i32(o + 0x04),
        z: c.i32(o + 0x08),
        pitch: c.i32(o + 0x0c),
        yaw: c.i32(o + 0x10),
        roll: c.i32(o + 0x14),
        duration: c.i32(o + 0x18),
      };
    }),
  };
}
