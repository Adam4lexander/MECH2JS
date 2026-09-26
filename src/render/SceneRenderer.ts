/**
 * Draws the game's world with three.js.
 *
 * What is drawn is what the original draws: first the backdrop, the tree
 * under backdropNode (render_scene_tree_sorted, far clip lifted), into
 * backdropScene, which the caller renders before clearing the depth buffer -
 * so the world always paints over it, as it does when drawn after; then the
 * objects on worldRootNode's list (render_object_list); then, in the cockpit
 * view, cockpitHeadNode's tree - the player's own head, the cockpit shell -
 * into cockpitScene, which the caller renders last after clearing the depth
 * buffer, since the original paints it after (so over) the whole world. The alt list holds
 * hidden objects and the aux list objects set aside. For each object the level-of-detail mesh is chosen
 * as object_draw_lod_mesh chooses it from the object's view depth
 * (object_cull_main_view), and each polygon's draw word comes from the ported
 * polygon_resolve_colour at the depth key the clipper gives it
 * (render/pipeline/drawPipeline.ts), per frame, on the CPU. Objects the cull
 * rejects and polygons the clipper does not queue are not drawn.
 *
 * Geometry: an object with a scene node keeps model-space vertices and takes
 * the node's world transform as its matrix; an object without one (static
 * scenery, parent -2) had its world vertices baked at load
 * (object_transform_now) and is drawn from those.
 *
 * Polygons crossing the near plane are drawn from the clipper's own records
 * (clip_vertex_at_near_plane), at the game's near clip, which lies beyond
 * three.js's near plane - so the GPU never clips, and nothing it would
 * interpolate differently at a cut reaches the screen.
 *
 * A mode 0x3000 polygon is a sprite (see materials/indexedMaterial.ts): its
 * slots hold a quad whose corners the vertex shader builds on screen from
 * the polygon's p and q vertices (spriteVertices). One whose polygon crosses the near
 * plane is not drawn (DIVERGENCE: the original builds it from the clip
 * records, which then carry interpolated u, v).
 *
 * Faces are not culled by the GPU: the clipper's own back-face test (the
 * first vertex against the stored normal) decides, as in the original.
 *
 * DIVERGENCE: a depth buffer replaces the original's per-polygon painter's
 * sort (render_scene_tree_sorted); objects with load flag 0x1 ("always
 * behind") are drawn first without depth writes to approximate it.
 *
 * @portOnly
 */
import * as THREE from 'three';
import type { MeshBlock, MeshVertex, SceneNode, Viewer, WorldObject } from '../generated/classes.gen.ts';
import { viewScene } from '../sim/world/viewScene.ts';
import { cameraGlobals } from '../sim/camera/viewer.ts';
import { quirk } from '../core/provenance.ts';
import { objectsOnList, worldRootNode } from '../engine/scene/objectLists.ts';
import { objectRefreshMesh } from '../engine/scene/worldObject.ts';
import { blockToMatrix4, CM_TO_UNITS } from './bridge/space.ts';
import { polygonResolveColour, renderOptions, type LightLatch } from './shading/polygonColour.ts';
import { renderView, viewerLatchGlobals } from './pipeline/viewLatch.ts';
import { clipLerp, clipRecordCount, clipRecords, meshResetClipState, objectCullBackdrop, objectCullMainView, objectSelectLodMesh, polyDepthKey, spriteVertices, type ClipRecord } from './pipeline/drawPipeline.ts';
import { makeIndexedMaterial, makeUniforms, NOT_DRAWN, setLuma, setPalette, type IndexedUniforms } from './materials/indexedMaterial.ts';

interface MeshEntry {
  block: MeshBlock;
  mesh: THREE.Mesh;
  /** whether positions are world (baked, no scene node) or model space */
  baked: boolean;
  pos: Float32Array;
  uv: Float32Array;
  draw: Float32Array;
  /** the unclipped fan, to restore a polygon that stops crossing the near plane */
  basePos: Float32Array;
  baseUv: Float32Array;
  /** first vertex slot of each polygon, and its capacity in triangles (one more than its fan, for a near-clipped polygon) */
  polyStart: Int32Array;
  polyTris: Int32Array;
  /** 1 while the polygon's slots hold a near-clipped shape */
  clipped: Uint8Array;
  /** mode 0x3000: 1 = a sprite quad, -1 = no p or q vertex (the original draws nothing); 0 = an ordinary polygon */
  sprite: Int8Array;
}

