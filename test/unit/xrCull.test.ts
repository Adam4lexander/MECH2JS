// The headset's cull viewer: the game's viewer standing at the head, its far
// distance pushed out by the VR view setting - and the game's own viewer left
// as it was, since the flat view and the game's sim read it. And what rides
// with the cockpit rather than the world: the reticle, the mech's own parts.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Viewer } from '../../src/generated/classes.gen.ts';
import { XrRig } from '../../src/render/xr/xrRig.ts';
import { XR_DEFAULTS } from '../../src/render/xr/xrSettings.ts';

function gameViewer(): Viewer {
  const v = new Viewer();
  v.farClip = 150000;
  v.field_0xb4 = 150000;
  return v;
}

function head(): THREE.Camera {
  const c = new THREE.PerspectiveCamera();
  c.position.set(10, 8, -20);
  c.updateMatrixWorld();
  return c;
}

describe('XrRig.cullViewer', () => {
  it("pushes the far distance out by viewDistance, and leaves the game's viewer alone", () => {
    const rig = new XrRig();
    rig.settings = { ...XR_DEFAULTS, viewDistance: 3 };
    const src = gameViewer();
    const out = rig.cullViewer(head(), src, new Viewer());
    expect(out.farClip).toBe(450000);
    expect(out.field_0xb4).toBe(450000);
    expect(src.farClip).toBe(150000);
    expect(src.field_0xb4).toBe(150000);
  });

  it("keeps the original's far distance at 1", () => {
    const rig = new XrRig();
    rig.settings = { ...XR_DEFAULTS, viewDistance: 1 };
    const out = rig.cullViewer(head(), gameViewer(), new Viewer());
    expect(out.farClip).toBe(150000);
    expect(out.field_0xb4).toBe(150000);
  });

  it('keeps the far distance under 2^29 cm, so the clipper latching it times 4 does not overflow', () => {
    const rig = new XrRig();
    rig.settings = { ...XR_DEFAULTS, viewDistance: 8 };
    const src = gameViewer();
    src.farClip = 0x10000000;
    src.field_0xb4 = 0x10000000;
    const out = rig.cullViewer(head(), src, new Viewer());
    expect(out.farClip).toBe(0x1fffffff);
    expect(Math.imul(out.farClip, 4)).toBeGreaterThan(0);
  });
});

describe('the mech\'s own parts in a headset', () => {
  it('carries the reticle with the rig, not the pass\'s eye', () => {
    const rig = new XrRig();
    const eye = head();
    rig.recordPass(eye, 0);
    rig.update(0);
    const mesh = new THREE.Object3D();
    rig.placeCarried(mesh, 50, 1, 0.75);
    expect(mesh.parent).toBe(rig.rig);
    expect(mesh.position.toArray()).toEqual([0, 0, -50]);
  });

  it("moves only the owner's parts in the world pass", async () => {
    const { SceneRenderer } = await import('../../src/render/SceneRenderer.ts');
    const sr = new SceneRenderer();
    const entries = (sr as unknown as { entries: Map<object, { group: THREE.Group }> }).entries;
    const part = (type: number, index: number, into: THREE.Object3D) => {
      const group = new THREE.Group();
      into.add(group);
      const obj = { type, index };
      entries.set(obj, { group });
      return group;
    };
    const own = part(0x1a0, 3, sr.scene);
    const other = part(0x1a0, 4, sr.scene);
    const notAPart = part(0x200, 3, sr.scene);
    const cockpit = part(0x1a0, 3, sr.cockpitScene);
    sr.carryOwned(3, new THREE.Matrix4().makeTranslation(1, 2, 3));
    expect(own.matrix.elements.slice(12, 15)).toEqual([1, 2, 3]);
    for (const g of [other, notAPart, cockpit]) expect(g.matrix.elements.slice(12, 15)).toEqual([0, 0, 0]);
  });
});

describe('the rig between passes', () => {
  const at = (x: number) => {
    const c = new THREE.PerspectiveCamera();
    c.position.set(x, 0, 0);
    c.updateMatrixWorld();
    return c;
  };

  it('stands at the last pass when the loop runs every display frame', () => {
    const rig = new XrRig();
    rig.recordPass(at(0), 0);
    rig.recordPass(at(1), 11);
    rig.update(11, true);
    expect(rig.rig.position.x).toBe(1);
  });

  it('eases between the last two passes, a pass behind, at a fixed loop rate', () => {
    const rig = new XrRig();
    rig.recordPass(at(0), 0);
    rig.recordPass(at(1), 50);
    rig.update(50);
    expect(rig.rig.position.x).toBe(0);
    rig.update(75);
    expect(rig.rig.position.x).toBeCloseTo(0.5, 6);
  });
});
