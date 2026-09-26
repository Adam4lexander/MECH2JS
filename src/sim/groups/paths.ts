/**
 * Named paths (PTBL chunks) that task_object_track makes objects follow:
 * up to 0x40 ProjectPath records of up to 64 points.
 */
import { ProjectPath } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import type { Chunk } from '../../data/bwd/stream.ts';
import { decodePtbl, PTBL_POINTS_AT, PTBL_POINT_SIZE } from '../../data/bwd/payloads/ptbl.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const PROJECT_PATH_COUNT = 0x40;

export const paths = registerGlobals(
  'paths',
  {
    /** 0xd7298 (the point writes address it as 0xd72dc = +0x44, points[0]) */
    projectPaths: Array.from({ length: PROJECT_PATH_COUNT }, () => new ProjectPath()),
    /** 0x95a4c */
    projectPathCount: 0,
  },
  () => {
    paths.projectPaths = Array.from({ length: PROJECT_PATH_COUNT }, () => new ProjectPath());
    paths.projectPathCount = imageI32(LABEL.projectPathCount, 0);
  },
);

/**
 * PTBL (keyword path): appends one path - a 64-byte name, then its points,
 * the three angles shifted from whole degrees to 16.16. Refused (0) at 0x40
 * paths or when the point count is not below 0x41.
 *
 * @mw2 path_table_load 0x0004d930
 * @fidelity exact
 */
export function pathTableLoad(c: Chunk): number {
  const p = paths;
  // (size - 0x48) / 0x1c as an unsigned divide: a short chunk gives a huge count and is refused
  const n = Math.floor(((c.size - PTBL_POINTS_AT) >>> 0) / PTBL_POINT_SIZE);
  if (p.projectPathCount < PROJECT_PATH_COUNT && n < 0x41) {
    const path = p.projectPaths[p.projectPathCount]!;
    p.projectPathCount++;
    path.pointCount = n;
    const ptbl = decodePtbl(c);
    path.name = ptbl.name;
    for (let k = 0; k < n; k++) {
      const s = ptbl.points[k];
      const d = path.points[k]!;
      if (!s) {
        // the chunk's size field claims more points than its bytes hold; Chunk reads past its end as 0
        d.x = d.y = d.z = d.pitch = d.yaw = d.roll = d.duration = 0;
        continue;
      }
      d.x = s.x;
      d.y = s.y;
      d.z = s.z;
      d.pitch = s.pitch << 16;
      d.yaw = s.yaw << 16;
      d.roll = s.roll << 16;
      d.duration = s.duration;
    }
    return 1;
  }
  return 0;
}
