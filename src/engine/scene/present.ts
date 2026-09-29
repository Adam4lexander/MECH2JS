/**
 * Presentation between passes of main's loop.
 *
 * The simulation runs in passes at a fixed step (the host's choice; the
 * original ran a pass as fast as the PC allowed). The host draws more often
 * than that, so it draws the world as it stood a fraction `alpha` of the way
 * from the end of the pass before the last to the end of the last. That is
 * the whole model:
 *
 *  - The pass boundary (presentPassBegin, from main's loop) numbers the
 *    passes (present.generation).
 *  - A node keeps its world transform as it stood before the pass first
 *    wrote it (SceneNode.prevWorldBlock, taken by the scene graph just
 *    before it writes worldBlock), and which pass that was (presentGen). A
 *    node the last pass did not write has not moved. One it created, or
 *    whose object it brought into the drawn world (presentFreshGen) - a
 *    pooled projectile or effect, taken off altRootNode's list and put where
 *    it is fired from - has nothing to be drawn from, and is drawn where it
 *    is.
 *  - The viewer keeps its pose the same way (sim/camera/viewerPresent.ts),
 *    and the HUD's world-anchored 2D the points it stood on
 *    (sim/cockpit/overlay.ts).
 *  - What is presented is kept in the game's own formats (cm, 2.29), so the
 *    ported render and HUD code runs on it unchanged.
 *
 * At alpha = 1 (and whenever the host is not presenting) every function here
 * hands back the simulation's own values, the same objects, so a draw then is
 * exactly the draw the pass would have made. The simulation never reads a
 * presented value, and a presented draw puts back everything it touches
 * (presentWear / presentUnwear).
 *
 * @portOnly the host draws between passes; the original drew once a pass
 */
