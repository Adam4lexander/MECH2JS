// The presentation model (engine/scene/present.ts): a node the last pass moved
// is drawn between where it was before the pass and where the pass left it; at
// alpha = 1 - and whenever the host is not presenting - every accessor hands
// back the simulation's own values; a node the pass created, or one it turned
// a quarter turn or more, is drawn where it is; a presented draw puts back
// everything it touched.
import { describe, expect, it } from 'vitest';
import { MeshBlock, MeshVertex, WorldObject } from '../../src/generated/classes.gen.ts';
import { matrixFromEuler } from '../../src/core/math/matrix.ts';
import { sceneNodeCreate, sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk } from '../../src/engine/scene/sceneGraph.ts';
import {
  ALPHA_ONE,
  present,
  presentFrameBegin,
  presentFrameEnd,
  presentLerpAngle,
  presentObjectPos,
  presentPassBegin,
  presentUnwear,
  presentWear,
  presentWearMesh,
  presentWorldBlock,
} from '../../src/engine/scene/present.ts';
import { meshTransformToWorld } from '../../src/engine/scene/worldObject.ts';
import { objectLink, objectListsReset, objectMoveToAltList, objectMoveToWorldList } from '../../src/engine/scene/objectLists.ts';

const DEG = 0x10000;

/** A root with one child node, both walked once in a pass of their own. */
function scene() {
  presentPassBegin();
  const root = sceneNodeCreate(null, 4)!;
  const node = sceneNodeCreate(root, 4)!;
  sceneNodeWalk(root);
  presentPassBegin();
  return { root, node };
}

/** One pass that moves `node` to (x, y, z) facing `yaw`. */
function pass(root: ReturnType<typeof scene>['root'], node: ReturnType<typeof scene>['node'], x: number, y: number, z: number, yaw: number) {
  presentPassBegin();
  sceneNodeSetEuler(node, 0, yaw, 0, 0);
  sceneNodeSetOrigin(node, x, y, z);
  sceneNodeWalk(root);
}

describe('presentation between passes', () => {
  it('draws a moved node between its two poses, and the pass itself at alpha = 1', () => {
    const { root, node } = scene();
    pass(root, node, 0, 0, 0, 0);
    pass(root, node, 1000, -200, 4000, 10 * DEG);
    presentFrameBegin(ALPHA_ONE);
    expect(presentWorldBlock(node)).toBe(node.worldBlock);
    presentFrameBegin(0);
    const at0 = Array.from(presentWorldBlock(node));
    expect(at0.slice(9)).toEqual([0, 0, 0]);
    presentFrameBegin(0x8000);
    const half = presentWorldBlock(node);
    expect(Array.from(half.subarray(9))).toEqual([500, -100, 2000]);
    // halfway round: the rotation is 5 degrees of yaw, to the precision of 2.29 renormalised
    const want = new Int32Array(12);
    matrixFromEuler(want, 0, 5 * DEG, 0, 0, 0, 0, 0);
    for (let i = 0; i < 9; i++) expect(Math.abs(half[i]! - want[i]!)).toBeLessThan(0x20000);
    presentFrameEnd();
    expect(presentWorldBlock(node)).toBe(node.worldBlock);
  });

  it('draws a node the pass did not move, or created, where it is', () => {
    const { root, node } = scene();
    pass(root, node, 500, 0, 0, 0);
    presentPassBegin(); // a pass that does not touch the node
    presentFrameBegin(0);
    expect(presentWorldBlock(node)).toBe(node.worldBlock);
    presentPassBegin();
    const born = sceneNodeCreate(root, 4)!;
    sceneNodeSetOrigin(born, 9000, 0, 0);
    sceneNodeWalk(root);
    presentFrameBegin(0);
    expect(presentWorldBlock(born)).toBe(born.worldBlock);
    presentFrameEnd();
  });

  it('draws a pooled object where it is on the pass it comes back into the drawn world', () => {
    const { root, node } = scene();
    objectListsReset();
    const obj = new WorldObject();
    obj.node = node;
    node.userData = obj;
    objectLink(obj);
    objectMoveToAltList(obj); // hidden, as a spent round waits in its slot
    pass(root, node, 0, 0, 0, 0);
    // fired: put at the muzzle and back on the world list in one pass
    pass(root, node, 40000, 500, -9000, 30 * DEG);
    objectMoveToWorldList(obj);
    presentFrameBegin(0);
    expect(presentWorldBlock(node)).toBe(node.worldBlock);
    presentFrameEnd();
    // the next pass it flies, and is drawn between
    pass(root, node, 41000, 500, -9000, 30 * DEG);
    presentFrameBegin(0);
    expect(Array.from(presentWorldBlock(node).subarray(9))).toEqual([40000, 500, -9000]);
    presentFrameEnd();
  });

  it('draws a quarter turn or more in one pass where it ended', () => {
    const { root, node } = scene();
    pass(root, node, 0, 0, 0, 0);
    pass(root, node, 100, 0, 0, 120 * DEG);
    presentFrameBegin(0x8000);
    expect(Array.from(presentWorldBlock(node))).toEqual(Array.from(node.worldBlock));
    presentFrameEnd();
  });

  it('turns an angle the short way round', () => {
    presentFrameBegin(0x8000);
    expect(presentLerpAngle(350 * DEG, 10 * DEG, 360 * DEG)).toBe(360 * DEG);
    expect(presentLerpAngle(10 * DEG, 350 * DEG, 360 * DEG)).toBe(0);
    expect(presentLerpAngle(0, 90 * DEG, 360 * DEG)).toBe(45 * DEG);
    presentFrameEnd();
  });

  it('a presented draw puts back the position, mesh choice and vertices it wore', () => {
    const { root, node } = scene();
    const obj = new WorldObject();
    obj.node = node;
    node.userData = obj;
    obj.localX = 10;
    obj.localY = 20;
    obj.localZ = 30;
    const mesh = new MeshBlock();
    mesh.vertexCount = 3;
    mesh.vertices = [0, 1, 2].map((i) => Object.assign(new MeshVertex(), { modelX: i * 100, modelY: 50, modelZ: -i * 70 }));
    const other = new MeshBlock();
    obj.meshList = mesh;
    pass(root, node, 0, 0, 0, 0);
    pass(root, node, 3000, 0, -1000, 20 * DEG);
    // the pass's own state: the mesh current at the pass's pose, a coarser one chosen
    obj.posX = 111;
    obj.posY = 222;
    obj.posZ = 333;
    obj.transformVersion = 7;
    meshTransformToWorld(mesh, node.worldBlock);
    mesh.transformVersion = 7;
    obj.currentMesh = other;
    const verts = () => mesh.vertices.slice(0, 3).map((v) => [v.worldX, v.worldY, v.worldZ]);
    const before = verts();

    presentFrameBegin(0x4000);
    presentWear(obj);
    expect([obj.posX, obj.posY, obj.posZ]).toEqual(presentObjectPos(obj));
    obj.currentMesh = mesh; // the draw's LOD choice
    presentWearMesh(mesh);
    expect(verts()).not.toEqual(before);
    presentUnwear();
    presentFrameEnd();

    expect([obj.posX, obj.posY, obj.posZ]).toEqual([111, 222, 333]);
    expect(obj.currentMesh).toBe(other);
    expect(mesh.transformVersion).toBe(7);
    expect(verts()).toEqual(before);
  });

  it('numbers the passes, and a pass begins at alpha = 1', () => {
    const g = present.generation;
    presentPassBegin();
    expect(present.generation).toBe((g + 1) | 0);
    expect(present.alpha).toBe(ALPHA_ONE);
  });
});
