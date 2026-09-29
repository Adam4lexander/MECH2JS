// The front end's panel in a headset: curved round the head, every column
// as far from the eye, and the screen upright on it (u across from the left,
// v up), so it reads as the page shows it.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { curvedPanel, PANEL_DISTANCE, PANEL_DROP, PANEL_WIDTH } from '../../src/render/xr/screenRoom.ts';

describe('the curved panel', () => {
  const panel = new THREE.Mesh(curvedPanel(), new THREE.MeshBasicMaterial());
  const caster = new THREE.Raycaster();
  const hit = (dir: THREE.Vector3) => {
    caster.set(new THREE.Vector3(0, 0, 0), dir.normalize());
    const h = caster.intersectObject(panel, false)[0];
    return h ? { distance: h.distance, uv: h.uv! } : null;
  };

  it("is PANEL_DISTANCE from the head all along its middle row, the screen's centre straight ahead", () => {
    const c = hit(new THREE.Vector3(0, -PANEL_DROP, -PANEL_DISTANCE))!;
    expect(c.distance).toBeCloseTo(Math.hypot(PANEL_DISTANCE, PANEL_DROP), 2);
    expect(c.uv.x).toBeCloseTo(0.5, 2);
    expect(c.uv.y).toBeCloseTo(0.5, 2);
    // a column turned away from straight ahead is as far, and the curve's length to it is its share of the width
    const a = 0.3;
    const side = hit(new THREE.Vector3(Math.sin(a), -PANEL_DROP / PANEL_DISTANCE, -Math.cos(a)))!;
    expect(side.distance).toBeCloseTo(Math.hypot(PANEL_DISTANCE, PANEL_DROP), 1);
    expect(side.uv.x).toBeCloseTo(0.5 + (a * PANEL_DISTANCE) / PANEL_WIDTH, 2);
  });

  it('has the screen upright and unmirrored: v runs up, u from the left', () => {
    expect(hit(new THREE.Vector3(0, 0.3, -PANEL_DISTANCE))!.uv.y).toBeGreaterThan(0.5);
    expect(hit(new THREE.Vector3(-0.3, -PANEL_DROP, -PANEL_DISTANCE))!.uv.x).toBeLessThan(0.5);
  });

  it('faces the head and ends at its edges', () => {
    expect(hit(new THREE.Vector3(0, 3, -PANEL_DISTANCE))).toBeNull();
    expect(hit(new THREE.Vector3(0, 0, PANEL_DISTANCE))).toBeNull();
    // front faces only (MeshBasicMaterial's default side): a ray from the head meets the side it sees
    const n = new THREE.Vector3().fromBufferAttribute(panel.geometry.getAttribute('normal') as THREE.BufferAttribute, 0);
    expect(n.z).toBeGreaterThan(0);
  });
});
