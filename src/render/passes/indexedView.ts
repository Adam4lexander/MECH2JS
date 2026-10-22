/**
 * The host's render port (sim/display/renderPort.ts): the 3D views the HUD
 * and the map draw in the middle of a frame.
 *
 * The original's renderer paints straight into the 8-bit frame buffer
 * through currentViewport, so an inset view lands between the 2D drawn
 * before it (the target display's black wipe) and the 2D drawn after (its
 * frame). The port renders each such call at once, offscreen, with the
 * materials writing palette indices instead of colours (uIndexOut), into a
 * texture of the viewport's own, and marks the pane's pixels in the game's
 * window as that view's (engine/vfx/vfx.ts vfxWindowMarkInset). The screen
 * shows the view's index wherever it drew and the window's pixel elsewhere
 * - what the window held before, the wipe - and the 2D drawn after clears
 * the mark where it draws, so the frame covers the view
 * (passes/hudOverlay.ts WINDOW_GLSL). Nothing is read back: a readback
 * waits for the GPU to finish the frame before, every pass.
 * (Correction: the views were first read back into the window's pixels,
 * gl.readPixels per view - the target display's stall showed in every
 * profile of player_cockpit_frame.)
 *
 * A view that draws the sky and ground first (renderViewFromPose,
 * ortho_view_draw_world) draws its objects over them in the same texture;
 * any other call starts it afresh.
 *
 * Each viewport keeps its texture and its SceneRenderer (its meshes and
 * draw words) for the mission; the window can hold INSET_SLOTS views at
 * once.
 *
 * The render target is the pane's own size in window pixels, the camera the
 * viewer's: perspective (clip_project_perspective), or orthographic while
 * clipProjectHook is ortho_clip_project - pixel x = view x / unitsPerPixel
 * + centreX, y flipped about centreY, as ortho_clip_project maps them.
 * Both put the view's centre on pixel centreX's centre, as the originals'
 * rounding does.
 *
 * The main view is not drawn here: the host draws it beneath the window
 * after the frame (mainView records that it was asked for).
 *
 * @portOnly
 */
