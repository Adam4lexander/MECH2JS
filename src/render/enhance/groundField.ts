/**
 * The ground enhancement: the flat ground given a surface, in the game's own
 * terms.
 *
 * THE SURFACE. The original fills everything below the horizon with one
 * palette index (groundColour, skyGround.ts); the world's own terrain tiles
 * (walkmeshes) are dithered per-vertex height ramps (mode 0x4000). This is a
 * grid of the same kind on the ground plane - y 0, where the game drops the
 * scrounge patch and where world_ground_height_near falls back to - about
 * 1.3 km across in 16 m cells, re-centred on the camera's cell. Each vertex
 * carries a shade level, 0 to 4, moved off the middle (2, groundColour) by
 * world-anchored value noise; the material's checkerboard dither (the
 * filler's own) runs between the levels, and each level is drawn as its
 * palette shade (paletteRuns.ts groundShades: groundColour at 80, 90, 110
 * and 120 per cent, the nearest palette colours of its hue - from the whole
 * palette, since every mission's ground is 0xef, the end of its row, and
 * the row is seldom its ramp).
 * (Correction: the vertices first carried palette indices moved along
 * groundColour's row, dithered index to index; in 40 of the 59 missions the
 * row held no shade of the ground, and in some it held other hues.)
 *
 * It is drawn with the backdrop (the backdrop pass, whose depth is cleared
 * before the world): the ground is the lowest thing there is, so the
 * terrain, the mechs and everything else always draw over it, and it cannot
 * fight a flat terrain tile for depth.
 *
 * THE SCROUNGE FIELD. The game keeps one scrounge patch (scrounge.ts: rocks
 * and scrub, re-placed on a grid under the camera) - a small island of
 * detail. Copies of it on the grid cells round the game's own one make a
 * field of it. The copies are the patch's meshes as built (unclipped) with
 * each polygon's last draw word the game gave the patch itself, so they take
 * its light; they are three.js meshes only - nothing is added to the game's
 * world.
 *
 * @portOnly
 */
