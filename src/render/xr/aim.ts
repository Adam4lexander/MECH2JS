/**
 * How far away the thing under the reticle is, for the VR view's reticle
 * plane (xrRig.ts placeLifted): the nearest of
 *
 *  - the drawn world: three.js raycast against the main view's meshes (the
 *    caller's list, the player's own mech left out) - buildings, mechs,
 *    scenery;
 *  - the terrain: world_object_raycast against every walkmesh (objectClass
 *    5) on the world chain, the hills the mechs walk on - not all of them
 *    are drawn as meshes the raycast above can meet;
 *  - the flat ground: MW2's ground is a fill below the horizon, not
 *    geometry, so a ray below the horizon meets a plane at the height the
 *    player stands on (world_ground_height_near under the player).
 *
 * Not world_raycast itself: it also answers for class-0 boxes, collision
 * volumes that are not always drawn - in AMY_SCN1 one stands 6 m ahead of
 * the start position's eye, under a reticle that sees open desert.
 *
 * The game's queries leave their normals in the collision globals, which
 * the sim reads after its own queries; every one made here is between
 * passes, so the globals are put back as they were.
 *
 * @portOnly
 */
import * as THREE from 'three';
import { Ray } from '../../generated/classes.gen.ts';
import { rayCopy, rayLength, raySetPoints } from '../../engine/collision/ray.ts';
import { objectLists } from '../../engine/scene/objectLists.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { collision, rayBoundSphereDistance, worldGroundHeightNear, worldObjectRaycast } from '../../sim/world/collision.ts';
import { CM_TO_UNITS, fromThree } from '../bridge/space.ts';

const caster = new THREE.Raycaster();
const fwd = new THREE.Vector3();
const end = new THREE.Vector3();
const ray = new Ray();
const trial = new Ray();

/**
 * The view depth (metres along `eye`'s forward axis) of the first surface on
 * the ray from `eye` through `ndc`, between minDepth and maxDepth; maxDepth
 * when nothing is met. `skip` leaves a mesh out of the drawn-world test.
 */
export function aimDepth(eye: THREE.PerspectiveCamera, ndc: THREE.Vector2, meshes: THREE.Object3D[], skip: (mesh: THREE.Object3D) => boolean, minDepth: number, maxDepth: number): number {
  caster.setFromCamera(ndc, eye);
  const dir = caster.ray.direction;
  eye.getWorldDirection(fwd);
  // ray length per metre of view depth
  const k = dir.dot(fwd);
  if (k <= 1e-3) return maxDepth;
  const far = maxDepth / k;
  caster.near = minDepth / k;
  caster.far = far;
  let best = far;

  for (const hit of caster.intersectObjects(meshes, false)) {
    if (skip(hit.object)) continue;
    best = Math.min(best, hit.distance);
    break;
  }

  const saved = { ...collision };
  try {
    // the terrain the mechs walk on
    const [sx, sy, sz] = fromThree(caster.ray.origin.x, caster.ray.origin.y, caster.ray.origin.z);
    caster.ray.at(best, end);
    const [ex, ey, ez] = fromThree(end.x, end.y, end.z);
    raySetPoints(ray, sx, sy, sz, ex, ey, ez);
    // the length is computed on first use, as world_raycast does before its sphere tests
    if (rayLength(ray) < 1) return Math.min(maxDepth, Math.max(minDepth, best * k));
    for (let o = objectLists.worldRoot?.worldNext ?? null; o; o = o.worldNext) {
      if (o.objectClass !== 5) continue;
      const d = rayBoundSphereDistance(o, ray);
      if (d === 0x7fffffff) continue;
      rayCopy(trial, ray);
      if (worldObjectRaycast(o, trial, d) === 0) continue;
      best = Math.min(best, rayLength(trial) * CM_TO_UNITS);
    }
    // the flat ground, at the height the player stands on
    const p = mechs.mechTable[mechs.playerMechIndex];
    if (p && dir.y < -1e-4) {
      const ground = worldGroundHeightNear(p.posX, p.posY, p.posZ) * CM_TO_UNITS;
      const t = (caster.ray.origin.y - ground) / -dir.y;
      if (t > 0) best = Math.min(best, t);
    }
  } finally {
    Object.assign(collision, saved);
  }
  return Math.min(maxDepth, Math.max(minDepth, best * k));
}