import * as THREE from 'three';
import type { SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { vfxWindowMarkInset, type VfxWindow } from '../../engine/vfx/vfx.ts';
import { unestablished } from '../../core/provenance.ts';
import type { RenderPort } from '../../sim/display/renderPort.ts';
import { viewer } from '../../sim/camera/viewer.ts';
import { radar } from '../../sim/cockpit/radar.ts';
import { defaultCanvas, display } from '../../sim/display/video.ts';
import { HOOK, renderOptions } from '../../sim/display/renderState.ts';
import { lighting } from '../../sim/world/environment.ts';
import { SceneRenderer } from '../SceneRenderer.ts';
import { cameraFromViewer } from '../bridge/cameraViewer.ts';
import { CM_TO_UNITS } from '../bridge/space.ts';
import { makeViewUniforms, type IndexedUniforms } from '../materials/indexedMaterial.ts';
import { projectionIsOrtho } from '../pipeline/hooks.ts';
import { SkyGround } from './skyGround.ts';
import { INSET_SLOTS, type InsetUniforms } from './hudOverlay.ts';

interface View {
  sr: SceneRenderer;
  sky: SkyGround;
  skyScene: THREE.Scene;
  /** the view's pixels: palette indices in red, alpha 1 where it drew */
  target: THREE.WebGLRenderTarget;
  /** its inset id: its texture's slot in the window's shaders */
  slot: number;
  /** the sky and ground were just drawn: the objects go over them */
  skyUnder: boolean;
}

interface Pane {
  win: VfxWindow;
  left: number;
  top: number;
  width: number;
  height: number;
}

export class IndexedViews implements RenderPort {
  /** the main view was asked for this frame; the wipe colour in place of sky and ground, or null */
  mainRequested = false;
  mainWipe: number | null = null;
  private readonly views = new Map<number, View>();
  private readonly persp = new THREE.PerspectiveCamera(60, 1, 0.05, 20000);
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20000);
  private readonly clearColour = new THREE.Color(0, 0, 0);

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly shared: IndexedUniforms,
    /** the window's shaders' inset textures and rectangles (passes/hudOverlay.ts), which this fills in */
    private readonly insets: InsetUniforms,
  ) {}

  /** Forget every view's meshes (a new mission). */
  clear(): void {
    for (const v of this.views.values()) v.sr.clear();
  }

  dispose(): void {
    for (const v of this.views.values()) {
      v.sr.destroy();
      v.target.dispose();
    }
    this.views.clear();
    for (let i = 0; i < INSET_SLOTS; i++) this.insetTexture(i).value = null;
  }

  beginFrame(): void {
    this.mainRequested = false;
    this.mainWipe = null;
  }

  mainView(wipeColour: number | null): void {
    this.mainRequested = true;
    this.mainWipe = wipeColour;
  }

  skyAndGround(): void {
    const pane = this.pane();
    if (!pane) return;
    const view = this.view();
    const cam = this.camera(pane);
    if (!(cam instanceof THREE.PerspectiveCamera)) return;
    view.sky.update(cam, pane.width, pane.height, {
      sky: lighting.skyColour,
      ground: lighting.groundColour,
      skyOn: lighting.skyEnabled !== 0,
      groundOn: lighting.groundEnabled !== 0,
      bandHeight: lighting.horizonBandHeight,
      screenWidth: pane.width,
      bandOn: lighting.horizonBandEnabled !== 0 && renderOptions.shadedFillEnabled !== 0,
    });
    this.draw(pane, view, view.skyScene, cam);
    view.skyUnder = true;
  }

  objectList(list: WorldObject | null): void {
    const pane = this.pane();
    if (!pane) return;
    const view = this.view();
    const cam = this.camera(pane);
    this.prepare(view, pane);
    view.sr.drawList(viewer(), list);
    this.draw(pane, view, view.sr.scene, cam);
  }

  sceneTreeSorted(root: SceneNode): void {
    const pane = this.pane();
    if (!pane) return;
    const view = this.view();
    const cam = this.camera(pane);
    this.prepare(view, pane);
    view.sr.drawTree(viewer(), root);
    this.draw(pane, view, view.sr.scene, cam);
  }

  /** currentViewport as a pixel rectangle of its window; null when it has no pixels. */
  private pane(): Pane | null {
    const c = display.currentViewport;
    const win = (c.canvas as VfxWindow | null) ?? defaultCanvas;
    const width = (c.right - c.left + 1) | 0;
    const height = (c.bottom - c.top + 1) | 0;
    if (width <= 0 || height <= 0 || win.xMax < 0 || win.buffer.length === 0) return null;
    return { win, left: c.left, top: c.top, width, height };
  }

  /** The selected viewport's view: its SceneRenderer (its own meshes and draw words) and its texture. */
  private view(): View {
    const key = display.currentViewportMode;
    let v = this.views.get(key);
    if (!v) {
      const sr = new SceneRenderer(makeViewUniforms(this.shared, true, false));
      const sky = new SkyGround(this.shared, true);
      const skyScene = new THREE.Scene();
      skyScene.add(sky.mesh);
      const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
      target.texture.minFilter = THREE.NearestFilter;
      target.texture.magFilter = THREE.NearestFilter;
      target.texture.generateMipmaps = false;
      const slot = this.views.size;
      // the missions draw views in three viewports (the rear view, the target display, the map)
      if (slot >= INSET_SLOTS) unestablished(`an inset view in viewport ${key}, past the ${INSET_SLOTS} the window's shaders hold; it shares slot ${slot % INSET_SLOTS}`, 'render_view_from_pose');
      v = { sr, sky, skyScene, target, slot: slot % INSET_SLOTS, skyUnder: false };
      this.views.set(key, v);
    }
    return v;
  }

  private insetTexture(slot: number): { value: THREE.Texture | null } {
    const u = this.insets;
    return slot === 0 ? u.uInset0 : slot === 1 ? u.uInset1 : slot === 2 ? u.uInset2 : u.uInset3;
  }

  private prepare(view: View, pane: Pane): void {
    view.sr.uniforms.uMapFill.value = renderOptions.polygonFillHook === HOOK.mapFillPolygon ? 1 : 0;
    view.sr.setViewport(pane.width, pane.height);
  }

  /**
   * The viewer as a three.js camera for this pane: its pose, and either its
   * perspective (the field of view from zoom, the centre on pixel centreX /
   * centreY) or the orthographic view's pixel scale.
   */
  private camera(pane: Pane): THREE.Camera {
    const v = viewer();
    const W = pane.width;
    const H = pane.height;
    const p = this.persp;
    cameraFromViewer(v, p, W / H);
    // the view's centre ray lands on pixel (centreX, H - 1 - centreY)'s centre
    const dx = v.centreX + 0.5 - W / 2;
    const dy = H - 0.5 - v.centreY - H / 2;
    if (!projectionIsOrtho()) {
      p.setViewOffset(W, H, -dx, -dy, W, H);
      p.near = 0.05;
      p.far = 20000;
      p.updateProjectionMatrix();
      return p;
    }
    const o = this.ortho;
    o.position.copy(p.position);
    o.quaternion.copy(p.quaternion);
    const upp = radar.orthoUnitsPerPixel * CM_TO_UNITS;
    o.left = (-0.5 - v.centreX) * upp;
    o.right = (W - 0.5 - v.centreX) * upp;
    o.top = (H - 0.5 - v.centreY) * upp;
    o.bottom = (-0.5 - v.centreY) * upp;
    o.near = 0.01;
    o.far = Math.max(1, (radar.orthoFarClip + 100000) * CM_TO_UNITS);
    o.updateProjectionMatrix();
    o.updateMatrixWorld(true);
    return o;
  }

  /**
   * Renders `scene` into the view's texture in palette indices - afresh, or
   * over the sky and ground just drawn - and marks the pane's pixels in the
   * window as the view's.
   */
  private draw(pane: Pane, view: View, scene: THREE.Scene, cam: THREE.Camera): void {
    const r = this.renderer;
    const { width: W, height: H } = pane;
    const target = view.target;
    const over = view.skyUnder;
    view.skyUnder = false;
    if (target.width !== W || target.height !== H) target.setSize(W, H);
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevColour = new THREE.Color();
    r.getClearColor(prevColour);
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(target);
    r.setClearColor(this.clearColour, 0);
    r.clear(!over, true, true);
    r.autoClear = false;
    // in a headset session three would draw through the XR camera, into the headset's framebuffer
    const xr = r.xr.enabled;
    r.xr.enabled = false;
    r.render(scene, cam);
    r.xr.enabled = xr;
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColour, prevAlpha);
    r.autoClear = prevAuto;
    this.insetTexture(view.slot).value = target.texture;
    this.insets.uInsetRect.value[view.slot]!.set(pane.left, pane.top, W, H);
    vfxWindowMarkInset(pane.win, pane.left, pane.top, W, H, view.slot);
  }
}
