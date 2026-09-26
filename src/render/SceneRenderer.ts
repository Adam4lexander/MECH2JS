/**
 * Draws the game's world with three.js.
 *
 * What is drawn is what the original draws. The main view (sync, the
 * drawing half of vfx_video_sub_010490): first the backdrop, the tree under
 * backdropNode (render_scene_tree_sorted, far clip lifted), into
 * backdropScene, which the caller renders before clearing the depth buffer -
 * so the world always paints over it, as it does when drawn after; then the
 * objects on worldRootNode's list (render_object_list); then, in the cockpit
 * view, cockpitHeadNode's tree - the player's own head, the cockpit shell -
 * into cockpitScene, which the caller renders last after clearing the depth
 * buffer, since the original paints it after (so over) the whole world. The
 * alt list holds hidden objects and the aux list objects set aside. The
 * extra views the HUD asks for (render/passes/indexedView.ts) draw one
 * render_object_list (drawList) or one render_scene_tree_sorted (drawTree)
 * into scene.
 *
 * Every pass runs the render-state block's hooks as they stand
 * (render/pipeline/hooks.ts): objectCullHook per object (the backdrop and
 * cockpit passes install their own, 0x3f780 and 0x3f970), the level-of-detail
 * mesh chosen as object_draw_lod_mesh chooses it from the object's view
 * depth, each polygon's colour word from polygonDrawHook at the depth key
 * the clipper gives it (render/pipeline/drawPipeline.ts), and what that word
 * becomes from poly_fill_dispatch and polygonFillHook
 * (render/pipeline/fillDispatch.ts): a fill, an outline, or both - per
 * frame, on the CPU. Objects the cull rejects and polygons the clipper does
 * not queue are not drawn.
 *
 * Geometry: an object with a scene node keeps model-space vertices and takes
 * the node's world transform as its matrix; an object without one (static
 * scenery, parent -2) had its world vertices baked at load
 * (object_transform_now) and is drawn from those. Each polygon has slots for
 * its fan (one triangle more than it needs, for a near-clipped shape), a
 * mode 0x3000 code also a sprite quad, and - built the first time one is
 * needed - line slots for its outline.
 *
 * Polygons crossing the near plane are drawn from the clipper's own records
 * (clip_vertex_at_near_plane), at the game's near clip, which lies beyond
 * three.js's near plane - so the GPU never clips, and nothing it would
 * interpolate differently at a cut reaches the screen. Their outlines run
 * through the same records.
 *
 * A mode 0x3000 fill is a sprite (see materials/indexedMaterial.ts): its
 * quad's corners are built on screen by the vertex shader from the
 * polygon's p and q vertices (spriteVertices), or on the map from q and r.
 * One whose polygon crosses the near plane is not drawn (DIVERGENCE: the
 * original builds it from the clip records, which then carry interpolated
 * u, v).
 *
 * Faces are not culled by the GPU: the clipper's own back-face test (the
 * first vertex against the stored normal) decides, as in the original.
 *
 * DIVERGENCE: a depth buffer replaces the original's per-polygon painter's
 * sort (render_scene_tree_sorted, render_draw_depth_sorted); objects with
 * load flag 0x1 ("always behind") are drawn first without depth writes to
 * approximate it. Within a polygon the outline is drawn over the fill, as
 * poly_fill_dispatch draws them in that order.
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
import { renderOptions, type LightLatch } from './shading/polygonColour.ts';
import { mapVertexIndex } from './shading/mapColour.ts';
import { renderView, viewerLatchGlobals } from './pipeline/viewLatch.ts';
import { clipLerp, clipRecordCount, clipRecords, meshResetClipState, objectCullBackdrop, objectSelectLodMesh, polyDepthKey, spriteVertices, type ClipRecord } from './pipeline/drawPipeline.ts';
import { objectCullCockpit, objectCullHook, polygonDrawHook, type ColourFn } from './pipeline/hooks.ts';
import { FillKind, polyFillDispatch, type PolyDraw } from './pipeline/fillDispatch.ts';
import { makeIndexedMaterial, makeLineMaterial, makeUniforms, NOT_DRAWN, setLuma, setPalette, type IndexedUniforms } from './materials/indexedMaterial.ts';

/** A polygon's outline slots: (vertex count + 1) segments, enough for a near-clipped shape. */
interface LineEntry {
  mesh: THREE.LineSegments;
  pos: Float32Array;
  draw: Float32Array;
  start: Int32Array;
  cap: Int32Array;
  /** 1 while the polygon's outline slots are drawn */
  on: Uint8Array;
}

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
  /** first vertex slot of each polygon's fan, and its capacity in triangles (one more than its fan, for a near-clipped polygon) */
  polyStart: Int32Array;
  polyTris: Int32Array;
  /** 1 while the polygon's fan slots hold a near-clipped shape */
  clipped: Uint8Array;
  /** 1 while the fan's u holds map_fill_polygon's vertex indices */
  uvIndex: Uint8Array;
  /** first vertex slot of the sprite quad (6 slots), -1 for a polygon whose code is not mode 0x3000 */
  spriteStart: Int32Array;
  /** 1 when the world variant can be built (p and q found), -1 when not */
  sprite: Int8Array;
  /** 1 when the map variant can be built (q and r found), -1 when not */
  spriteMap: Int8Array;
  lines: LineEntry | null;
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
  /** the pass count when it was last drawn */
  seen: number;
}

