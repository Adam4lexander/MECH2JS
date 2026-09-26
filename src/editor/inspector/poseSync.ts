/**
 * Keeps an entity's own pose fields and its scene node in step while the
 * game is paused in Edit mode.
 *
 * In play, the tick hooks own that relationship (e.g. the create hooks read
 * the node back into posX/posY/posZ and heading; the movement ticks push the
 * entity's pose into its node). None of them run while paused, so an edit to
 * one side would leave the other stale: an inspector edit of posX would not
 * move anything on screen, and a gizmo drag would leave posX saying the mech
 * is where it was. This applies the edit to the other side the way the game
 * itself does it - scene_node_set_origin / scene_node_set_euler + walk for
 * pos to node, the node's world position for node to pos.
 *
 * Applies to any struct with a SceneNode `node` and int posX/posY/posZ
 * (MechEntity and the other gamepiece structs).
 *
 * @portOnly
 */
import { SceneNode } from '../../generated/classes.gen.ts';
import { sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';

interface Posed {
  node: SceneNode;
  posX: number;
  posY: number;
  posZ: number;
  pitch?: number;
  heading?: number;
  roll?: number;
}

function posed(o: unknown): Posed | null {
  if (!o || typeof o !== 'object') return null;
  const p = o as Partial<Posed>;
  return p.node instanceof SceneNode && typeof p.posX === 'number' && typeof p.posY === 'number' && typeof p.posZ === 'number' ? (p as Posed) : null;
}

function rootOf(n: SceneNode): SceneNode {
  let r = n;
  while (r.parent) r = r.parent;
  return r;
}

const POS = new Set(['posX', 'posY', 'posZ']);
const ANGLES = new Set(['pitch', 'heading', 'roll']);

/** After the inspector stored `field` on `obj`: move the node to match. */
export function syncNodeFromFields(obj: unknown, field: string): void {
  const p = posed(obj);
  if (!p || !(POS.has(field) || ANGLES.has(field))) return;
  const n = p.node;
  if (POS.has(field)) {
    // pos is the node's world position; move the local origin by the world delta so children work too
    sceneNodeSetOrigin(n, (n.localX + p.posX - n.worldPos[0]!) | 0, (n.localY + p.posY - n.worldPos[1]!) | 0, (n.localZ + p.posZ - n.worldPos[2]!) | 0);
  } else if (typeof p.heading === 'number') {
    // the order star_place_formation and the spawn path use: (pitch, yaw, roll), order 0
    sceneNodeSetEuler(n, p.pitch ?? 0, p.heading, p.roll ?? 0, 0);
  }
  sceneNodeWalk(rootOf(n));
}

/** After the gizmo moved `obj`'s node: read its world position back into posX/posY/posZ. */
export function syncFieldsFromNode(obj: unknown): void {
  const p = posed(obj);
  if (!p) return;
  p.posX = p.node.worldPos[0]!;
  p.posY = p.node.worldPos[1]!;
  p.posZ = p.node.worldPos[2]!;
}
