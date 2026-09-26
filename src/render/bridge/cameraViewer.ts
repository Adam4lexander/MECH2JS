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
import type { Camera, PerspectiveCamera } from 'three';
import { Matrix4, Vector3 } from 'three';
import type { Viewer } from '../../generated/classes.gen.ts';
import { blockToMatrix4, fromThree } from './space.ts';

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

const block = new Int32Array(12);
const m4 = new Matrix4();

/**
 * The reverse: a three.js camera standing where the game's viewer stands
 * (Play). Viewer.rotation is world-to-view, so its transpose is the
 * camera-to-world R, and three's camera matrix is S R S with S t (space.ts).
 *
 * The horizontal field of view is the game's: viewer_update_projection's
 * focal length is zoom * halfWidth (16.16), so tan(hfov / 2) = 0x10000 /
 * zoom - 90 degrees at unity zoom. The vertical one follows from the render
 * target's aspect with square pixels.
 *
 * @portOnly
 */
export function cameraFromViewer(v: Viewer, camera: PerspectiveCamera, aspect: number): void {
  const r = v.rotation;
  block[0] = r[0]!;
  block[1] = r[3]!;
  block[2] = r[6]!;
  block[3] = r[1]!;
  block[4] = r[4]!;
  block[5] = r[7]!;
  block[6] = r[2]!;
  block[7] = r[5]!;
  block[8] = r[8]!;
  block[9] = v.posX;
  block[10] = v.posY;
  block[11] = v.posZ;
  blockToMatrix4(block, m4);
  m4.decompose(camera.position, camera.quaternion, camera.scale);
  camera.scale.set(1, 1, 1);
  const zoom = Math.min(0x100000, Math.max(0x8000, v.zoom | 0));
  const tanH = 0x10000 / zoom;
  camera.aspect = aspect;
  camera.fov = (2 * Math.atan(tanH / aspect) * 180) / Math.PI;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
