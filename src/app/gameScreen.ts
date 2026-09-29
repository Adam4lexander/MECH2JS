/**
 * The game's screen: MW2.EXE's display as the player sees it - the world
 * through the game's own viewer (camera_update's), the cockpit shell and the
 * game's 2D (HUD, radar, the inset views and the map) over it - and the host
 * loop that runs the game a display frame at a time in Play. The PC's
 * keyboard and mouse feed the game's GIDDI drivers (hostInput.ts).
 *
 * Faithful renders at VGA resolution (640 x 480, aspect-fitted) and scales
 * up with nearest filtering; otherwise at native resolution.
 *
 * In Play the game runs at a fixed step and the display draws between its
 * passes (engine/scene/present.ts): the world, the camera and the HUD's
 * world-anchored 2D where they stand `game.presentAlpha()` of the way from
 * the pass before the last to the last; after every pass that asks for the
 * main view, the renderer's latch leaves the game's state as drawing it then
 * would have.
 *
 * The game itself (GameView.tsx) is this alone. The editor's Viewport builds
 * on it: `lookThrough` shows its free camera instead of the game's (no
 * cockpit or HUD then, which are the game camera's), and it adds its handles
 * to `sr.scene`.
 *
 * @portOnly the host of the game's display
 */
import * as THREE from 'three';
import type { Viewer } from '../generated/classes.gen.ts';
import type { Game } from './Game.ts';
import { attachHostInput } from './hostInput.ts';
import { SceneRenderer } from '../render/SceneRenderer.ts';
import { cameraFromViewer } from '../render/bridge/cameraViewer.ts';
import { SkyGround } from '../render/passes/skyGround.ts';
import { HudOverlay } from '../render/passes/hudOverlay.ts';
import { IndexedViews } from '../render/passes/indexedView.ts';
import { renderOptions } from '../render/shading/polygonColour.ts';
import { viewer } from '../sim/camera/viewer.ts';
import { presentedViewer } from '../sim/camera/viewerPresent.ts';
import { hudAnchoredPresent } from '../sim/cockpit/overlay.ts';
import { ALPHA_ONE, presentFrameBegin, presentFrameEnd, presenting } from '../engine/scene/present.ts';
import { defaultCanvas } from '../sim/display/video.ts';
import { renderPort } from '../sim/display/renderPort.ts';
import { lighting } from '../sim/world/environment.ts';

/** A camera other than the game's to draw a frame through (the editor's). */
export interface OutsideView {
  camera: THREE.PerspectiveCamera;
  /** the viewer the cull, LOD and clipper see, asked once the camera's aspect is set */
  viewer: () => Viewer;
}

export interface GameScreenOptions {
  /** Faithful or native resolution, asked every frame; Faithful when absent */
  faithful?: () => boolean;
  /** after the game's pass: another camera to draw this frame through, or null for the game's */
  lookThrough?: (dt: number) => OutsideView | null;
  /** after the frame is drawn, with the camera it was drawn through */
  afterFrame?: (now: number, camera: THREE.PerspectiveCamera) => void;
}

export class GameScreen {
  readonly webgl = new THREE.WebGLRenderer({ antialias: false });
  readonly sr = new SceneRenderer();
  /** the game's view: set from the game's viewer every frame it is shown */
  readonly gameCamera = new THREE.PerspectiveCamera(60, 4 / 3, 0.5, 20000);
  /**
   * the game's render calls: main's render hook (vfx_video_sub_010490) asks
   * for the main view, drawn once the loop pass returns; the HUD's inset views
   * and the map are drawn when the game asks, into the window's pixels
   * (render/passes/indexedView.ts)
   */
  readonly views: IndexedViews;
  private readonly skyGround: SkyGround;
  private readonly hudOverlay: HudOverlay;
  private readonly drawSize = new THREE.Vector2();
  private readonly detachInput: () => void;
  private lastPalette: string;
  private paletteDirty = false;
  private raf = 0;
  private last = performance.now();

  constructor(
    private readonly el: HTMLElement,
    private readonly game: Game,
    private readonly opts: GameScreenOptions = {},
  ) {
    this.webgl.setPixelRatio(1);
    this.webgl.autoClear = false;
    el.appendChild(this.webgl.domElement);
    const pal = game.paletteRgb();
    if (pal) this.sr.setPalette(pal);
    this.lastPalette = game.paletteKey();
    const luma = game.lumaRows();
    if (luma) this.sr.setLuma(luma);
    game.bindTextures(this.sr);
    this.skyGround = new SkyGround(this.sr.uniforms);
    this.sr.backdropScene.add(this.skyGround.mesh);
    this.hudOverlay = new HudOverlay(this.sr.uniforms);
    // Play: the PC's keyboard and mouse feed the game's GIDDI drivers
    this.detachInput = attachHostInput(this.webgl.domElement, () => game.mode === 'play');
    this.views = new IndexedViews(this.webgl, this.sr.uniforms);
    renderPort.current = this.views;
    this.raf = requestAnimationFrame(this.frame);
  }