import * as THREE from 'three';
import type { SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { scrounge } from '../../sim/world/scrounge.ts';
import { CM_TO_UNITS } from '../bridge/space.ts';
import { makeIndexedMaterial, NOT_DRAWN, type IndexedUniforms } from '../materials/indexedMaterial.ts';
import type { MeshEntry, SceneRenderer } from '../SceneRenderer.ts';

/** grid cell, metres, and cells across */
const CELL = 16;
const CELLS = 80;
/**
 * The variation is full within FADE_NEAR cells of the eye and gone by
 * FADE_FAR: further out its patches are a few pixels across, and the
 * screen-fixed dither crawls over them as the view moves - a field of
 * shimmering specks (the first cut ran it out to 1.4 km and doubled the
 * pixels that changed with a 20 cm step of the camera). Beyond, the grid is
 * groundColour: the fill it lies on.
 */
const FADE_NEAR = 12;
const FADE_FAR = 36;

/** A hash of an integer lattice point to 0..1. */
function hash2(x: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Value noise at lattice spacing `scale` (cells), smoothly interpolated, 0..1. */
function valueNoise(x: number, z: number, scale: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * The shade level (0..4; 2 is groundColour itself) for the ground vertex at
 * world cell (x, z): moved off the middle by up to two, by nothing at `fade` 0.
 */
export function groundLevel(x: number, z: number, fade: number): number {
  // broad patches only (80 m and 40 m): fewer dithered edges to crawl
  const n = 0.8 * (valueNoise(x, z, 5) - 0.5) + 0.2 * (valueNoise(x, z, 2.5) - 0.5);
  const shift = Math.round(n * 4.2 * fade);
  return Math.min(4, Math.max(0, 2 + shift));
}

/** How much of the noise a vertex `r` cells from the eye's cell keeps: all within FADE_NEAR, none from FADE_FAR. */
export function groundFade(r: number): number {
  const t = Math.min(1, Math.max(0, (r - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
  return 1 - t * t * (3 - 2 * t);
}

interface Copy {
  src: MeshEntry;
  mesh: THREE.Mesh;
  draw: Float32Array;
  /** each polygon's last fan and sprite words the game drew the patch with (copyDrawWords) */
  fan: Float32Array;
  sprite: Float32Array;
}

/**
 * The patch's draw words onto a copy's slots (`out`, over the mesh as built):
 * per polygon, its fan's word and its sprite quad's, as the game last drew
 * it. A polygon the game did not draw this frame - culled, facing away from
 * the game's eye, which is not the copies' - keeps what it had; one it did
 * draw takes both words, a part it left undrawn included, so a polygon that
 * changes how it is filled (enhanced imaging fills every one black, sprites
 * too, and gives them back when it ends) does not keep its old fill. The fan
 * is the whole polygon (the copies are unclipped), whatever the patch's
 * near-plane clip left of it. Returns whether any slot changed.
 * (Correction: the words were first kept slot by slot, the last one drawn in
 * each; enhanced imaging's black fans stayed on every copy after it ended,
 * the sprites drawn back over them.)
 */
export function copyDrawWords(src: Pick<MeshEntry, 'block' | 'draw' | 'polyStart' | 'polyTris' | 'spriteStart'>, fan: Float32Array, sprite: Float32Array, out: Float32Array): boolean {
  let changed = false;
  const polys = src.block.polygons;
  for (let p = 0; p < src.block.polygonCount; p++) {
    const s0 = src.polyStart[p]!;
    const cap = src.polyTris[p]!;
    const q0 = src.spriteStart[p]!;
    // a fan the game drew has its first slot drawn; a sprite, all six
    const f = cap > 0 ? src.draw[s0]! : NOT_DRAWN;
    const q = q0 >= 0 ? src.draw[q0]! : NOT_DRAWN;
    if (f === NOT_DRAWN && q === NOT_DRAWN) continue;
    if (f === fan[p] && q === sprite[p]) continue;
    fan[p] = f;
    sprite[p] = q;
    const whole = Math.max(0, polys[p]!.vertexCount - 2) * 3;
    out.fill(f, s0, s0 + whole);
    out.fill(NOT_DRAWN, s0 + whole, s0 + cap * 3);
    if (q0 >= 0) out.fill(q, q0, q0 + 6);
    changed = true;
  }
  return changed;
}

export class GroundField {
  /** the grid, for the backdrop scene */
  readonly grid: THREE.Mesh;
  /** the scrounge copies, for the world scene */
  readonly field = new THREE.Group();
  private readonly uv: Float32Array;
  private cellX = Number.NaN;
  private cellZ = Number.NaN;
  private readonly material: THREE.ShaderMaterial;
  /** per scrounge object: its copies, keyed by the patch's object */
  private readonly copies = new Map<WorldObject, { offsets: THREE.Group[]; meshes: Copy[] }>();

  constructor(uniforms: IndexedUniforms) {
    const n = CELLS + 1;
    const pos = new Float32Array(n * n * 3);
    this.uv = new Float32Array(n * n * 2);
    const draw = new Float32Array(n * n).fill(0x4000 | 15);
    const spr = new Float32Array(n * n * 4).fill(-1);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        pos[k * 3] = (i - CELLS / 2) * CELL;
        pos[k * 3 + 2] = (j - CELLS / 2) * CELL;
      }
    const index: number[] = [];
    for (let j = 0; j < CELLS; j++)
      for (let i = 0; i < CELLS; i++) {
        const a = j * n + i;
        // alternate the diagonal, so the facets do not line up in rows
        if ((i + j) & 1) index.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
        else index.push(a, a + n, a + n + 1, a, a + n + 1, a + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.uv, 2));
    g.setAttribute('aDraw', new THREE.BufferAttribute(draw, 1));
    g.setAttribute('aSprite', new THREE.BufferAttribute(spr, 4));
    g.setAttribute('aSpriteR', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CELLS * CELL);
    this.material = makeIndexedMaterial(uniforms, { shades: true });
    this.grid = new THREE.Mesh(g, this.material);
    this.grid.frustumCulled = false;
    // over the sky, under the backdrop's objects
    this.grid.renderOrder = -900;
    this.grid.visible = false;
    this.field.visible = false;
  }

  /**
   * Places the grid under `eye` (three.js metres), draws its levels as
   * `shades` (the ground colour's five, paletteRuns.ts groundShades), and
   * re-levels it when its cell changes; `show` false hides it.
   */
  updateGrid(eye: THREE.Vector3, shades: readonly number[], show: boolean): void {
    this.grid.visible = show;
    if (!show) return;
    const table = this.material.uniforms.uShades!.value as number[];
    for (let i = 0; i < 5; i++) table[i] = shades[i]!;
    const cx = Math.floor(eye.x / CELL);
    const cz = Math.floor(eye.z / CELL);
    this.grid.position.set(cx * CELL, 0, cz * CELL);
    this.grid.updateMatrixWorld();
    if (cx === this.cellX && cz === this.cellZ) return;
    this.cellX = cx;
    this.cellZ = cz;
    const n = CELLS + 1;
    const half = CELLS / 2;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const fade = groundFade(Math.hypot(i - half, j - half));
        this.uv[(j * n + i) * 2] = groundLevel(cx + i - half, cz + j - half, fade);
      }
    (this.grid.geometry.getAttribute('aUv') as THREE.BufferAttribute).needsUpdate = true;
  }

  /**
   * Keeps the scrounge copies with the game's patch: the cells round its own
   * out to about `radius` metres, each object's visible LOD mesh, with the
   * draw words the game last gave the patch. `show` false hides them.
   */
  updateField(sr: SceneRenderer, show: boolean, radius = 250): void {
    const node = scrounge.scroungeNode;
    const on = show && scrounge.scroungeActive !== 0 && node !== null;
    this.field.visible = on;
    if (!on || !node) return;
    const tileM = scrounge.scroungeTileSize * CM_TO_UNITS;
    if (!(tileM > 0)) return;
    const k = Math.max(1, Math.min(4, Math.floor(radius / tileM)));
    for (const obj of subtreeObjects(node)) {
      const e = sr.entryOf(obj);
      if (!e) continue;
      let c = this.copies.get(obj);
      // the renderer rebuilt the patch's meshes (it dropped them while unseen): copy the new ones
      if (c && c.meshes[0]?.src !== e.meshes[0]) {
        this.forget(obj, c);
        c = undefined;
      }
      if (!c) {
        c = { offsets: [], meshes: [] };
        for (let dz = -k; dz <= k; dz++)
          for (let dx = -k; dx <= k; dx++) {
            if (dx === 0 && dz === 0) continue;
            const g = new THREE.Group();
            g.matrixAutoUpdate = false;
            g.userData.offset = new THREE.Vector3(dx * tileM, 0, -dz * tileM);
            this.field.add(g);
            c.offsets.push(g);
          }
        for (const m of e.meshes) c.meshes.push(this.copyOf(m, c.offsets));
        this.copies.set(obj, c);
      }
      // the patch's own place, then each copy a whole number of tiles from it
      for (const g of c.offsets) {
        g.matrix.makeTranslation(g.userData.offset as THREE.Vector3).multiply(e.group.matrix);
        g.matrixWorldNeedsUpdate = true;
        g.visible = e.group.visible;
      }
      for (const cp of c.meshes) {
        if (copyDrawWords(cp.src, cp.fan, cp.sprite, cp.draw)) (cp.mesh.geometry.getAttribute('aDraw') as THREE.BufferAttribute).needsUpdate = true;
        const vis = cp.src.mesh.visible;
        for (const g of c.offsets) {
          const m = g.children[c.meshes.indexOf(cp)];
          if (m) m.visible = vis;
        }
      }
    }
  }

  /** One of the patch's meshes, as built, shared by every copy. */
  private copyOf(src: MeshEntry, into: THREE.Group[]): Copy {
    const sg = src.mesh.geometry;
    const g = new THREE.BufferGeometry();
    const draw = new Float32Array(src.draw.length).fill(NOT_DRAWN);
    g.setAttribute('position', new THREE.BufferAttribute(src.basePos.slice(), 3));
    g.setAttribute('aUv', new THREE.BufferAttribute(src.baseUv.slice(), 2));
    g.setAttribute('aDraw', new THREE.BufferAttribute(draw, 1));
    g.setAttribute('aSprite', (sg.getAttribute('aSprite') as THREE.BufferAttribute).clone());
    g.setAttribute('aSpriteR', (sg.getAttribute('aSpriteR') as THREE.BufferAttribute).clone());
    g.computeBoundingSphere();
    let mesh: THREE.Mesh | null = null;
    for (const group of into) {
      const m = new THREE.Mesh(g, src.mesh.material);
      m.matrixAutoUpdate = false;
      group.add(m);
      mesh ??= m;
    }
    const n = src.block.polygonCount;
    return { src, mesh: mesh!, draw, fan: new Float32Array(n).fill(NOT_DRAWN), sprite: new Float32Array(n).fill(NOT_DRAWN) };
  }

  private forget(obj: WorldObject, c: { offsets: THREE.Group[]; meshes: Copy[] }): void {
    for (const cp of c.meshes) cp.mesh.geometry.dispose();
    for (const g of c.offsets) this.field.remove(g);
    this.copies.delete(obj);
  }

  /** A new mission: forget the copies (the patch's meshes are rebuilt). */
  clear(): void {
    for (const [obj, c] of [...this.copies]) this.forget(obj, c);
    this.cellX = this.cellZ = Number.NaN;
  }

  dispose(): void {
    this.clear();
    this.grid.geometry.dispose();
    this.material.dispose();
  }
}

/** The world objects of a scene subtree. */
function subtreeObjects(root: SceneNode): WorldObject[] {
  const out: WorldObject[] = [];
  const walk = (n: SceneNode) => {
    if (n.userData) out.push(n.userData);
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(root);
  return out;
}
