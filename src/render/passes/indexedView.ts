/**
 * The host's render port (sim/display/renderPort.ts): the 3D views the HUD
 * and the map draw in the middle of a frame.
 *
 * The original's renderer paints straight into the 8-bit frame buffer
 * through currentViewport, so an inset view lands between the 2D drawn
 * before it (the target display's black wipe) and the 2D drawn after (its
 * frame). The port gets the same order by rendering each such call at once,
 * offscreen, with the materials writing palette indices instead of colours
 * (uIndexOut), and reading the pixels back into the game's window: a pixel
 * the view drew takes its index and becomes drawn; one it did not keeps
 * what the window had. The window then reaches the screen with the rest of
 * the 2D (passes/hudOverlay.ts).
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
import type { VfxWindow } from '../../engine/vfx/vfx.ts';
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

interface View {
  sr: SceneRenderer;
  sky: SkyGround;
  skyScene: THREE.Scene;
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
  private readonly target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
  private pixels = new Uint8Array(4);
  private readonly persp = new THREE.PerspectiveCamera(60, 1, 0.05, 20000);
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20000);
  private readonly clearColour = new THREE.Color(0, 0, 0);

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly shared: IndexedUniforms,
  ) {
    this.target.texture.minFilter = THREE.NearestFilter;
    this.target.texture.magFilter = THREE.NearestFilter;
    this.target.texture.generateMipmaps = false;
  }

  /** Forget every view's meshes (a new mission). */
  clear(): void {
    for (const v of this.views.values()) v.sr.clear();
  }

  dispose(): void {
    for (const v of this.views.values()) v.sr.destroy();
    this.views.clear();
    this.target.dispose();
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
    this.draw(pane, view.skyScene, cam);
  }

  objectList(list: WorldObject | null): void {
    const pane = this.pane();
    if (!pane) return;
    const view = this.view();
    const cam = this.camera(pane);
    this.prepare(view, pane);
    view.sr.drawList(viewer(), list);
    this.draw(pane, view.sr.scene, cam);
  }

  sceneTreeSorted(root: SceneNode): void {
    const pane = this.pane();
    if (!pane) return;
    const view = this.view();
    const cam = this.camera(pane);
    this.prepare(view, pane);
    view.sr.drawTree(viewer(), root);
    this.draw(pane, view.sr.scene, cam);
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

  /** The SceneRenderer for the selected viewport (each keeps its own meshes and draw words). */
  private view(): View {
    const key = display.currentViewportMode;
    let v = this.views.get(key);
    if (!v) {
      const sr = new SceneRenderer(makeViewUniforms(this.shared, true, false));
      const sky = new SkyGround(this.shared, true);
      const skyScene = new THREE.Scene();
      skyScene.add(sky.mesh);
      v = { sr, sky, skyScene };
      this.views.set(key, v);
    }
    return v;
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

  /** Renders `scene` into the pane-sized target in palette indices and copies the drawn pixels into the window. */
  private draw(pane: Pane, scene: THREE.Scene, cam: THREE.Camera): void {
    const r = this.renderer;
    const { width: W, height: H } = pane;
    if (this.target.width !== W || this.target.height !== H) this.target.setSize(W, H);
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevColour = new THREE.Color();
    r.getClearColor(prevColour);
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.target);
    r.setClearColor(this.clearColour, 0);
    r.clear(true, true, true);
    r.autoClear = false;
    r.render(scene, cam);
    const n = W * H * 4;
    if (this.pixels.length < n) this.pixels = new Uint8Array(n);
    r.readRenderTargetPixels(this.target, 0, 0, W, H, this.pixels);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColour, prevAlpha);
    r.autoClear = prevAuto;
    const win = pane.win;
    const pitch = win.xMax + 1;
    const px = this.pixels;
    for (let gy = 0; gy < H; gy++) {
      const y = pane.top + (H - 1 - gy);
      if (y < 0 || y > win.yMax) continue;
      for (let gx = 0; gx < W; gx++) {
        const i = (gy * W + gx) * 4;
        if (px[i + 3] === 0) continue;
        const x = pane.left + gx;
        if (x < 0 || x > win.xMax) continue;
        win.buffer[y * pitch + x] = px[i]!;
        win.drawn[y * pitch + x] = 1;
      }
    }
  }
}
