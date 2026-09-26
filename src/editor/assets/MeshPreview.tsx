/**
 * A turntable preview of WTBO records for the asset browser. Colours come
 * from the polygon codes the way polygon_resolve_colour reads them (flat
 * index, or ramp * 16 + shade with a fixed light); textured polygons show
 * their ramp's mid shade. This is a preview, not the game renderer.
 *
 * @portOnly
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { WtboRecord } from '../../data/formats/wtbo.ts';

function faceColour(code: number, shade: number, rgb: Uint8Array): [number, number, number] {
  const mode = code & 0x7000;
  let idx: number;
  if (mode === 0 || mode === 0x2000) idx = (code >> 4) & 0xff;
  else if (mode >= 0x5000) idx = 0x80 + 8; // textured: neutral
  else idx = (((code & 0xf00) >> 4) | shade) & 0xff;
  return [rgb[idx * 3]! / 255, rgb[idx * 3 + 1]! / 255, rgb[idx * 3 + 2]! / 255];
}

export function MeshPreview({ records, rgb }: { records: WtboRecord[]; rgb: Uint8Array }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const w = 320;
    const h = 240;
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(w, h);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202028);
    const pos: number[] = [];
    const col: number[] = [];
    const light = new THREE.Vector3(0.4, 0.8, -0.45).normalize();
    for (const r of records) {
      const partMode = (r.flags & 0x2000) !== 0;
      const nv = partMode ? r.vertexCount - 1 : r.vertexCount;
      for (const p of r.polygons) {
        if (p.indices.length < 3 || p.indices.some((i) => i >= nv)) continue;
        const P = (i: number) => new THREE.Vector3(r.positions[i * 3]!, r.positions[i * 3 + 1]!, -r.positions[i * 3 + 2]!);
        const a = P(p.indices[0]!);
        const n = new THREE.Vector3().crossVectors(P(p.indices[1]!).sub(a), P(p.indices[2]!).sub(a)).normalize();
        const shade = Math.max(0, Math.min(15, Math.round(8 + 7 * n.dot(light))));
        const [cr, cg, cb] = faceColour(p.code, shade, rgb);
        for (let k = 1; k + 1 < p.indices.length; k++) {
          for (const idx of [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!]) {
            pos.push(r.positions[idx * 3]!, r.positions[idx * 3 + 1]!, -r.positions[idx * 3 + 2]!);
            col.push(cr, cg, cb);
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    const pivot = new THREE.Group();
    const s = geo.boundingSphere!;
    mesh.position.copy(s.center).multiplyScalar(-1);
    pivot.add(mesh);
    scene.add(pivot);
    const cam = new THREE.PerspectiveCamera(45, w / h, s.radius / 100, s.radius * 10);
    cam.position.set(0, s.radius * 0.6, s.radius * 2.6);
    cam.lookAt(0, 0, 0);
    let raf = 0;
    const tick = () => {
      pivot.rotation.y += 0.01;
      renderer.render(scene, cam);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      geo.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [records, rgb]);
  return <div ref={host} className="mesh-preview" />;
}