  /** The palette is set again next frame (the editor's fixed day phase changed). */
  invalidatePalette(): void {
    this.paletteDirty = true;
  }

  private readonly frame = (now: number): void => {
    const { game, sr, webgl, el, drawSize } = this;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    const elapsedMs = now - this.last;
    this.last = now;
    const playing = game.mode === 'play';
    // the game's render requests are per pass of its loop: between passes the last one is drawn again,
    // as presented; after each pass, what drawing its main view leaves in the game's state
    const afterPass = (): void => {
      if (this.views.mainRequested) sr.latch(viewer());
    };
    if (playing && !game.playFrame(elapsedMs, () => this.views.beginFrame(), afterPass)) game.setMode('edit');
    presentFrameBegin(playing ? game.presentAlpha() : ALPHA_ONE);
    // after the frame: the loop may have ended and left Edit
    const outside = this.opts.lookThrough?.(dt) ?? null;
    const camera = outside?.camera ?? this.gameCamera;
    // the palette on screen follows the game's (day cycle, infrared, flashes) as well as the editor's choice
    const key = game.paletteKey();
    if (this.paletteDirty || key !== this.lastPalette) {
      this.paletteDirty = false;
      this.lastPalette = key;
      const p = game.paletteRgb();
      if (p) sr.setPalette(p);
    }
    const w = el.clientWidth;
    const h = el.clientHeight;
    let aspect: number;
    if (this.opts.faithful?.() ?? true) {
      const s = Math.min(w / 640, h / 480);
      webgl.setSize(640, 480, false);
      webgl.domElement.style.width = `${Math.floor(640 * s)}px`;
      webgl.domElement.style.height = `${Math.floor(480 * s)}px`;
      webgl.domElement.style.imageRendering = 'pixelated';
      aspect = 640 / 480;
    } else {
      webgl.setSize(w, h, false);
      webgl.domElement.style.width = `${w}px`;
      webgl.domElement.style.height = `${h}px`;
      webgl.domElement.style.imageRendering = 'auto';
      aspect = w / h;
    }
    // the game's viewer as presented (its own at the last pass)
    const shown = presentedViewer();
    if (outside) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    } else cameraFromViewer(shown, camera, aspect);
    game.updateTextures(sr);
    // the game's viewer as the cull, LOD and clipper see it: its own, or standing at the outside camera
    sr.sync(outside ? outside.viewer() : shown);
    webgl.getDrawingBufferSize(drawSize);
    // Play: the main view only when the game's render hook asked for it this frame (not while the
    // map has the hook), with its wipe colour in place of sky and ground when it gave one
    const wipe = playing ? this.views.mainWipe : null;
    this.skyGround.update(camera, drawSize.x, drawSize.y, {
      sky: wipe ?? lighting.skyColour,
      ground: wipe ?? lighting.groundColour,
      skyOn: wipe !== null || lighting.skyEnabled !== 0,
      groundOn: wipe !== null || lighting.groundEnabled !== 0,
      bandHeight: lighting.horizonBandHeight,
      screenWidth: Math.max(1, defaultCanvas.xMax + 1),
      bandOn: wipe === null && lighting.horizonBandEnabled !== 0 && renderOptions.shadedFillEnabled !== 0,
    });
    sr.setViewport(drawSize.x, drawSize.y);
    webgl.clear();
    if (!playing || this.views.mainRequested) {
      // the sky and the backdrop, then the world over them
      webgl.render(sr.backdropScene, camera);
      webgl.clearDepth();
      webgl.render(sr.scene, camera);
      if (!outside) {
        // the cockpit shell, painted over the world (empty outside the cockpit view). Its near clip
        // is 8 cm, inside three's 50 cm near plane, so the pass runs with the plane pulled in
        webgl.clearDepth();
        const near = camera.near;
        camera.near = 0.04;
        camera.updateProjectionMatrix();
        webgl.render(sr.cockpitScene, camera);
        camera.near = near;
        camera.updateProjectionMatrix();
      }
    }
    // the game's 2D (HUD, radar, cockpit text) over it all, through the game's camera; between
    // passes its reticle and target marker redrawn where the world is presented
    if (!outside) {
      const win = game.windowShown();
      const lift = presenting() && win === defaultCanvas && hudAnchoredPresent(this.hudOverlay.layerFor(win), shown);
      if (this.hudOverlay.update(win, lift, drawSize.x, drawSize.y)) webgl.render(this.hudOverlay.scene, this.hudOverlay.camera);
    }
    presentFrameEnd();
    this.opts.afterFrame?.(now, camera);
    this.raf = requestAnimationFrame(this.frame);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.detachInput();
    if (renderPort.current === this.views) renderPort.current = null;
    this.views.dispose();
    this.hudOverlay.dispose();
    this.sr.clear();
    this.webgl.dispose();
    this.el.removeChild(this.webgl.domElement);
  }
}
