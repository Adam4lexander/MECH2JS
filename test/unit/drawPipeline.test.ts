// The clipper's depth path and the camera-to-viewer bridge. The failures
// these catch are silent ones: a sign or axis mistake in the depth row still
// yields plausible depths, just not the eye's, and every polygon still gets
// a shade - only the wrong one, varying the wrong way as the camera moves.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MeshPolygon, MeshVertex, Viewer } from '../../src/generated/classes.gen.ts';
import { viewerFromCamera } from '../../src/render/bridge/cameraViewer.ts';
import { toThree } from '../../src/render/bridge/space.ts';
import { renderView, viewerLatchGlobals } from '../../src/render/pipeline/viewLatch.ts';
import { clipLerp, clipRecordCount, clipRecords, meshResetClipState, polyDepthKey } from '../../src/render/pipeline/drawPipeline.ts';

const ONE = 0x20000000;

/** A viewer at `eye` (cm) looking along +Z (identity rotation), near 100 cm, far 10 km. */
function straightViewer(eye: [number, number, number]): Viewer {
  const v = new Viewer();
  v.rotation.set([ONE, 0, 0, 0, ONE, 0, 0, 0, ONE]);
  [v.translationX, v.translationY, v.translationZ] = eye;
  v.nearClip = 100;
  v.farClip = 1_000_000;
  v.field_0xb4 = v.farClip;
  v.lodScale = 0x10000;
  return v;
}

function vertex(x: number, y: number, z: number): MeshVertex {
  const v = new MeshVertex();
  [v.worldX, v.worldY, v.worldZ] = [x, y, z];
  return v;
}

/** A polygon over `verts` (all of them, in order) facing -Z, i.e. towards an eye looking along +Z. */
function polygon(verts: MeshVertex[]): MeshPolygon {
  const p = new MeshPolygon();
  p.vertexCount = verts.length;
  p.indices = verts.map((_, i) => i);
  [p.normalX, p.normalY, p.normalZ] = [0, 0, -0x10000];
  return p;
}

function key(verts: MeshVertex[], sortFlags = 0): number | null {
  renderView.polySortFlags = sortFlags;
  meshResetClipState({ vertexCount: verts.length, vertices: verts } as never);
  return polyDepthKey(polygon(verts), verts);
}

describe('poly_clip_and_queue depth key', () => {
  it('is the max, min or mean of the vertex depths (x4 cm) per polySortFlags', () => {
    viewerLatchGlobals(straightViewer([0, 0, 0]));
    const quad = () => [vertex(-100, -100, 1000), vertex(100, -100, 2000), vertex(100, 100, 3000), vertex(-100, 100, 6000)];
    expect(key(quad())).toBe(4 * 6000);
    expect(key(quad(), 4)).toBe(4 * 1000);
    expect(key(quad(), 2)).toBe(4 * 3000);
    expect(key(quad(), 1)).toBe((4 * 6000) | 0x40000000);
  });

  it('near-plane crossings join the records at exactly viewNearClipScaled', () => {
    viewerLatchGlobals(straightViewer([0, 0, 0]));
    // one vertex behind the eye: two crossings replace it
    const tri = () => [vertex(-100, 0, 50), vertex(100, 0, 5000), vertex(0, 100, 4000)];
    expect(key(tri(), 4)).toBe(4 * 100);
    expect(key(tri())).toBe(4 * 5000);
  });

  it('rejects what the original does not queue', () => {
    viewerLatchGlobals(straightViewer([0, 0, 0]));
    expect(key([vertex(-100, 0, 50), vertex(100, 0, 60), vertex(0, 100, 70)])).toBeNull(); // all nearer than near
    expect(key([vertex(-100, 0, 2e6), vertex(100, 0, 2e6), vertex(0, 100, 2e6)])).toBeNull(); // all beyond far
    const verts = [vertex(-100, 0, 1000), vertex(100, 0, 1000), vertex(0, 100, 1000)];
    const away = polygon(verts);
    away.normalZ = 0x10000; // facing away from the eye
    meshResetClipState({ vertexCount: 3, vertices: verts } as never);
    expect(polyDepthKey(away, verts)).toBeNull();
  });

  it('depends on view depth, not on where the eye is across the view', () => {
    const quad = () => [vertex(-5000, 0, 20000), vertex(5000, 0, 20000), vertex(5000, 0, 30000), vertex(-5000, 0, 30000)];
    viewerLatchGlobals(straightViewer([0, 3000, 0]));
    const a = key(quad());
    viewerLatchGlobals(straightViewer([40000, -2000, 0])); // moved sideways and down, same depth axis
    const b = key(quad());
    viewerLatchGlobals(straightViewer([0, 3000, 5000])); // moved forward 50 m
    const c = key(quad());
    expect(a).toBe(4 * 30000);
    expect(b).toBe(a);
    expect(c).toBe(4 * 25000);
  });
});