import type { MeshBlock, SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { dot3r29 } from '../../core/int/i64.ts';
import { matrixRenormalise } from '../../core/math/matrix.ts';
import { registerGlobals } from '../globals.ts';
import { meshTransformToWorld, objectRefreshMesh } from './worldObject.ts';

/** alpha at the end of the last pass: 1.0 in 16.16 */
export const ALPHA_ONE = 0x10000;

export const present = registerGlobals(
  'present',
  {
    /**
     * Passes begun so far. Never reset: a node that outlives a reset must
     * not see its old number come round again.
     */
    generation: 0,
    /** display frames presented so far (the presentBlock cache's key) */
    frame: 0,
    /** how far the current display frame is from the pass before the last (0) to the last (ALPHA_ONE), 16.16 */
    alpha: ALPHA_ONE,
  },
  () => {
    present.alpha = ALPHA_ONE;
  },
);

/** The pass boundary: main's loop is about to run a pass (or a turn of its pause wait). */
export function presentPassBegin(): void {
  present.generation = (present.generation + 1) | 0;
  present.alpha = ALPHA_ONE;
}

/** The host begins drawing a display frame at `alpha` (16.16, clamped to 0..ALPHA_ONE). */
export function presentFrameBegin(alpha: number): void {
  present.frame = (present.frame + 1) | 0;
  present.alpha = Math.max(0, Math.min(ALPHA_ONE, alpha | 0));
}

/** The host has drawn its frame: until the next one, everything is as the pass left it. */
export function presentFrameEnd(): void {
  present.alpha = ALPHA_ONE;
}

/** Whether a draw now is between passes rather than at the last one. */
export function presenting(): boolean {
  return present.alpha < ALPHA_ONE;
}

/** The scene graph is about to write the node's world transform. */
export function presentNoteWorldWrite(n: SceneNode): void {
  if (n.presentGen === present.generation) return;
  n.prevWorldBlock.set(n.worldBlock);
  n.presentGen = present.generation;
}

/**
 * The node was (re)initialised, or its object joined the drawn world
 * (worldRootNode's list), in this pass: whatever its transform was before,
 * nothing of it was on screen.
 */
export function presentNoteFresh(n: SceneNode): void {
  n.presentGen = present.generation;
  n.presentFreshGen = present.generation;
}

/** Whether the node moved in the last pass and is being presented between passes. */
export function presentMoving(n: SceneNode): boolean {
  return presenting() && n.presentGen === present.generation && n.presentFreshGen !== present.generation;
}

/** a + (b - a) * alpha, in doubles so a jump of any size cannot wrap */
const lerp = (a: number, b: number, alpha: number): number => (a + Math.trunc(((b - a) * alpha) / ALPHA_ONE)) | 0;

/** An int as presented: from a (the pass before) to b (the last pass) by present.alpha. */
export function presentLerp(a: number, b: number): number {
  return lerp(a, b, present.alpha);
}

/** An angle as presented, the short way round a turn of `full` units (0x1680000 for 16.16 degrees). */
export function presentLerpAngle(a: number, b: number, full: number): number {
  let d = (b - a) % full;
  if (d > full / 2) d -= full;
  else if (d < -full / 2) d += full;
  return (a + Math.trunc((d * present.alpha) / ALPHA_ONE)) | 0;
}

/**
 * The node's world transform as presented: worldBlock itself unless the node
 * moved in the last pass; otherwise the translation interpolated and the
 * rotation interpolated element by element and renormalised
 * (matrix_renormalise, as the game keeps its own matrices). A rotation of a
 * quarter turn or more in one pass - which interpolation cannot follow - is
 * drawn where it ended.
 */
export function presentWorldBlock(n: SceneNode): Int32Array {
  if (!presentMoving(n)) return n.worldBlock;
  const out = n.presentBlock;
  if (n.presentFrame === present.frame) return out;
  n.presentFrame = present.frame;
  const a = n.prevWorldBlock;
  const b = n.worldBlock;
  for (let r = 0; r < 9; r += 3) {
    if (a[r]! * b[r]! + a[r + 1]! * b[r + 1]! + a[r + 2]! * b[r + 2]! < 0) {
      out.set(b);
      return out;
    }
  }
  const t = present.alpha;
  for (let i = 0; i < 12; i++) out[i] = lerp(a[i]!, b[i]!, t);
  matrixRenormalise(out);
  return out;
}

/** An object's world position as presented: object_update_world_pos's arithmetic on the presented transform. */
export function presentObjectPos(obj: WorldObject): [number, number, number] {
  const n = obj.node;
  if (!n || !presentMoving(n)) return [obj.posX, obj.posY, obj.posZ];
  const t = presentWorldBlock(n);
  const x = obj.localX;
  const y = obj.localY;
  const z = obj.localZ;
  return [
    (dot3r29(t[0]!, x, t[1]!, y, t[2]!, z) + t[9]!) | 0,
    (dot3r29(t[3]!, x, t[4]!, y, t[5]!, z) + t[10]!) | 0,
    (dot3r29(t[6]!, x, t[7]!, y, t[8]!, z) + t[11]!) | 0,
  ];
}

/** A mesh as it stood before a presented draw wrote it: its stamp, world vertices and world normals. */
interface SavedMesh {
  mesh: MeshBlock;
  version: number;
  vertices: Int32Array;
  normals: Int32Array;
}

/**
 * The object a presented draw is working on, and what it has to put back:
 * the render pipeline's cull and clipper read an object's position, choose
 * its current mesh and bring that mesh's world vertices up to date, and all
 * of that is simulation state (a class-2 object's collision reads its
 * currentMesh's vertices without looking at their stamp).
 */
const worn = {
  obj: null as WorldObject | null,
  moving: false,
  posX: 0,
  posY: 0,
  posZ: 0,
  currentMesh: null as MeshBlock | null,
  meshes: [] as SavedMesh[],
};

/** Keeps the mesh as it stands, once per presented draw, to be put back by presentUnwear. */
function saveMesh(m: MeshBlock): void {
  if (worn.meshes.some((s) => s.mesh === m)) return;
  const vertices = new Int32Array(m.vertexCount * 3);
  for (let i = 0; i < m.vertexCount; i++) {
    const v = m.vertices[i]!;
    vertices[i * 3] = v.worldX;
    vertices[i * 3 + 1] = v.worldY;
    vertices[i * 3 + 2] = v.worldZ;
  }
  const normals = new Int32Array(m.polygonCount * 3);
  for (let i = 0; i < m.polygonCount; i++) {
    const p = m.polygons[i]!;
    normals[i * 3] = p.normalX;
    normals[i * 3 + 1] = p.normalY;
    normals[i * 3 + 2] = p.normalZ;
  }
  worn.meshes.push({ mesh: m, version: m.transformVersion, vertices, normals });
}

/**
 * A presented draw of `obj` begins: while it lasts the object stands where it
 * is presented (posX/Y/Z). Every presentWear is paired with presentUnwear
 * before any other object is worn or any simulation code runs.
 */
export function presentWear(obj: WorldObject): void {
  const w = worn;
  w.obj = obj;
  w.currentMesh = obj.currentMesh;
  w.meshes.length = 0;
  w.moving = obj.node !== null && presentMoving(obj.node);
  if (!w.moving) return;
  w.posX = obj.posX;
  w.posY = obj.posY;
  w.posZ = obj.posZ;
  [obj.posX, obj.posY, obj.posZ] = presentObjectPos(obj);
}

/** object_refresh_mesh as a presented draw asks for it: the mesh kept first. */
export function presentRefreshMesh(obj: WorldObject): void {
  if (!obj.node || !obj.currentMesh) return;
  saveMesh(obj.currentMesh);
  objectRefreshMesh(obj);
}

/**
 * The mesh the draw chose for the worn object: for an object presented
 * moving, its world vertices (and normals) are transformed to the presented
 * pose, whatever its stamp says.
 */
export function presentWearMesh(m: MeshBlock): void {
  const w = worn;
  if (!w.moving || !w.obj) return;
  saveMesh(m);
  meshTransformToWorld(m, presentWorldBlock(w.obj.node!));
}

/** The presented draw of the worn object is done: its position, mesh choice and every mesh it wrote are the pass's again. */
export function presentUnwear(): void {
  const w = worn;
  const obj = w.obj;
  if (!obj) return;
  if (w.moving) {
    obj.posX = w.posX;
    obj.posY = w.posY;
    obj.posZ = w.posZ;
  }
  for (const s of w.meshes) {
    const m = s.mesh;
    for (let i = 0; i < m.vertexCount; i++) {
      const v = m.vertices[i]!;
      v.worldX = s.vertices[i * 3]!;
      v.worldY = s.vertices[i * 3 + 1]!;
      v.worldZ = s.vertices[i * 3 + 2]!;
    }
    for (let i = 0; i < m.polygonCount; i++) {
      const p = m.polygons[i]!;
      p.normalX = s.normals[i * 3]!;
      p.normalY = s.normals[i * 3 + 1]!;
      p.normalZ = s.normals[i * 3 + 2]!;
    }
    m.transformVersion = s.version;
  }
  obj.currentMesh = w.currentMesh;
  w.obj = null;
  w.meshes.length = 0;
}
