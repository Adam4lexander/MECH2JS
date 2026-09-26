// The headset's cull viewer: the game's viewer standing at the head, its far
// distance pushed out by the VR view setting - and the game's own viewer left
// as it was, since the flat view and the game's sim read it.
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
