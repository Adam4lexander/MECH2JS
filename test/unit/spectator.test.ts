// The spectator camera's pose (render/xr/spectator.ts): the smooth camera at
// the head, level, easing after its turn; the chase camera behind the torso's
// facing, looking over the mech; the field of view horizontal.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHASE, levelQuaternion, Spectator, SPECTATOR_DEFAULTS, yawPitch } from '../../src/render/xr/spectator.ts';

function posed(pos: [number, number, number], yaw: number, pitch: number, roll = 0): THREE.Object3D {
  const o = new THREE.Object3D();
  o.position.set(...pos);
  o.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
  o.updateMatrixWorld(true);
  return o;
}

const forward = (c: THREE.Camera) => new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);

describe('the smooth spectator', () => {
  it('stands at the head, turned as it is but level', () => {
    const sp = new Spectator();
    const head = posed([1, 2, 3], 0.4, -0.2, 0.3);
    const cam = sp.place({ ...SPECTATOR_DEFAULTS, mode: 'smooth' }, head, posed([0, 0, 0], 0, 0), 1 / 60, 16 / 9);
    expect(cam.position.toArray()).toEqual([1, 2, 3]);
    const yp = yawPitch(cam.quaternion);
    expect(yp.yaw).toBeCloseTo(0.4, 6);
    expect(yp.pitch).toBeCloseTo(-0.2, 6);
    // no roll: the camera's right stays level
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).y).toBeCloseTo(0, 6);
  });

  it('eases after a turn of the head, and follows it at once with no easing', () => {
    const s = { ...SPECTATOR_DEFAULTS, mode: 'smooth' as const, smooth: 0.5 };
    const sp = new Spectator();
    const rig = posed([0, 0, 0], 0, 0);
    sp.place(s, posed([0, 0, 0], 0, 0), rig, 1 / 60, 1);
    const cam = sp.place(s, posed([0, 0, 0], 1, 0), rig, 1 / 60, 1);
    const yaw = yawPitch(cam.quaternion).yaw;
    expect(yaw).toBeGreaterThan(0);
    expect(yaw).toBeLessThan(0.1);
    const now = new Spectator().place({ ...s, smooth: 0 }, posed([0, 0, 0], 1, 0), rig, 1 / 60, 1);
    expect(yawPitch(now.quaternion).yaw).toBeCloseTo(1, 6);
  });

  it('keeps its horizontal field of view whatever the page shape', () => {
    const sp = new Spectator();
    for (const aspect of [16 / 9, 4 / 3, 1]) {
      const cam = sp.place({ ...SPECTATOR_DEFAULTS, fov: 90 }, posed([0, 0, 0], 0, 0), posed([0, 0, 0], 0, 0), 0, aspect);
      const tanV = Math.tan((cam.fov * Math.PI) / 360);
      expect(tanV * aspect).toBeCloseTo(1, 6);
    }
  });
});

describe('the chase spectator', () => {
  it("stands behind and above the eye along the torso's facing, looking down over it", () => {
    const sp = new Spectator();
    const rig = posed([10, 5, 0], Math.PI / 2, 0.3);
    const cam = sp.place({ ...SPECTATOR_DEFAULTS, mode: 'chase' }, posed([10, 5, 0], 0, 0), rig, 1 / 60, 16 / 9);
    // yaw pi/2 faces -x; behind it is +x
    expect(cam.position.x).toBeCloseTo(10 + CHASE.back, 6);
    expect(cam.position.y).toBeCloseTo(5 + CHASE.up, 6);
    expect(cam.position.z).toBeCloseTo(0, 6);
    const f = forward(cam);
    expect(f.x).toBeLessThan(0);
    expect(f.y).toBeLessThan(0);
  });

  it('swings round after the mech as it turns, not at once', () => {
    const s = { ...SPECTATOR_DEFAULTS, mode: 'chase' as const, smooth: 0.5 };
    const sp = new Spectator();
    const head = posed([0, 0, 0], 0, 0);
    sp.place(s, head, posed([0, 0, 0], 0, 0), 1 / 60, 1);
    const cam = sp.place(s, head, posed([0, 0, 0], Math.PI / 2, 0), 1 / 60, 1);
    // still nearly behind the old facing (+z), a little way round
    expect(cam.position.z).toBeGreaterThan(CHASE.back * 0.9);
    expect(cam.position.x).toBeGreaterThan(0);
  });
});

it('levelQuaternion and yawPitch invert each other', () => {
  const { yaw, pitch } = yawPitch(levelQuaternion(-2.1, 0.7));
  expect(yaw).toBeCloseTo(-2.1, 6);
  expect(pitch).toBeCloseTo(0.7, 6);
});
