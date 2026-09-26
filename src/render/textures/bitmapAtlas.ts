/**
 * Every CEL the mission's bitmap3d blocks reference, packed into one R8
 * texture of palette indices, and a 512-entry slot table the shader reads to
 * find each slot's current frame. The slot table is refreshed each frame from
 * bitmap3d_draw's frame selection (bitmap3dDrawFrame), so animated slots
 * (bitmap3d_animate) animate.
 *
 * @portOnly
 */
import * as THREE from 'three';
import { parseCel } from '../../data/formats/image.ts';
import { cacheLoadResource } from '../../engine/resources/cache.ts';
import { bitmap3d, bitmap3dDrawFrame, BITMAP3D_SLOT_COUNT } from '../../sim/world/bitmap3d.ts';
import type { IndexedUniforms } from '../materials/indexedMaterial.ts';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class BitmapAtlas {
  private rects = new Map<number, Rect>();

  /** Packs every CEL any bitmap3d frame references (shelf packing, 2048 wide). */
  build(u: IndexedUniforms): void {
    const ids = new Set<number>();
    for (const block of bitmap3d.bitmap3dFrames) for (const f of block) if (f.celId >= 1) ids.add(f.celId);
    const cels = [...ids]
      .map((id) => {
        const b = cacheLoadResource(id, 'CEL');
        return b ? { id, cel: parseCel(b) } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.cel.height - a.cel.height);
    const W = 2048;
    let x = 0;
    let y = 0;
    let rowH = 0;
    this.rects.clear();
    for (const { id, cel } of cels) {
      if (x + cel.width > W) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      this.rects.set(id, { x, y, w: cel.width, h: cel.height });
      x += cel.width;
      rowH = Math.max(rowH, cel.height);
    }
    const H = Math.max(1, y + rowH);
    const data = new Uint8Array(W * H);
    for (const { id, cel } of cels) {
      const r = this.rects.get(id)!;
      for (let row = 0; row < cel.height; row++) data.set(cel.pixels.subarray(row * cel.width, (row + 1) * cel.width), (r.y + row) * W + r.x);
    }
    const t = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    u.uAtlas.value.dispose();
    u.uAtlas.value = t;
    u.uAtlasSize.value.set(W, H);
  }

  /** Writes each slot's current frame rectangle (w = 0 where nothing is drawn). */
  updateSlots(u: IndexedUniforms): void {
    const d = u.uSlots.value.image.data as Float32Array;
    for (let s = 0; s < BITMAP3D_SLOT_COUNT; s++) {
      // the table's upper half (slot + 0x100) is the polygons'; bitmap3dDrawFrame(slot, true) adds it
      const f = s >= 0x100 ? bitmap3dDrawFrame(s - 0x100, true) : bitmap3dDrawFrame(s, false);
      const r = f ? this.rects.get(f.celId) : undefined;
      d[s * 4] = r ? r.x : 0;
      d[s * 4 + 1] = r ? r.y : 0;
      d[s * 4 + 2] = r ? r.w : 0;
      d[s * 4 + 3] = r ? r.h : 0;
    }
    u.uSlots.value.needsUpdate = true;
  }
}