/** u, v of the sprite's four corners, the table at 0x96f1c (16.16 in the original: 0 or 0x10000) */
const SPRITE_UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

interface ObjEntry {
  obj: WorldObject;
  group: THREE.Group;
  meshes: MeshEntry[];
  baked: boolean;
}

export interface FrameStats {
  objects: number;
  polygons: number;
}

export class SceneRenderer {
  readonly scene = new THREE.Scene();
  /** drawn first, and the depth buffer cleared after it: the sky pass and backdropNode's tree (see sync) */
  readonly backdropScene = new THREE.Scene();
  readonly uniforms: IndexedUniforms = makeUniforms();
  private readonly material = makeIndexedMaterial(this.uniforms);
  private readonly behindMaterial = makeIndexedMaterial(this.uniforms, { behind: true });
  /**
   * drawn last, over everything, with the depth buffer cleared before it: in
   * the cockpit view, cockpitHeadNode's tree (see sync)
   */
  readonly cockpitScene = new THREE.Scene();
  private readonly entries = new Map<WorldObject, ObjEntry>();
  /** the cockpit pass draws objects the world pass may draw too, so they get their own meshes */
  private readonly cockpitEntries = new Map<WorldObject, ObjEntry>();
  private readonly byMesh = new Map<THREE.Object3D, WorldObject>();
  readonly stats: FrameStats = { objects: 0, polygons: 0 };

  constructor() {
    this.scene.matrixAutoUpdate = false;
    this.backdropScene.matrixAutoUpdate = false;
    this.cockpitScene.matrixAutoUpdate = false;
  }

  setPalette(rgb: Uint8Array): void {
    setPalette(this.uniforms, rgb);
  }

  setLuma(rows: Uint8Array): void {
    setLuma(this.uniforms, rows);
  }

  /** The render target's size in pixels, which the mode 0x3000 sprites are measured in. */
  setViewport(width: number, height: number): void {
    this.uniforms.uViewport.value.set(width, height);
  }

  /** The WorldObject a raycast hit belongs to. */
  objectOf(hit: THREE.Object3D): WorldObject | null {
    return this.byMesh.get(hit) ?? null;
  }

  pickables(): THREE.Object3D[] {
    return [...this.byMesh.keys()].filter((m) => m.visible && m.parent?.visible);
  }

  /** Forget every mesh (a new mission was loaded). */
  clear(): void {
    for (const e of this.entries.values()) this.dispose(e);
    this.entries.clear();
    for (const e of this.cockpitEntries.values()) this.dispose(e);
    this.cockpitEntries.clear();
    this.byMesh.clear();
  }

  private dispose(e: ObjEntry): void {
    e.group.parent?.remove(e.group);
    for (const m of e.meshes) {
      m.mesh.geometry.dispose();
      this.byMesh.delete(m.mesh);
    }
  }