export interface FrameStats {
  objects: number;
  polygons: number;
}

const pd: PolyDraw = { fill: NOT_DRAWN, kind: FillKind.ByMode, outline: NOT_DRAWN };

export class SceneRenderer {
  readonly scene = new THREE.Scene();
  /** drawn first, and the depth buffer cleared after it: the sky pass and backdropNode's tree (see sync) */
  readonly backdropScene = new THREE.Scene();
  readonly uniforms: IndexedUniforms;
  private readonly material: THREE.ShaderMaterial;
  private readonly behindMaterial: THREE.ShaderMaterial;
  private readonly lineMaterial: THREE.ShaderMaterial;
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
  private pass = 0;

  /** `uniforms`: a view's own set (makeViewUniforms) sharing the textures of the main one; the main view makes its own. */
  constructor(uniforms?: IndexedUniforms) {
    this.uniforms = uniforms ?? makeUniforms();
    this.material = makeIndexedMaterial(this.uniforms);
    this.behindMaterial = makeIndexedMaterial(this.uniforms, { behind: true });
    this.lineMaterial = makeLineMaterial(this.uniforms);
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

  destroy(): void {
    this.clear();
    this.material.dispose();
    this.behindMaterial.dispose();
    this.lineMaterial.dispose();
  }

  private dispose(e: ObjEntry): void {
    e.group.parent?.remove(e.group);
    for (const m of e.meshes) {
      m.mesh.geometry.dispose();
      m.lines?.mesh.geometry.dispose();
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
      const spriteStart = new Int32Array(b.polygonCount).fill(-1);
      let slots = 0;
      for (let i = 0; i < b.polygonCount; i++) {
        const p = b.polygons[i]!;
        const n = p.vertexCount;
        polyStart[i] = slots;
        // a fan of n - 2, plus one: clipping a convex n-gon at one plane gives at most n + 1 vertices
        polyTris[i] = n >= 3 ? n - 1 : 0;
        slots += polyTris[i]! * 3;
        if ((p.code & 0x7000) === 0x3000 && n >= 3) {
          spriteStart[i] = slots;
          slots += 6;
        }
      }
      const pos = new Float32Array(slots * 3);
      const uv = new Float32Array(slots * 2);
      const draw = new Float32Array(slots).fill(NOT_DRAWN);
      const spr = new Float32Array(slots * 4).fill(-1);
      const sprR = new Float32Array(slots * 3);
      const sprite = new Int8Array(b.polygonCount);
      const spriteMap = new Int8Array(b.polygonCount);
      const put = (at: number, mv: MeshVertex, into: Float32Array, stride: number) => {
        into[at * stride] = (baked ? mv.worldX : mv.modelX) * CM_TO_UNITS;
        into[at * stride + 1] = (baked ? mv.worldY : mv.modelY) * CM_TO_UNITS;
        into[at * stride + 2] = -(baked ? mv.worldZ : mv.modelZ) * CM_TO_UNITS;
      };
      for (let i = 0; i < b.polygonCount; i++) {
        const p = b.polygons[i]!;
        let v = polyStart[i]!;
        for (let k = 1; k + 1 < p.vertexCount; k++) {
          for (const ix of [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!]) {
            const mv = b.vertices[ix]!;
            put(v, mv, pos, 3);
            uv[v * 2] = mv.texU;
            uv[v * 2 + 1] = mv.texV;
            v++;
          }
        }
        if (spriteStart[i]! >= 0) {
          const { p: sp, q: sq, r: sr, mirror } = spriteVertices(p, b.vertices);
          sprite[i] = sp && sq ? 1 : -1;
          spriteMap[i] = sq && sr ? 1 : -1;
          const at = sp ?? sr ?? sq;
          v = spriteStart[i]!;
          for (const c of [0, 1, 2, 0, 2, 3]) {
            if (at) put(v, at, pos, 3);
            if (sq) put(v, sq, spr, 4);
            if (sr) put(v, sr, sprR, 3);
            spr[v * 4 + 3] = c;
            uv[v * 2] = SPRITE_UV[mirror ? (c % 2 === 0 ? c + 1 : c - 1) : c]![0];
            uv[v * 2 + 1] = SPRITE_UV[c]![1];
            v++;
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('aDraw', new THREE.BufferAttribute(draw, 1));
      g.setAttribute('aSprite', new THREE.BufferAttribute(spr, 4));
      g.setAttribute('aSpriteR', new THREE.BufferAttribute(sprR, 3));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, behind ? this.behindMaterial : this.material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;
      if (behind) mesh.renderOrder = -1;
      group.add(mesh);
      this.byMesh.set(mesh, obj);
      meshes.push({
        block: b,
        mesh,
        baked,
        pos,
        uv,
        draw,
        basePos: pos.slice(),
        baseUv: uv.slice(),
        polyStart,
        polyTris,
        clipped: new Uint8Array(b.polygonCount),
        uvIndex: new Uint8Array(b.polygonCount),
        spriteStart,
        sprite,
        spriteMap,
        lines: null,
      });
    }
    into.add(group);
    return { obj, group, meshes, baked, seen: this.pass };
  }

  /** The outline slots of a mesh, made the first time one of its polygons needs an outline. */
  private linesOf(m: MeshEntry): LineEntry {
    if (m.lines) return m.lines;
    const b = m.block;
    const start = new Int32Array(b.polygonCount);
    const cap = new Int32Array(b.polygonCount);
    let slots = 0;
    for (let i = 0; i < b.polygonCount; i++) {
      start[i] = slots;
      cap[i] = b.polygons[i]!.vertexCount + 1;
      slots += cap[i]! * 2;
    }
    const pos = new Float32Array(slots * 3);
    const draw = new Float32Array(slots).fill(NOT_DRAWN);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDraw', new THREE.BufferAttribute(draw, 1));
    const mesh = new THREE.LineSegments(g, this.lineMaterial);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    m.mesh.parent!.add(mesh);
    m.lines = { mesh, pos, draw, start, cap, on: new Uint8Array(b.polygonCount) };
    return m.lines;
  }

  private beginPass(viewer: Viewer): LightLatch {
    this.pass++;
    viewerLatchGlobals(viewer);
    this.uniforms.uTextureAffine.value = renderOptions.textureAffine;
    this.uniforms.uShadedFill.value = renderOptions.shadedFillEnabled;
    this.uniforms.uSprites.value = renderOptions.dat00097030 & 1;
    return renderView.light;
  }

  /**
   * Mirrors engine state into the three.js scene for one frame of the main
   * view, drawn from `viewer` the way vfx_video_sub_010490 draws:
   * viewer_latch_globals, the backdrop, render_object_list, the cockpit
   * shell. The viewer's rotation and translation must be the camera three.js
   * draws with (render/bridge/cameraViewer.ts).
   */
  sync(viewer: Viewer): void {
    const L = this.beginPass(viewer);
    const colour = polygonDrawHook();
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
            polys += this.drawObject(obj, e, L, colour);
          }
        }
        for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
      };
      walk(viewScene.backdropNode);
      renderView.viewFarClipScaled = far;
    }
    const cull = objectCullHook();
    for (const obj of objectsOnList(worldRootNode)) {
      seen.add(obj);
      const e = this.entry(obj, this.scene);
      const culled = cull(obj) !== 0;
      e.group.visible = !culled;
      if (culled) continue;
      drawn++;
      renderView.polySortFlags = obj.flags & 0xffff;
      polys += this.drawObject(obj, e, L, colour);
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
        if (obj && objectCullCockpit(obj) === 0) {
          const e = this.entry(obj, this.cockpitScene, this.cockpitEntries);
          e.group.visible = true;
          drawn++;
          polys += this.drawObject(obj, e, L, colour);
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

  /**
   * One render_object_list into scene, from `viewer`: per object on the list
   * objectCullHook, then polySortFlags = its flags and object_draw_lod_mesh.
   * Nothing else in scene shows.
   *
   * @portOnly the object walk of render_object_list (0x3cb90) for the extra views
   */
  drawList(viewer: Viewer, list: WorldObject | null): void {
    const L = this.beginPass(viewer);
    const colour = polygonDrawHook();
    const cull = objectCullHook();
    let polys = 0;
    let drawn = 0;
    if (list) {
      for (const obj of objectsOnList(list)) {
        if (cull(obj) !== 0) continue;
        const e = this.entry(obj, this.scene);
        e.group.visible = true;
        e.seen = this.pass;
        drawn++;
        renderView.polySortFlags = obj.flags & 0xffff;
        polys += this.drawObject(obj, e, L, colour);
      }
    }
    this.endViewPass(drawn, polys);
  }

  /**
   * One render_scene_tree_sorted(root) into scene: scene_tree_draw_objects
   * down the tree - an object with flags bit 0x1000 skipped, then
   * objectCullHook, then object_draw_lod_mesh. polySortFlags is not set, so
   * the tree's polygons keep the value the last object walk left (a quirk,
   * kept).
   *
   * @portOnly the walk of scene_tree_draw_objects (0x3d200) for the extra views
   */
  drawTree(viewer: Viewer, root: SceneNode): void {
    const L = this.beginPass(viewer);
    const colour = polygonDrawHook();
    const cull = objectCullHook();
    let polys = 0;
    let drawn = 0;
    const walk = (n: SceneNode) => {
      const obj = n.userData;
      if (obj && ((obj.flags >> 8) & 0x10) === 0 && cull(obj) === 0) {
        const e = this.entry(obj, this.scene);
        e.group.visible = true;
        e.seen = this.pass;
        drawn++;
        polys += this.drawObject(obj, e, L, colour);
      }
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(root);
    this.endViewPass(drawn, polys);
  }

  /** Hides what this pass did not draw; forgets what no pass has drawn for a while. */
  private endViewPass(drawn: number, polys: number): void {
    for (const [obj, e] of this.entries) {
      if (e.seen === this.pass) continue;
      e.group.visible = false;
      if (this.pass - e.seen > 600) {
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
  private drawObject(obj: WorldObject, e: ObjEntry, L: LightLatch, colour: ColourFn): number {
    const block = objectSelectLodMesh(obj, renderView.objectViewDepth, (o) => {
      // object_refresh_mesh; objects without a node had their world vertices baked at load
      if (o.node) objectRefreshMesh(o);
    });
    const chosen = e.meshes.find((m) => m.block === block);
    for (const m of e.meshes) {
      m.mesh.visible = m === chosen;
      if (m.lines) m.lines.mesh.visible = m === chosen;
    }
    return chosen ? this.shade(chosen, L, colour) : 0;
  }

  /**
   * Per polygon: the clipper's depth key, the colour word from the draw
   * hook, and what poly_fill_dispatch makes of it - fill slots (the fan, or
   * the sprite quad) and outline slots. A polygon crossing the near plane
   * is drawn from the clipper's records (clip_vertex_at_near_plane's points)
   * rather than left for the GPU to clip, so what reaches the rasteriser is
   * what the original's clipper hands its filler.
   */
  private shade(m: MeshEntry, L: LightLatch, colour: ColourFn): number {
    const b = m.block;
    meshResetClipState(b);
    let words = false;
    let geometry = false;
    let lineWords = false;
    let lineGeometry = false;
    let queued = 0;
    for (let i = 0; i < b.polygonCount; i++) {
      const p = b.polygons[i]!;
      if (!p.owner) continue;
      const key = polyDepthKey(p, b.vertices);
      let crossing = false;
      if (key === null) {
        pd.fill = NOT_DRAWN;
        pd.outline = NOT_DRAWN;
      } else {
        queued++;
        polyFillDispatch(p.vertexCount, colour(p, b.vertices, p.code, key, L), pd);
        for (let r = 0; r < clipRecordCount; r++) if (clipRecords[r]!.b) crossing = true;
      }
      // the fan: a near-clipped shape while crossing, the polygon's own otherwise
      if (crossing) {
        this.writeClipped(m, i);
        m.clipped[i] = 1;
        geometry = true;
      } else if (m.clipped[i]) {
        this.restore(m, i);
        m.clipped[i] = 0;
        geometry = true;
      }
      const fanTris = crossing ? Math.min(clipRecordCount - 2, m.polyTris[i]!) : Math.max(0, p.vertexCount - 2);
      let tris = 0;
      let spriteOn = false;
      if (pd.fill !== NOT_DRAWN) {
        const isSprite = pd.kind === FillKind.MapSprite || (pd.kind === FillKind.ByMode && (pd.fill & 0x7000) === 0x3000);
        if (isSprite) {
          // a sprite whose polygon crosses the near plane would be built from interpolated clip records; not drawn here
          const ok = m.spriteStart[i]! >= 0 && (pd.kind === FillKind.MapSprite ? m.spriteMap[i] === 1 : m.sprite[i] === 1);
          spriteOn = ok && !crossing;
        } else tris = fanTris;
      }
      // map_fill_polygon's height indices in the fan's u
      if (tris > 0 && pd.kind === FillKind.MapHeight) {
        this.writeMapIndices(m, i, pd.fill, crossing);
        m.uvIndex[i] = 1;
        geometry = true;
      } else if (m.uvIndex[i]) {
        if (crossing) this.writeClipped(m, i);
        else this.restore(m, i);
        m.uvIndex[i] = 0;
        geometry = true;
      }
      const s0 = m.polyStart[i]!;
      const cap = m.polyTris[i]!;
      for (let t = 0; t < cap; t++) {
        const w = t < tris ? pd.fill : NOT_DRAWN;
        const s = s0 + t * 3;
        if (m.draw[s] !== w) {
          m.draw.fill(w, s, s + 3);
          words = true;
        }
      }
      const q0 = m.spriteStart[i]!;
      if (q0 >= 0) {
        const w = spriteOn ? pd.fill : NOT_DRAWN;
        if (m.draw[q0] !== w) {
          m.draw.fill(w, q0, q0 + 6);
          words = true;
        }
      }
      // the outline
      if (pd.outline !== NOT_DRAWN) {
        const ln = this.linesOf(m);
        this.writeOutline(m, ln, i, crossing, pd.outline);
        ln.on[i] = 1;
        lineWords = lineGeometry = true;
      } else if (m.lines && m.lines.on[i]) {
        const ln = m.lines;
        ln.draw.fill(NOT_DRAWN, ln.start[i]!, ln.start[i]! + ln.cap[i]! * 2);
        ln.on[i] = 0;
        lineWords = true;
      }
    }
    const geo = m.mesh.geometry;
    if (words) (geo.getAttribute('aDraw') as THREE.BufferAttribute).needsUpdate = true;
    if (geometry) {
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('aUv') as THREE.BufferAttribute).needsUpdate = true;
    }
    if (m.lines) {
      const lg = m.lines.mesh.geometry;
      if (lineWords) (lg.getAttribute('aDraw') as THREE.BufferAttribute).needsUpdate = true;
      if (lineGeometry) (lg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    return queued;
  }

  private coord(m: MeshEntry, v: MeshVertex, axis: number): number {
    const baked = m.baked;
    return axis === 0 ? (baked ? v.worldX : v.modelX) : axis === 1 ? (baked ? v.worldY : v.modelY) : baked ? v.worldZ : v.modelZ;
  }

  private recordCoord(m: MeshEntry, rec: ClipRecord, axis: number): number {
    const a = this.coord(m, rec.a, axis);
    return rec.b ? a + ((this.coord(m, rec.b, axis) - a) * rec.num) / rec.den : a;
  }

  /** A fan over the clip records of polygon i. */
  private writeClipped(m: MeshEntry, i: number): void {
    // texture coordinates as the clip record holds them: texU/texV << 16, interpolated with a truncating divide
    const tex = (rec: ClipRecord, v: boolean): number => {
      const a = (v ? rec.a.texV : rec.a.texU) << 16;
      return (rec.b ? clipLerp(a, (v ? rec.b.texV : rec.b.texU) << 16, rec.num, rec.den) : a) / 65536;
    };
    let slot = m.polyStart[i]!;
    const tris = Math.min(clipRecordCount - 2, m.polyTris[i]!);
    for (let k = 1; k <= tris; k++) {
      for (const rec of [clipRecords[0]!, clipRecords[k]!, clipRecords[k + 1]!]) {
        m.pos[slot * 3] = this.recordCoord(m, rec, 0) * CM_TO_UNITS;
        m.pos[slot * 3 + 1] = this.recordCoord(m, rec, 1) * CM_TO_UNITS;
        m.pos[slot * 3 + 2] = -this.recordCoord(m, rec, 2) * CM_TO_UNITS;
        m.uv[slot * 2] = tex(rec, false);
        m.uv[slot * 2 + 1] = tex(rec, true);
        slot++;
      }
    }
  }

  /**
   * map_fill_polygon's vertex loop: each fan vertex's u becomes its palette
   * index, (word & 0xf0) | map_height_shade(depth) - the vertex's view depth,
   * or the near clip's at a crossing record.
   */
  private writeMapIndices(m: MeshEntry, i: number, word: number, crossing: boolean): void {
    let slot = m.polyStart[i]!;
    const near = renderView.viewNearClipScaled;
    const idx = (depth: number) => mapVertexIndex(word, depth);
    if (crossing) {
      const tris = Math.min(clipRecordCount - 2, m.polyTris[i]!);
      for (let k = 1; k <= tris; k++) {
        for (const rec of [clipRecords[0]!, clipRecords[k]!, clipRecords[k + 1]!]) m.uv[slot++ * 2] = idx(rec.b ? near : rec.a.viewDepth);
      }
      return;
    }
    const p = m.block.polygons[i]!;
    const vs = m.block.vertices;
    for (let k = 1; k + 1 < p.vertexCount; k++) {
      for (const ix of [p.indices[0]!, p.indices[k]!, p.indices[k + 1]!]) m.uv[slot++ * 2] = idx(vs[ix]!.viewDepth);
    }
  }

  /** The line loop through polygon i's vertices, or through its clip records while it crosses the near plane. */
  private writeOutline(m: MeshEntry, ln: LineEntry, i: number, crossing: boolean, colour: number): void {
    const s0 = ln.start[i]!;
    const cap = ln.cap[i]!;
    const pts: Array<[number, number, number]> = [];
    if (crossing) {
      for (let r = 0; r < clipRecordCount; r++) {
        const rec = clipRecords[r]!;
        pts.push([this.recordCoord(m, rec, 0), this.recordCoord(m, rec, 1), this.recordCoord(m, rec, 2)]);
      }
    } else {
      const p = m.block.polygons[i]!;
      for (let k = 0; k < p.vertexCount; k++) {
        const v = m.block.vertices[p.indices[k]!]!;
        pts.push([this.coord(m, v, 0), this.coord(m, v, 1), this.coord(m, v, 2)]);
      }
    }
    const n = Math.min(pts.length, cap);
    let slot = s0;
    for (let k = 0; k < n; k++) {
      for (const pt of [pts[k]!, pts[(k + 1) % n]!]) {
        ln.pos[slot * 3] = pt[0] * CM_TO_UNITS;
        ln.pos[slot * 3 + 1] = pt[1] * CM_TO_UNITS;
        ln.pos[slot * 3 + 2] = -pt[2] * CM_TO_UNITS;
        ln.draw[slot] = colour;
        slot++;
      }
    }
    ln.draw.fill(NOT_DRAWN, slot, s0 + cap * 2);
  }

  /** Polygon i's fan back to its unclipped shape and texture coordinates. */
  private restore(m: MeshEntry, i: number): void {
    const s = m.polyStart[i]!;
    const e = s + m.polyTris[i]! * 3;
    m.pos.set(m.basePos.subarray(s * 3, e * 3), s * 3);
    m.uv.set(m.baseUv.subarray(s * 2, e * 2), s * 2);
  }
}
