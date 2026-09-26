/**
 * The original cockpit shell, measured: where its glass is.
 *
 * Each chassis's shell (BM5_HEAD, TW5_HEAD, ...) is the one part of its
 * cockpit that is the mech's own - its window's shape, made by the
 * original's artists for that mech. The hand-built cockpits are cut to it:
 * the probe casts rays from the eye at the shell as the cockpit pass draws
 * it (the head's visible mesh, its model vertices through its node's world
 * matrix into pilot space) and traces the glass's outline, which glass.ts
 * holds for every chassis (test/sim/cockpits.test.ts measures it again).
 * (A first cut kept the shell itself, rescaled about the eye, as the
 * cabin's walls; scaled down its big flat faces read as slabs, not a
 * cockpit.)
 *
 * @portOnly
 */
import * as THREE from 'three';
import type { ObjEntry } from '../SceneRenderer.ts';
import { dir } from './kit.ts';

export class ShellProbe {
  private readonly mesh: THREE.Mesh;
  private readonly ray = new THREE.Raycaster();

  /** `head`: the shell's cockpit-pass entry; `eyeWorld`: the game camera's matrixWorld (pilot space to world). */
  constructor(head: Readonly<ObjEntry>, eyeWorld: THREE.Matrix4) {
    const toPilot = eyeWorld.clone().invert().multiply(head.group.matrix);
    const pos: number[] = [];
    for (const m of head.meshes) {
      if (!m.mesh.visible) continue;
      const p = m.basePos;
      for (let i = 0; i + 8 < p.length; i += 9) {
        // the fans' spare slots are all zeros: skip degenerate triangles
        const a = p.subarray(i, i + 9);
        if (a.every((v) => v === 0)) continue;
        for (let j = 0; j < 9; j++) pos.push(a[j]!);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.applyMatrix4(toPilot);
    g.computeBoundingSphere();
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.mesh.updateMatrixWorld(true);
  }

  /** Whether the shell has any faces. */
  get empty(): boolean {
    return (this.mesh.geometry.getAttribute('position')?.count ?? 0) === 0;
  }

  /** The distance (metres, the shell's own scale) to the shell along (yaw, pitch) degrees, or null for none within 30 m. */
  hit(yaw: number, pitch: number): number | null {
    const d = dir(yaw, pitch, 1);
    this.ray.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(d[0], d[1], d[2]));
    this.ray.far = 30;
    const h = this.ray.intersectObject(this.mesh, false)[0];
    return h ? h.distance : null;
  }

  /**
   * The glass: the window's outline as the eye sees it, `n` points round
   * straight ahead, each [yaw, pitch] in degrees - how far out from the view's
   * centre, at each angle round it, the first shell lies (to half a degree;
   * 120 where nothing does, looking all the way round).
   */
  outline(n = 48): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      const at = (r: number): [number, number] => [r * Math.cos(th), Math.max(-89, Math.min(89, r * Math.sin(th)))];
      let r = 120;
      for (let a = 2; a <= 120; a += 2) {
        if (this.hit(...at(a)) !== null) {
          r = a;
          break;
        }
      }
      // refine the step to half a degree
      if (r < 120) for (let a = r - 2; a <= r; a += 0.5) if (this.hit(...at(a)) !== null) {
        r = a;
        break;
      }
      out.push(at(r));
    }
    return out;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