  private build(obj: WorldObject, into: THREE.Scene): ObjEntry {
    const baked = obj.node === null;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const behind = (obj.flags & 1) !== 0;
    const meshes: MeshEntry[] = [];
    for (let b = obj.meshList; b; b = b.next) {
      const polyStart = new Int32Array(b.polygonCount);
      const polyTris = new Int32Array(b.polygonCount);
      let slots = 0;
      for (let i = 0; i < b.polygonCount; i++) {
        const n = b.polygons[i]!.vertexCount;
        polyStart[i] = slots;
        // a fan of n - 2, plus one: clipping a convex n-gon at one plane gives at most n + 1 vertices
        polyTris[i] = n >= 3 ? n - 1 : 0;
        slots += polyTris[i]! * 3;
      }
      const pos = new Float32Array(slots * 3);
      const uv = new Float32Array(slots * 2);
      const draw = new Float32Array(slots).fill(NOT_DRAWN);
      const spr = new Float32Array(slots * 4).fill(-1);
      const sprite = new Int8Array(b.polygonCount);
      const put = (at: number, mv: MeshVertex, into: Float32Array, stride: number) => {
        into[at * stride] = (baked ? mv.worldX : mv.modelX) * CM_TO_UNITS;
        into[at * stride + 1] = (baked ? mv.worldY : mv.modelY) * CM_TO_UNITS;
        into[at * stride + 2] = -(baked ? mv.worldZ : mv.modelZ) * CM_TO_UNITS;
      };
      for (let i = 0; i < b.polygonCount; i++) {
        const p = b.polygons[i]!;
        let v = polyStart[i]!;
        if ((p.code & 0x7000) === 0x3000 && polyTris[i]! >= 2) {
          const { p: sp, q: sq, mirror } = spriteVertices(p, b.vertices);
          sprite[i] = sp && sq ? 1 : -1;
          if (sp && sq) {
            for (const c of [0, 1, 2, 0, 2, 3]) {
              put(v, sp, pos, 3);
              put(v, sq, spr, 4);
              spr[v * 4 + 3] = c;
              uv[v * 2] = SPRITE_UV[mirror ? (c % 2 === 0 ? c + 1 : c - 1) : c]![0];
              uv[v * 2 + 1] = SPRITE_UV[c]![1];
              v++;
            }
          }
          continue;
        }
        for (let k = 1; k + 1 < p.vertexCount; k++) {
          for (const ix of [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!]) {
            const mv = b.vertices[ix]!;
            const x = baked ? mv.worldX : mv.modelX;
            const y = baked ? mv.worldY : mv.modelY;
            const z = baked ? mv.worldZ : mv.modelZ;
            pos[v * 3] = x * CM_TO_UNITS;
            pos[v * 3 + 1] = y * CM_TO_UNITS;
            pos[v * 3 + 2] = -z * CM_TO_UNITS;
            uv[v * 2] = mv.texU;
            uv[v * 2 + 1] = mv.texV;
            v++;
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('aDraw', new THREE.BufferAttribute(draw, 1));
      g.setAttribute('aSprite', new THREE.BufferAttribute(spr, 4));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, behind ? this.behindMaterial : this.material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;
      if (behind) mesh.renderOrder = -1;
      group.add(mesh);
      this.byMesh.set(mesh, obj);
      meshes.push({ block: b, mesh, baked, pos, uv, draw, basePos: pos.slice(), baseUv: uv.slice(), polyStart, polyTris, clipped: new Uint8Array(b.polygonCount), sprite });
    }
    into.add(group);
    return { obj, group, meshes, baked };
  }

  /**
   * Mirrors engine state into the three.js scene for one frame, drawn from
   * `viewer` the way the frame render draws the world list:
   * viewer_latch_globals, then render_object_list - per object the cull
   * (objectViewDepth), polySortFlags, the LOD mesh at that depth, and per
   * polygon the clipper's depth key, which is the depth its colour is dimmed
   * by. The viewer's rotation and translation must be the camera three.js
   * draws with (render/bridge/cameraViewer.ts).
   */
  sync(viewer: Viewer): void {
    viewerLatchGlobals(viewer);
    this.uniforms.uTextureAffine.value = renderOptions.textureAffine;
    this.uniforms.uShadedFill.value = renderOptions.shadedFillEnabled;
    this.uniforms.uSprites.value = renderOptions.dat00097030 & 1;
    const L: LightLatch = renderView.light;
    const seen = new Set<WorldObject>();
    let polys = 0;
    let drawn = 0;
    // the backdrop first: render_scene_tree_sorted(backdropNode) with the far clip lifted
    // (viewer_set_far_clip(0x7fffffff)) and the cull hook at 0x3f780. scene_tree_draw_objects
    // does not set polySortFlags, so its polygons keep the last value the previous frame's
    // world walk left (a quirk, reproduced).
    if (viewScene.backdropNode) {
      const far = renderView.viewFarClipScaled;
      renderView.viewFarClipScaled = 0x7fffffff;
      const walk = (n: SceneNode) => {
        const obj = n.userData;
        if (obj) {
          seen.add(obj);
          const e = this.entry(obj, this.backdropScene);
          const skip = (obj.flags & 0x1000) !== 0 || objectCullBackdrop(obj) !== 0;
          e.group.visible = !skip;
          if (!skip) {
            drawn++;
            polys += this.drawObject(obj, e, L);
          }
        }
        for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
      };
      walk(viewScene.backdropNode);
      renderView.viewFarClipScaled = far;
    }
    for (const obj of objectsOnList(worldRootNode)) {
      seen.add(obj);
      const e = this.entry(obj, this.scene);
      const culled = objectCullMainView(obj) !== 0;
      e.group.visible = !culled;
      if (culled) continue;
      drawn++;
      renderView.polySortFlags = obj.flags & 0xffff;
      polys += this.drawObject(obj, e, L);
    }
    // the cockpit shell: while cockpitViewActive, after the world, cockpitHeadNode's tree with
    // the near clip at 8 (viewer_set_near_clip) and the cull hook at 0x3f970, which rejects an
    // object with flags bit 0x1000 and nothing else - no depth, far or side test, and it does
    // not write objectViewDepth, so the LOD walk reads the view depth of the last object the
    // world pass culled, and polySortFlags is the last world object's (both quirks, kept)
    for (const e of this.cockpitEntries.values()) e.group.visible = false;
    if (cameraGlobals.cockpitViewActive !== 0 && viewScene.cockpitHeadNode) {
      quirk('the cockpit pass picks LOD meshes by the view depth of the last object the world pass culled', 'vfx_video_sub_010490');
      const near = [viewer.nearClip, renderView.viewNearClip, renderView.viewNearClipScaled] as const;
      viewer.nearClip = 8;
      renderView.viewNearClip = 8;
      renderView.viewNearClipScaled = 8 * 4;
      const walk = (n: SceneNode) => {
        const obj = n.userData;
        if (obj && (obj.flags & 0x1000) === 0) {
          const e = this.entry(obj, this.cockpitScene, this.cockpitEntries);
          e.group.visible = true;
          drawn++;
          polys += this.drawObject(obj, e, L);
        }
        for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
      };
      walk(viewScene.cockpitHeadNode);
      [viewer.nearClip, renderView.viewNearClip, renderView.viewNearClipScaled] = near;
    }
    for (const [obj, e] of this.entries) {
      if (!seen.has(obj)) {
        this.dispose(e);
        this.entries.delete(obj);
      }
    }
    this.stats.objects = drawn;
    this.stats.polygons = polys;
  }

  private entry(obj: WorldObject, into: THREE.Scene, entries = this.entries): ObjEntry {
    let e = entries.get(obj);
    if (e && e.group.parent !== into) {
      this.dispose(e);
      e = undefined;
    }
    if (!e) {
      e = this.build(obj, into);
      entries.set(obj, e);
    }
    if (obj.node) blockToMatrix4(obj.node.worldBlock, e.group.matrix);
    else e.group.matrix.identity();
    e.group.matrixWorldNeedsUpdate = true;
    return e;
  }

  /** object_draw_lod_mesh: the LOD mesh at objectViewDepth, then every polygon through the clipper. */
  private drawObject(obj: WorldObject, e: ObjEntry, L: LightLatch): number {
    const block = objectSelectLodMesh(obj, renderView.objectViewDepth, (o) => {
      // object_refresh_mesh; objects without a node had their world vertices baked at load
      if (o.node) objectRefreshMesh(o);
    });
    const chosen = e.meshes.find((m) => m.block === block);
    for (const m of e.meshes) m.mesh.visible = m === chosen;
    return chosen ? this.shade(chosen, L) : 0;
  }

  /**
   * Per polygon: the clipper's depth key and draw word; a polygon crossing
   * the near plane is drawn from the clipper's records (clip_vertex_at_near_plane's
   * points, a fan over them) rather than left for the GPU to clip, so what
   * reaches the rasteriser is what the original's clipper hands its filler.
   */
  private shade(m: MeshEntry, L: LightLatch): number {
    const b = m.block;
    meshResetClipState(b);
    let words = false;
    let geometry = false;
    let queued = 0;
    for (let i = 0; i < b.polygonCount; i++) {
      const p = b.polygons[i]!;
      if (!p.owner) continue;
      const key = polyDepthKey(p, b.vertices);
      // not queued by the clipper: not drawn (NOT_DRAWN is discarded by the shader)
      const word = key === null ? NOT_DRAWN : polygonResolveColour(p, b.vertices, p.code, key, L);
      if (key !== null) queued++;
      let crossing = false;
      if (key !== null) for (let r = 0; r < clipRecordCount; r++) if (clipRecords[r]!.b) crossing = true;
      let tris = Math.max(0, p.vertexCount - 2);
      let spriteWord = word;
      if (m.sprite[i] !== 0) {
        // a sprite whose polygon crosses the near plane would be built from interpolated clip records; not drawn here
        tris = m.sprite[i] === 1 && !crossing ? 2 : 0;
        spriteWord = tris ? word : NOT_DRAWN;
      } else if (crossing) {
        tris = this.writeClipped(m, i);
        m.clipped[i] = 1;
        geometry = true;
      } else if (m.clipped[i]) {
        this.restore(m, i);
        m.clipped[i] = 0;
        geometry = true;
      }
      const s0 = m.polyStart[i]!;
      const cap = m.polyTris[i]!;
      for (let t = 0; t < cap; t++) {
        const w = t < tris ? spriteWord : NOT_DRAWN;
        const s = s0 + t * 3;
        if (m.draw[s] !== w) {
          m.draw.fill(w, s, s + 3);
          words = true;
        }
      }
    }
    const geo = m.mesh.geometry;
    if (words) (geo.getAttribute('aDraw') as THREE.BufferAttribute).needsUpdate = true;
    if (geometry) {
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('aUv') as THREE.BufferAttribute).needsUpdate = true;
    }
    return queued;
  }

  /** A fan over the clip records of polygon i; returns its triangle count. */
  private writeClipped(m: MeshEntry, i: number): number {
    const baked = m.baked;
    const coord = (v: MeshVertex, axis: number): number =>
      axis === 0 ? (baked ? v.worldX : v.modelX) : axis === 1 ? (baked ? v.worldY : v.modelY) : baked ? v.worldZ : v.modelZ;
    const px = (rec: ClipRecord, axis: number): number => {
      const a = coord(rec.a, axis);
      return rec.b ? a + ((coord(rec.b, axis) - a) * rec.num) / rec.den : a;
    };
    // texture coordinates as the clip record holds them: texU/texV << 16, interpolated with a truncating divide
    const tex = (rec: ClipRecord, v: boolean): number => {
      const a = (v ? rec.a.texV : rec.a.texU) << 16;
      return (rec.b ? clipLerp(a, (v ? rec.b.texV : rec.b.texU) << 16, rec.num, rec.den) : a) / 65536;
    };
    let slot = m.polyStart[i]!;
    const tris = Math.min(clipRecordCount - 2, m.polyTris[i]!);
    for (let k = 1; k <= tris; k++) {
      for (const rec of [clipRecords[0]!, clipRecords[k]!, clipRecords[k + 1]!]) {
        m.pos[slot * 3] = px(rec, 0) * CM_TO_UNITS;
        m.pos[slot * 3 + 1] = px(rec, 1) * CM_TO_UNITS;
        m.pos[slot * 3 + 2] = -px(rec, 2) * CM_TO_UNITS;
        m.uv[slot * 2] = tex(rec, false);
        m.uv[slot * 2 + 1] = tex(rec, true);
        slot++;
      }
    }
    return tris;
  }

  /** Polygon i back to its unclipped fan. */
  private restore(m: MeshEntry, i: number): void {
    const s = m.polyStart[i]!;
    const e = s + m.polyTris[i]! * 3;
    m.pos.set(m.basePos.subarray(s * 3, e * 3), s * 3);
    m.uv.set(m.baseUv.subarray(s * 2, e * 2), s * 2);
  }
}
