/**
 * A game Viewer standing where a three.js camera stands, so the ported
 * cull, LOD and clipper see exactly the view three.js draws.
 *
 * Viewer.rotation is world-to-view, one row per view axis in world
 * coordinates at 2.29: row 0 right, row 1 up, row 2 forward - the depth row
 * viewer_latch_globals hands the clipper raw. three's camera has right, up
 * and BACK as the columns of its world matrix; in game space (S = diag(1, 1,
 * -1), see space.ts) the rows are S * right, S * up and S * -back.
 * translation is the eye in world cm. Everything else (lighting, clip
 * distances, lodScale, the projection fields) is copied from `src`, the
 * game's own viewer.
 *
 * @portOnly
 */
import type { Camera } from 'three';
import { Vector3 } from 'three';
import type { Viewer } from '../../generated/classes.gen.ts';
import { fromThree } from './space.ts';

const ONE = 0x20000000; // 2.29
const right = new Vector3();
const up = new Vector3();
const back = new Vector3();

function copyViewer(src: Viewer, out: Viewer): void {
  for (const k of Object.keys(src) as Array<keyof Viewer>) {
    const v = src[k];
    if (v instanceof Int32Array) (out[k] as Int32Array).set(v);
    else (out as unknown as Record<string, unknown>)[k] = v;
  }
}

export function viewerFromCamera(camera: Camera, src: Viewer, out: Viewer): Viewer {
  copyViewer(src, out);
  camera.updateMatrixWorld();
  camera.matrixWorld.extractBasis(right, up, back);
  const q = (c: number) => Math.round(c * ONE) | 0;
  const r = out.rotation;
  r[0] = q(right.x);
  r[1] = q(right.y);
  r[2] = q(-right.z);
  r[3] = q(up.x);
  r[4] = q(up.y);
  r[5] = q(-up.z);
  r[6] = q(-back.x);
  r[7] = q(-back.y);
  r[8] = q(back.z);
  const [x, y, z] = fromThree(camera.position.x, camera.position.y, camera.position.z);
  out.translationX = out.posX = x;
  out.translationY = out.posY = y;
  out.translationZ = out.posZ = z;
  return out;
}