describe('clip_vertex_at_near_plane records', () => {
  it('replace a vertex behind the near plane with two crossings, measured from the nearer endpoint', () => {
    viewerLatchGlobals(straightViewer([0, 0, 0]));
    // a floor 1 m below the eye (normal +Y, facing it), one corner behind the eye
    const vs = [vertex(0, -100, -500), vertex(1000, -100, 4000), vertex(-1000, -100, 4000)];
    vs[0]!.texU = 0xd0;
    vs[1]!.texU = 0xde;
    vs[2]!.texU = 0xd4;
    const floor = polygon(vs);
    [floor.normalX, floor.normalY, floor.normalZ] = [0, 0x10000, 0];
    renderView.polySortFlags = 0;
    meshResetClipState({ vertexCount: 3, vertices: vs } as never);
    expect(polyDepthKey(floor, vs)).toBe(4 * 4000);
    expect(clipRecordCount).toBe(4); // crossing, v1, v2, crossing
    const [c0, r1, r2, c3] = clipRecords;
    expect([r1!.b, r2!.b]).toEqual([null, null]);
    expect([r1!.a, r2!.a]).toEqual([vs[1], vs[2]]);
    for (const c of [c0!, c3!]) {
      expect(c.a).toBe(vs[0]); // the nearer endpoint, whichever way the edge runs
      expect(c.num).toBe(4 * 100 - 4 * -500);
      const u = clipLerp(c.a.texU << 16, c.b!.texU << 16, c.num, c.den);
      const lo = Math.min(c.a.texU, c.b!.texU) << 16;
      const hi = Math.max(c.a.texU, c.b!.texU) << 16;
      expect(u >= lo && u <= hi).toBe(true); // interpolated, never extrapolated
    }
    expect(c0!.b).toBe(vs[1]);
    expect(c3!.b).toBe(vs[2]);
  });

  it('clipLerp is a + (b - a) * num / den with a 64-bit product and a truncating divide', () => {
    for (const [a, b, num, den] of [
      [0xd00000, 0xde0000, 2400, 18000],
      [0xde0000, 0xd00000, 2400, 18000],
      [-5, 7, 1, 3],
      [0x7fff0000, -0x7fff0000, 0x7fffffff, 0x7fffffff],
    ] as const) {
      const want = Number((BigInt(b - a | 0) * BigInt(num)) / BigInt(den) + BigInt(a)) | 0;
      expect(clipLerp(a, b, num, den)).toBe(want);
    }
  });
});

describe('viewerFromCamera', () => {
  it("puts the viewer's depth row along the three.js camera's view direction", () => {
    const cam = new THREE.PerspectiveCamera();
    const out = new Viewer();
    for (let i = 0; i < 200; i++) {
      cam.position.set((i % 7) * 13 - 40, (i % 5) * 3, (i % 11) * -9 + 20);
      cam.rotation.set(Math.sin(i) * 1.2, i * 0.7, Math.cos(i * 3) * 0.3, 'YXZ');
      cam.updateMatrixWorld();
      viewerLatchGlobals(viewerFromCamera(cam, straightViewer([0, 0, 0]), out));
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      // 250 m ahead, and 30 m ahead plus 40 m to the side: depths 25000 and 3000 cm
      for (const [p, cm] of [
        [cam.position.clone().addScaledVector(fwd, 250), 25000],
        [cam.position.clone().addScaledVector(fwd, 30).addScaledVector(side, 40), 3000],
      ] as const) {
        const game = [Math.round(p.x * 100), Math.round(p.y * 100), Math.round(-p.z * 100)] as const;
        expect(toThree(...game).map((c, k) => Math.abs(c - [p.x, p.y, p.z][k]!) < 0.01)).toEqual([true, true, true]);
        const v = [vertex(...game)];
        const k = key(v);
        expect(Math.abs(k! - 4 * cm)).toBeLessThanOrEqual(8);
      }
    }
  });
});
