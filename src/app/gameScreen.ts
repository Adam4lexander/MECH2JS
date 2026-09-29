/**
 * The game's screen: MW2.EXE's display as the player sees it - the world
 * through the game's own viewer (camera_update's), the cockpit shell and the
 * game's 2D (HUD, radar, the inset views and the map) over it - and the host
 * loop that runs the game a display frame at a time in Play. The PC's
 * keyboard and mouse feed the game's GIDDI drivers (hostInput.ts).
 *
 * Faithful renders at VGA resolution (640 x 480, aspect-fitted) and scales
 * up with nearest filtering, at the original's draw and detail distances;
 * otherwise at native resolution, drawing further out (render/viewSettings.ts),
 * as a headset does. The enhancements (render/enhance, the hand-built
 * cockpits of render/cockpit) are drawn when the settings turn them on.
 *
 * VR (WebXR, with `vr`): the game's camera with the pilot's head inside it -
 * the world, the cockpit shell and the HUD drawn through a rig that follows
 * the game's viewer (render/xr/xrRig.ts), the sky on a sphere
 * (render/xr/xrSky.ts), the controllers as the game's keys and mouse
 * (app/xrInput.ts). The frame runs from the renderer's animation loop, which
 * is the headset's while a session is on; the page shows the left eye or a
 * spectator camera (render/xr/spectator.ts).
 *
 * The game itself (GameView.tsx) is this with the remembered settings
 * (recallScreenSettings: Modern, the enhancements and the hand-built cockpits
 * at first), in the game's headset when the player chose VR at the start
 * (app/xrHost.ts, which holds the session from the front end to the mission
 * and back). The editor's Viewport builds on it: the settings from
 * its bar, VR, and `lookThrough` to show its free
 * camera instead of the game's (no cockpit shell or HUD then, which are the
 * game camera's; never in a headset).
 *
 * @portOnly the host of the game's display
 */
import * as THREE from 'three';
import type { SceneNode } from '../generated/classes.gen.ts';
import { Viewer } from '../generated/classes.gen.ts';
import type { Game } from './Game.ts';
import { attachHostInput } from './hostInput.ts';
import { XrInput } from './xrInput.ts';
import type { XrHost } from './xrHost.ts';
import { SceneRenderer } from '../render/SceneRenderer.ts';
import { fromThree, toThree } from '../render/bridge/space.ts';
import { cameraFromViewer, copyViewer, viewerFromCamera } from '../render/bridge/cameraViewer.ts';
import { SkyGround } from '../render/passes/skyGround.ts';
import { HudOverlay } from '../render/passes/hudOverlay.ts';
import { IndexedViews } from '../render/passes/indexedView.ts';
import { renderOptions } from '../render/shading/polygonColour.ts';
import { renderView } from '../render/pipeline/viewLatch.ts';
import { farther, recallFaithful, recallViewSettings, type ViewSettings } from '../render/viewSettings.ts';
import { XrRig, playerTargetPosition } from '../render/xr/xrRig.ts';
import { XrSky } from '../render/xr/xrSky.ts';
import { aimDepth } from '../render/xr/aim.ts';
import { recallXrSettings, XR_DEFAULTS, type XrSettings } from '../render/xr/xrSettings.ts';
import { recallSpectatorSettings, Spectator, SPECTATOR_DEFAULTS, type SpectatorMode, type SpectatorSettings } from '../render/xr/spectator.ts';
import { GroundField } from '../render/enhance/groundField.ts';
import { lightDirection, Shadows, SHADOW_LAYER } from '../render/enhance/shadows.ts';
import { OwnChassis } from '../render/enhance/ownChassis.ts';
import { skyPaletteChoice, type SkyChoice } from '../render/enhance/skyDetail.ts';
import { groundShades } from '../render/enhance/paletteRuns.ts';
import { ENHANCE_DEFAULTS, recallEnhanceSettings, type EnhanceSettings } from '../render/enhance/enhanceSettings.ts';
import { commonRamps, CockpitRenderer, darkestIndex, nearestIndex, slotPanes } from '../render/cockpit/cockpit.ts';
import { cockpitChassis } from '../render/cockpit/chassis.ts';
import { buildDesign, DESIGNS } from '../render/cockpit/designs/index.ts';
import { HUD_LAYER } from '../engine/vfx/vfx.ts';
import { cameraGlobals, viewer } from '../sim/camera/viewer.ts';
import { projectionGlobals, viewerRefreshLodScale } from '../sim/camera/projection.ts';
import { radar } from '../sim/cockpit/radar.ts';
import { hud } from '../sim/cockpit/hud.ts';
import { defaultCanvas } from '../sim/display/video.ts';
import { renderPort } from '../sim/display/renderPort.ts';
import { mechs } from '../sim/mech/mechGlobals.ts';
import { lighting } from '../sim/world/environment.ts';
import { viewScene } from '../sim/world/viewScene.ts';

/** VR: the reticle's plane - out to this far with nothing under it, never nearer than the min, easing over RETICLE_EASE seconds (metres) */
const RETICLE_DISTANCE = 300;
const RETICLE_MIN_DISTANCE = 3;
const RETICLE_EASE = 0.12;
/** VR: the range the target marker's plane is held to (metres) */
const MARKER_MIN_DISTANCE = 5;
const MARKER_MAX_DISTANCE = 3000;

/** How the screen draws, asked every frame (a change shows at once). */
export interface ScreenSettings {
  /** VGA resolution at the original's distances, or native resolution drawn further out */
  faithful: boolean;
  /** how far out Modern and a headset draw */
  view: ViewSettings;
  enhance: EnhanceSettings;
  xr: XrSettings;
  /** what the page shows while a headset plays */
  spectator: SpectatorSettings;
}

/** The game as the original drew it: Faithful, its own distances, nothing added. The default without `settings`. */
export const ORIGINAL_SETTINGS: ScreenSettings = {
  faithful: true,
  view: { viewDistance: 1, detail: 1 },
  enhance: Object.fromEntries(Object.keys(ENHANCE_DEFAULTS).map((k) => [k, false])) as unknown as EnhanceSettings,
  xr: XR_DEFAULTS,
  spectator: SPECTATOR_DEFAULTS,
};

/**
 * The settings last chosen on the editor's bar, which remembers them: Modern,
 * with the enhancements and the hand-built cockpits, at first.
 */
export function recallScreenSettings(): ScreenSettings {
  return { faithful: recallFaithful(), view: recallViewSettings(), enhance: recallEnhanceSettings(), xr: recallXrSettings(), spectator: recallSpectatorSettings() };
}

/** A camera other than the game's to draw a frame through (the editor's). */
export interface OutsideView {
  camera: THREE.PerspectiveCamera;
  /** the viewer the cull, LOD and clipper see, asked once the camera's aspect is set */
  viewer: () => Viewer;
  /** the hand-built cockpit, where it stands at the game's eye: not drawn, drawn, or drawn through the mech round it */
  cockpit: 'hidden' | 'shown' | 'xray';
}

export interface VrState {
  /** a session is on */
  on: boolean;
  /** asked for, and the headset has not given it yet (the browser and the XR runtime can take a minute) */
  pending: boolean;
}

export interface GameScreenOptions {
  /** ORIGINAL_SETTINGS when absent */
  settings?: () => ScreenSettings;
  /** WebXR on the renderer, for toggleVr */
  vr?: boolean;
  /**
   * the game's headset (app/xrHost.ts): its renderer is drawn with and its loop gives the frames, and
   * closing the view leaves both - and the session - to the next view. VR follows its session; toggleVr
   * is not used
   */
  host?: XrHost;
  onVrState?: (s: VrState) => void;
  /** after the game's pass: another camera to draw this frame through, or null for the game's (always null while presenting) */
  lookThrough?: (dt: number, presenting: boolean) => OutsideView | null;
  /** after the frame is drawn, with the camera it was drawn through */
  afterFrame?: (now: number, camera: THREE.PerspectiveCamera) => void;
}

export class GameScreen {
  readonly webgl: THREE.WebGLRenderer;
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
  readonly hudOverlay: HudOverlay;
  /** the hand-built cockpits (render/cockpit): the chassis's design, its colours */
  readonly cockpit: CockpitRenderer;
  /** debug: the design drawn whatever the player's chassis (null: the player's own) */
  cockpitPreview: string | null = null;
  /** debug: the page's mirror of the headset (the left eye or the spectator camera) */
  readonly mirror = { on: true };

  private readonly skyGround: SkyGround;
  private readonly drawSize = new THREE.Vector2();
  private readonly detachInput: () => void;
  private lastPalette: string;
  private paletteDirty = false;
  private last = performance.now();

  private cockpitKey: string | null = null;
  private cockpitRampsOf: string | null = null;
  private hullRamps: number[] = [];
  private readonly lampColours = { red: 0, amber: 0, green: 0, blank: 0 };
  private readonly groundField: GroundField;
  private readonly shadows = new Shadows();
  private readonly ownChassis = new OwnChassis();
  private skyChoice: SkyChoice | null = null;
  /** the ground grid's five shades of the ground colour (paletteRuns.ts groundShades) */
  private groundShadesNow: number[] = [0xef, 0xef, 0xef, 0xef, 0xef];
  private skyChoiceFor = '';
  /** the game's viewer as the Modern view culls for it: its far distance pushed out (viewSettings.ts) */
  private readonly modernViewer = new Viewer();

  // VR: the rig the headset sits in, the sky about it, the controllers
  private readonly rig = new XrRig();
  private readonly xrSky: XrSky;
  private readonly xrInput = new XrInput();
  private readonly xrViewer = new Viewer();
  private readonly spectator = new Spectator();
  /** this frame's headset passes, kept for the spectator camera to draw again */
  private readonly xrPasses: Array<{ draw: (c: THREE.Camera) => void; world: boolean }> = [];
  private xrFrameDt = 0;
  private xrFar = 1;
  private readonly chaseViewer = new Viewer();
  /** the pass's eye to the interpolated rig, for the mech's own parts (SceneRenderer.carryOwned) */
  private readonly carry = new THREE.Matrix4();
  /** the cockpit scene carries the rig's matrix (reset on leaving VR) */
  private cockpitMoved = false;
  private reticleInvDepth = 1 / RETICLE_DISTANCE;
  private spectatorTarget: THREE.WebGLRenderTarget | null = null;
  private spectatorMode: SpectatorMode | null = null;
  private vrState: VrState = { on: false, pending: false };
  private xrWas = false;
  /**
   * Entering VR, timed (one console line once the headset has had five frames): the session's grant,
   * three's setSession (which awaits makeXRCompatible - a context the headset's GPU cannot use is
   * lost and rebuilt, every shader and texture with it), the first headset frame, and the first few
   * frames' cost with the shaders compiled for them. Measured on the user's PC headset: the grant took
   * 55 s - the browser and the XR runtime starting up, before the page is involved - and all the
   * rest under 50 ms.
   */
  private xrEntry: { t0: number; granted: number; set: number; frames: number[]; programs: number; lost: boolean } | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly game: Game,
    private readonly opts: GameScreenOptions = {},
  ) {
    this.webgl = opts.host?.renderer ?? new THREE.WebGLRenderer({ antialias: false });
    const { webgl, sr } = this;
    webgl.setPixelRatio(1);
    webgl.autoClear = false;
    el.appendChild(webgl.domElement);
    const pal = game.paletteRgb();
    if (pal) sr.setPalette(pal);
    this.lastPalette = game.paletteKey();
    const luma = game.lumaRows();
    if (luma) sr.setLuma(luma);
    game.bindTextures(sr);
    this.skyGround = new SkyGround(sr.uniforms);
    sr.backdropScene.add(this.skyGround.mesh);
    this.hudOverlay = new HudOverlay(sr.uniforms);
    this.cockpit = new CockpitRenderer(this.hudOverlay.windowUniforms);
    if (opts.vr) {
      webgl.xr.enabled = true;
      webgl.xr.setReferenceSpaceType('local');
    }
    this.xrSky = new XrSky(sr.uniforms);
    sr.backdropScene.add(this.xrSky.mesh);
    // the enhancements (render/enhance): the ground surface with the backdrop, the scrounge field in the world
    this.groundField = new GroundField(sr.uniforms);
    sr.backdropScene.add(this.groundField.grid);
    sr.scene.add(this.groundField.field);
    webgl.domElement.addEventListener('webglcontextlost', this.onLost);
    webgl.domElement.addEventListener('webglcontextrestored', this.onRestored);
    // Play: the PC's keyboard and mouse feed the game's GIDDI drivers
    this.detachInput = attachHostInput(webgl.domElement, () => game.mode === 'play');
    this.views = new IndexedViews(webgl, sr.uniforms, this.hudOverlay.insetUniforms);
    renderPort.current = this.views;
    // the renderer's loop: the window's animation frames, or the headset's while a session is on
    const loop = (now: number) => {
      const start = performance.now();
      // the headset's framebuffer for this frame: three binds it before calling back
      const xrTarget = webgl.xr.isPresenting ? webgl.getRenderTarget() : null;
      this.frame(now);
      if (xrTarget) {
        if (this.settings().spectator.mode === 'mirror') this.mirrorEye(xrTarget);
        else if (this.mirror.on) this.spectate(xrTarget);
      }
      this.timeXrFrame(start);
    };
    if (opts.host) opts.host.present(loop);
    else webgl.setAnimationLoop(loop);
  }

  /** The palette is set again next frame (the editor's fixed day phase changed). */
  invalidatePalette(): void {
    this.paletteDirty = true;
  }

  /** The design of the hand-built cockpit drawn now, or null. */
  get cockpitShown(): string | null {
    return this.cockpit.current?.key ?? null;
  }

  private settings(): ScreenSettings {
    return this.opts.settings?.() ?? ORIGINAL_SETTINGS;
  }

  private setVrState(s: Partial<VrState>): void {
    this.vrState = { ...this.vrState, ...s };
    this.opts.onVrState?.(this.vrState);
  }

  /** Enters VR, or leaves it while in it. */
  toggleVr(): void {
    const { webgl, game } = this;
    const current = webgl.xr.getSession();
    if (current) {
      void current.end();
      return;
    }
    if (!navigator.xr || !this.opts.vr) return;
    const entry = { t0: performance.now(), granted: 0, set: 0, frames: [] as number[], programs: webgl.info.programs?.length ?? 0, lost: false };
    this.xrEntry = entry;
    // the mission holds (the game's own pause, sound and all) until the headset is showing it: the
    // session can take a minute to be granted, and the pilot is not in the seat yet
    const resume = game.mode === 'play';
    if (resume) game.setMode('edit');
    this.setVrState({ pending: true });
    const done = () => {
      this.setVrState({ pending: false });
      if (resume && game.mode !== 'play') game.setMode('play');
    };
    navigator.xr
      .requestSession('immersive-vr', { optionalFeatures: ['local'] })
      .then(async (session) => {
        entry.granted = performance.now();
        session.addEventListener('end', this.onXrEnd, { once: true });
        await webgl.xr.setSession(session);
        entry.set = performance.now();
        this.setVrState({ on: true });
        done();
      })
      .catch((err: unknown) => {
        this.xrEntry = null;
        done();
        console.warn('VR session refused', err);
      });
  }

  private readonly onXrEnd = (): void => {
    this.xrInput.release();
    this.setVrState({ on: false });
  };

  private readonly onLost = (): void => {
    if (this.xrEntry) this.xrEntry.lost = true;
    console.warn(`[vr] WebGL context lost${this.xrEntry ? ` ${ms(performance.now() - this.xrEntry.t0)} into entering VR` : ''}`);
  };

  private readonly onRestored = (): void => {
    console.warn(`[vr] WebGL context restored${this.xrEntry ? ` ${ms(performance.now() - this.xrEntry.t0)} into entering VR` : ''}`);
  };

  /** Times a headset frame while entering VR; reports after the fifth. */
  private timeXrFrame(start: number): void {
    const e = this.xrEntry;
    if (!e || !this.webgl.xr.isPresenting) return;
    const end = performance.now();
    if (e.frames.length === 0) e.frames.push(start - e.set);
    e.frames.push(end - start);
    if (e.frames.length < 6) return;
    this.xrEntry = null;
    const [wait, ...cost] = e.frames;
    const compiled = (this.webgl.info.programs?.length ?? 0) - e.programs;
    console.info(
      `[vr] entered VR: session granted after ${ms(e.granted - e.t0)}, setSession ${ms(e.set - e.granted)}, ` +
        `first headset frame ${ms(wait!)} later; first frames took ${cost.map(ms).join(', ')}; ${compiled} shader programs compiled for them` +
        (e.lost ? '; the WebGL context was lost and rebuilt' : ''),
    );
  }

  private readonly frame = (now: number): void => {
    const { game, sr, webgl: renderer, el, drawSize, rig, hudOverlay, cockpit, views } = this;
    const gameCam = this.gameCamera;
    const s = this.settings();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    const elapsedMs = now - this.last;
    this.last = now;
    const session = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
    const xr = session !== null;
    // a session that ended (the host's, which this view does not hear end) lets go of the controllers' keys
    if (!xr && this.xrWas) this.xrInput.release();
    this.xrWas = xr;
    // the controllers are read before the pass, as the keyboard's interrupts arrive before it
    if (session) this.xrInput.poll(session, game.mode === 'play');
    // the draw and LOD distances: pushed out in Modern and in a headset, the original's in Faithful - set
    // before the pass, whose mech_lod_update reads them
    const en = s.enhance;
    const far = xr || !s.faithful ? s.view : { viewDistance: 1, detail: 1 };
    // the enhancements (render/enhance): the main view's uniforms, and mech_lod_update's policy before the pass reads it
    sr.uniforms.uPanels.value = en.mechPanels ? 1 : 0;
    projectionGlobals.lodAllNear = en.mechsAllTop ? 1 : 0;
    const lodScale = far.detail;
    if (projectionGlobals.lodDistanceScale !== lodScale) {
      projectionGlobals.lodDistanceScale = lodScale;
      for (const v of new Set([cameraGlobals.mainViewer, cameraGlobals.viewerPosition])) if (v) viewerRefreshLodScale(v);
    }
    const playing = game.mode === 'play';
    let passed = false;
    if (playing) {
      // the game's render requests are per pass of its loop: between passes the last one is drawn again
      const onPass = () => {
        views.beginFrame();
        passed = true;
      };
      if (!game.playFrame(elapsedMs, onPass)) game.setMode('edit');
    }
    // after the frame: the loop may have ended and left Edit. A headset always looks through the game's camera
    const outside = this.opts.lookThrough?.(dt, xr) ?? null;
    const scene = outside !== null && !xr;
    const camera = scene ? outside.camera : gameCam;
    // the palette on screen follows the game's (day cycle, infrared, flashes) as well as the editor's choice
    const key = game.paletteKey();
    if (this.paletteDirty || key !== this.lastPalette) {
      this.paletteDirty = false;
      this.lastPalette = key;
      const p = game.paletteRgb();
      if (p) sr.setPalette(p);
    }
    // the sky enhancement's indices, from the palette on screen and the mission's sky colour
    const skyFor = `${key}|${lighting.skyColour}|${lighting.groundColour}`;
    if (skyFor !== this.skyChoiceFor) {
      this.skyChoiceFor = skyFor;
      const p = game.paletteRgb();
      this.skyChoice = p ? skyPaletteChoice(p, lighting.skyColour & 255) : null;
      const g = lighting.groundColour & 255;
      this.groundShadesNow = p ? groundShades(p, g) : [g, g, g, g, g];
      if (p) {
        this.shadows.setPalette(p, sr.uniforms);
        const lamps = this.lampColours;
        lamps.blank = darkestIndex(p);
        lamps.red = nearestIndex(p, 63, 8, 4);
        lamps.amber = nearestIndex(p, 63, 42, 0);
        lamps.green = nearestIndex(p, 12, 60, 12);
      }
    }
    const w = el.clientWidth;
    const h = el.clientHeight;
    let aspect: number;
    if (xr) {
      // the headset owns the framebuffer's size (three refuses a resize while presenting)
      aspect = 640 / 480;
    } else if (s.faithful) {
      const k = Math.min(w / 640, h / 480);
      renderer.setSize(640, 480, false);
      renderer.domElement.style.width = `${Math.floor(640 * k)}px`;
      renderer.domElement.style.height = `${Math.floor(480 * k)}px`;
      renderer.domElement.style.imageRendering = 'pixelated';
      aspect = 640 / 480;
    } else {
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      renderer.domElement.style.imageRendering = 'auto';
      aspect = w / h;
    }
    if (scene) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    } else cameraFromViewer(viewer(), gameCam, aspect);
    // the rig follows the viewer pass by pass (interpolated between them), or stands with it while paused
    if (!scene) {
      if (!playing) rig.hold(gameCam, now);
      else if (passed) rig.recordPass(gameCam, now);
    }
    game.updateTextures(sr);
    const tanH = 0x10000 / Math.min(0x100000, Math.max(0x8000, viewer().zoom | 0));
    let head: THREE.ArrayCamera | null = null;
    // the player's mech whole round the cockpit (render/enhance/ownChassis.ts): the torso in view too
    // from an outside camera, which stands outside it
    sr.ownChassis = this.ownChassis.update(en.ownChassis, cameraGlobals.cockpitViewActive !== 0, this.readPoly, scene);
    if (xr) {
      rig.settings = s.xr;
      rig.update(now, game.loopRate === null);
      renderer.xr.updateCamera(rig.camera);
      head = renderer.xr.getCamera();
      // the game's viewer standing at the head: what a turned head sees is culled from there
      sr.sync(rig.cullViewer(head, viewer(), this.xrViewer, far.viewDistance));
      this.xrFar = far.viewDistance;
      // the mech's own arms and guns ride with the cockpit (a pass behind), not with the world
      if (cameraGlobals.cockpitViewActive !== 0) sr.carryOwned(mechs.playerMechIndex, rig.cockpitMatrix(gameCam, this.carry, 1));
      const vp = head.cameras[0]?.viewport;
      drawSize.set(vp?.z ?? 1, vp?.w ?? 1);
    } else {
      // the game's viewer as the cull, LOD and clipper see it: its own, or standing at the outside camera -
      // a copy whenever its far distance is pushed out, the sim reading the game's own
      const k = far.viewDistance;
      if (scene) sr.sync(farther(outside.viewer(), k));
      else sr.sync(k === 1 ? viewer() : farther(copyViewer(viewer(), this.modernViewer), k));
      renderer.getDrawingBufferSize(drawSize);
    }
    // Play: the main view only when the game's render hook asked for it this frame (not while the
    // map has the hook), with its wipe colour in place of sky and ground when it gave one
    const wipe = playing ? views.mainWipe : null;
    const skyState = {
      sky: wipe ?? lighting.skyColour,
      ground: wipe ?? lighting.groundColour,
      skyOn: wipe !== null || lighting.skyEnabled !== 0,
      groundOn: wipe !== null || lighting.groundEnabled !== 0,
      bandHeight: lighting.horizonBandHeight,
      screenWidth: Math.max(1, defaultCanvas.xMax + 1),
      bandOn: wipe === null && lighting.horizonBandEnabled !== 0 && renderOptions.shadedFillEnabled !== 0,
    };
    this.skyGround.mesh.visible = !xr;
    this.xrSky.mesh.visible = xr;
    this.skyGround.setDetail(en.sky && wipe === null ? this.skyChoice : null);
    this.xrSky.setDetail(en.sky && wipe === null ? this.skyChoice : null);
    // the ground surface under the eye, and the scrounge field round the game's patch
    const eyeAt = head ? new THREE.Vector3().setFromMatrixPosition(head.matrixWorld) : camera.position;
    this.groundField.updateGrid(eyeAt, this.groundShadesNow, en.ground && wipe === null && lighting.groundEnabled !== 0);
    this.groundField.updateField(sr, en.ground);
    // the shadow map along the mission's light (the one sync just latched), round the eye
    if (en.shadows && (!playing || views.mainRequested)) {
      const [ex, ey, ez] = fromThree(eyeAt.x, eyeAt.y, eyeAt.z);
      this.shadows.render(renderer, sr.scene, eyeAt, lightDirection(renderView.light, [ex, ey, ez]), sr.uniforms);
    } else sr.uniforms.uShadowOn.value = 0;
    if (head) this.xrSky.update(new THREE.Vector3().setFromMatrixPosition(head.matrixWorld), tanH, skyState);
    else this.skyGround.update(camera, drawSize.x, drawSize.y, skyState);
    sr.setViewport(drawSize.x, drawSize.y);
    // the cockpit: the chassis's hand-built design when there is one, in place of the shell's own mesh
    const mapUp = radar.mode >= 3;
    const inCockpit = en.cockpit && (!scene || outside.cockpit !== 'hidden') && cameraGlobals.cockpitViewActive !== 0 && !mapUp;
    if (this.cockpitKey === null && viewScene.cockpitHeadNode) this.cockpitKey = cockpitChassis(game.data.prj);
    const headObj = viewScene.cockpitHeadNode?.userData ?? null;
    const headEntry = headObj ? sr.cockpitEntryOf(headObj) : null;
    const design = inCockpit && headEntry ? (DESIGNS[this.cockpitPreview ?? this.cockpitKey ?? ''] ?? null) : null;
    if (design && headEntry) {
      // its colours are the shell's: the ramps its words are in
      if (this.cockpitRampsOf !== `${design.key}|${this.lastPalette}`) {
        const words: number[] = [];
        for (const m of headEntry.meshes) for (const word of m.draw) words.push(word);
        this.hullRamps = commonRamps(words);
        if (this.hullRamps.length) this.cockpitRampsOf = `${design.key}|${this.lastPalette}`;
      }
      // the design's cabin stands in for the shell's mesh; the head's arms and guns stay
      headEntry.group.visible = false;
    }
    cockpit.setDesign(design, buildDesign);
    // the cockpit shell (or, under a hand-built cockpit, the head's arms): in a headset, carried to the rig
    // and scaled about the eye (xrRig.ts) - at their own scale when the shell itself is not drawn
    if (xr) {
      rig.cockpitMatrix(gameCam, sr.cockpitScene.matrix, design ? 1 : undefined);
      sr.cockpitScene.matrixWorldNeedsUpdate = true;
      this.cockpitMoved = true;
    } else if (this.cockpitMoved) {
      sr.cockpitScene.matrix.identity();
      sr.cockpitScene.matrixWorldNeedsUpdate = true;
      this.cockpitMoved = false;
    }
    const view = xr ? rig.camera : camera;
    // a headset's passes, run through its camera and kept for the spectator camera to run again (spectate)
    const xrPasses = this.xrPasses;
    xrPasses.length = 0;
    const xrPass = (draw: (c: THREE.Camera) => void, world = false) => {
      draw(view);
      xrPasses.push({ draw, world });
    };
    this.xrFrameDt = dt;
    const hudReady = !scene && hudOverlay.update(game.windowShown(), drawSize.x, drawSize.y);
    /** the HUD layers drawn apart this frame, in the world (a headset only) */
    let lifted = 0;
    renderer.clear();
    if (!playing || views.mainRequested) {
      // the sky and the backdrop, then the world over them
      const world = (c: THREE.Camera) => {
        renderer.render(sr.backdropScene, c);
        renderer.clearDepth();
        renderer.render(sr.scene, c);
      };
      if (xr) xrPass(world, true);
      else world(view);
      if (xr) {
        // the reticle and the target marker, across the game's field of view far out from the pass's
        // eye, so they lie on what they mark; no depth test against the world, and the cockpit covers them
        if (hudReady) {
          lifted = this.liftHudLayers(tanH, dt);
          if (lifted) {
            const marker = hudOverlay.markerMesh.visible;
            xrPass((c) => {
              hudOverlay.worldMesh.visible = false;
              hudOverlay.reticleMesh.visible = true;
              hudOverlay.markerMesh.visible = marker;
              renderer.render(rig.hudScene, c);
            });
          }
        }
        // scaled, the shell's nearest parts stay well beyond the headset's 10 cm near plane
        xrPass((c) => {
          renderer.clearDepth();
          renderer.render(sr.cockpitScene, c);
        });
      } else if (!scene) {
        // the cockpit shell, painted over the world (empty outside the cockpit view). Its near clip
        // is 8 cm, inside three's 50 cm near plane, so the pass runs with the plane pulled in
        renderer.clearDepth();
        const near = camera.near;
        camera.near = 0.04;
        camera.updateProjectionMatrix();
        renderer.render(sr.cockpitScene, camera);
        camera.near = near;
        camera.updateProjectionMatrix();
      }
    }
    // the hand-built cockpit and its screens, against the cockpit pass's depth: in the headset at the rig,
    // on the flat screen at the game's eye
    if (design && (hudReady || scene)) {
      const hull = this.hullRamps[0] ?? 0x40;
      cockpit.setColours({ hull, trim: this.hullRamps[1] ?? hull, ...this.lampColours });
      const pc = mechs.mechTable[mechs.playerMechIndex]?.control;
      const n = (v: number | undefined) => (v ?? 0) / 0x400;
      const throttle = pc ? (pc.reverseDirection !== 0 ? -0.5 : 1) * n(pc.throttle) : 0;
      // each widget's pane is its window - where it draws (the radar lays its own over widget 0's)
      const panes = slotPanes((i) => {
        const win = hud.hudWidgets[i]?.window as { left: number; top: number; right: number; bottom: number } | null | undefined;
        return win ? { x: win.left, y: win.top, w: win.right - win.left + 1, h: win.bottom - win.top + 1 } : null;
      });
      // radar modes: 0 off, 1 small, 2 large, 3-5 the map. The large radar stays on the HUD glass, across the
      // view as the original draws it
      if (radar.mode !== 1) panes.radar = null;
      const seat = new THREE.Matrix4().makeTranslation(0, -s.xr.dashDrop, 0);
      cockpit.update((xr ? rig.rig.matrixWorld : gameCam.matrixWorld).clone().multiply(seat), panes, { throttle, turn: n(pc?.legsPan), tilt: n(pc?.torso_tilt) });
      if (xr) xrPass((c) => renderer.render(cockpit.scene, c));
      else if (scene) {
        if (outside.cockpit === 'xray') renderer.clearDepth();
        renderer.render(cockpit.scene, camera);
      } else {
        // nearer than three's 50 cm near plane, like the shell: drawn with the plane pulled in as the shell was
        const near = gameCam.near;
        gameCam.near = 0.04;
        gameCam.updateProjectionMatrix();
        renderer.render(cockpit.scene, gameCam);
        gameCam.near = near;
        gameCam.updateProjectionMatrix();
      }
    } else cockpit.hide();
    hudOverlay.setExcluded(cockpit.shown);
    // the game's 2D (HUD, radar, cockpit text) over it all, through the game's camera - in a headset on a plane ahead
    if (hudReady) {
      if (xr) {
        // the satellite map takes the whole view, as in the original: the HUD plane at the game's full field of view
        rig.placeHud(hudOverlay.worldMesh, tanH, hudOverlay.aspect, mapUp ? 1 : undefined);
        const layers = 0b111 & ~lifted;
        xrPass((c) => {
          hudOverlay.reticleMesh.visible = false;
          hudOverlay.markerMesh.visible = false;
          hudOverlay.worldMesh.visible = true;
          hudOverlay.setWorldLayers(layers);
          renderer.render(rig.hudScene, c);
        });
      } else renderer.render(hudOverlay.scene, hudOverlay.camera);
    }
    this.opts.afterFrame?.(now, camera);
  };

  private readonly readPoly = (id: number) => this.game.data.prj.readResource('POLY', id);

  /**
   * Places the reticle's and the target marker's planes for this frame and
   * returns the layer bits placed. The marker stands at its target's range -
   * but only while the target is in view: off screen the game pins a marker
   * to the edge of the screen, which belongs on the HUD plane with the rest.
   * The reticle stands at the same range while there is one; otherwise at
   * whatever the ray from the pass's eye through the reticle meets first -
   * the drawn world (not the player's own mech), the terrain, the flat
   * ground (render/xr/aim.ts) - out to RETICLE_DISTANCE.
   * Its depth eases between them (in 1 / distance, what the eyes converge
   * on), so a ray sliding off a building does not snap the reticle out.
   */
  private liftHudLayers(tanH: number, dt: number): number {
    const { hudOverlay, rig } = this;
    const gameCam = this.gameCamera;
    const aspect = hudOverlay.aspect;
    let bits = 0;
    hudOverlay.markerMesh.visible = false;
    let targetDepth: number | null = null;
    const t = playerTargetPosition();
    if (t) {
      const p = new THREE.Vector3(...toThree(t[0], t[1], t[2]));
      const inView = p.clone().applyMatrix4(gameCam.matrixWorldInverse);
      const ndc = p.clone().project(gameCam);
      if (inView.z < 0 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1) {
        targetDepth = Math.min(MARKER_MAX_DISTANCE, Math.max(MARKER_MIN_DISTANCE, -inView.z));
        rig.placeLifted(hudOverlay.markerMesh, gameCam, targetDepth, tanH, aspect);
        hudOverlay.markerMesh.visible = true;
        bits |= 1 << HUD_LAYER.targetMarker;
      }
    }
    const want = targetDepth ?? this.aimDepthNow();
    this.reticleInvDepth += (1 / want - this.reticleInvDepth) * (1 - Math.exp(-dt / RETICLE_EASE));
    rig.placeCarried(hudOverlay.reticleMesh, 1 / this.reticleInvDepth, tanH, aspect);
    hudOverlay.reticleMesh.visible = true;
    bits |= 1 << HUD_LAYER.reticle;
    return bits;
  }

  /** The depth of what lies under the reticle (render/xr/aim.ts), out to RETICLE_DISTANCE. */
  private aimDepthNow(): number {
    const { sr } = this;
    const c = this.hudOverlay.reticleCentre;
    const W = defaultCanvas.xMax + 1;
    const H = defaultCanvas.yMax + 1;
    if (!c || W <= 0 || H <= 0) return RETICLE_DISTANCE;
    const world = sr.pickables().filter((m) => rootOf3(m) === sr.scene);
    const own = (m: THREE.Object3D) => {
      const obj = sr.objectOf(m);
      return !!obj?.node && mechOwning(obj.node) === mechs.playerMechIndex;
    };
    return aimDepth(this.gameCamera, new THREE.Vector2((c.x / W) * 2 - 1, 1 - (c.y / H) * 2), world, own, RETICLE_MIN_DISTANCE, RETICLE_DISTANCE);
  }

  /**
   * The page's mirror of the headset: the left eye, copied onto the canvas after each headset frame
   * (one framebuffer blit - the scene is not drawn again). While presenting, three sizes the canvas's
   * drawing buffer to the headset's (both eyes side by side) but not its box on the page, so the eye
   * is cropped to the box's shape and stretched over the whole buffer; the page's scaling then shows
   * it undistorted. The crop is centred where straight ahead falls in the eye - a headset's eyes see
   * further to the outside than the nose side, so that is not the eye image's middle.
   */
  private mirrorEye(target: THREE.WebGLRenderTarget): void {
    const renderer = this.webgl;
    if (!this.mirror.on) return;
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) return;
    const fb = (renderer.properties.get(target) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    const eye = renderer.xr.getCamera().cameras[0];
    const boxW = renderer.domElement.clientWidth;
    const boxH = renderer.domElement.clientHeight;
    if (!fb || !eye || boxW <= 0 || boxH <= 0) return;
    const vp = eye.viewport;
    const aspect = boxW / boxH;
    const w = Math.min(vp.z, vp.w * aspect);
    const h = w / aspect;
    // straight ahead in the eye's NDC: (0, 0, -1) through its projection
    const e = eye.projectionMatrix.elements;
    const cx = vp.x + ((1 - e[8]!) / 2) * vp.z;
    const cy = vp.y + ((1 - e[9]!) / 2) * vp.w;
    const x0 = Math.round(Math.min(Math.max(cx - w / 2, vp.x), vp.x + vp.z - w));
    const y0 = Math.round(Math.min(Math.max(cy - h / 2, vp.y), vp.y + vp.w - h));
    const state = renderer.state;
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    // the blit obeys the scissor test
    state.setScissorTest(false);
    gl.blitFramebuffer(x0, y0, x0 + Math.round(w), y0 + Math.round(h), 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
  }

  /**
   * The spectator camera (render/xr/spectator.ts): this frame's headset passes drawn again through a
   * camera of its own, into a target the page box's shape, and copied onto the canvas the way the mirror
   * copies an eye (stretched over the headset-sized buffer, which the page's scaling undoes). The chase
   * camera draws the world alone, and sees the shadow layer too: the torso the headset does not draw
   * (render/enhance/ownChassis.ts).
   */
  private spectate(xrTarget: THREE.WebGLRenderTarget): void {
    const { webgl: renderer, sr } = this;
    const s = this.settings().spectator;
    const head = renderer.xr.getCamera();
    const gl = renderer.getContext();
    const boxW = renderer.domElement.clientWidth;
    const boxH = renderer.domElement.clientHeight;
    if (!(gl instanceof WebGL2RenderingContext) || boxW <= 0 || boxH <= 0) return;
    if (s.mode !== this.spectatorMode) {
      this.spectatorMode = s.mode;
      this.spectator.reset();
    }
    // the page box at the screen's pixel density, up to half as many pixels again as 1920 x 1080: each is
    // drawn a second time, on top of the headset's two eyes
    const k = Math.min(window.devicePixelRatio || 1, Math.sqrt((1920 * 1080 * 1.5) / (boxW * boxH)));
    const w = Math.max(1, Math.round(boxW * k));
    const h = Math.max(1, Math.round(boxH * k));
    if (!this.spectatorTarget) this.spectatorTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    else if (this.spectatorTarget.width !== w || this.spectatorTarget.height !== h) this.spectatorTarget.setSize(w, h);
    const target = this.spectatorTarget;
    const cam = this.spectator.place(s, head, this.rig.rig, this.xrFrameDt, w / h);
    const chase = s.mode === 'chase';
    cam.layers.set(0);
    if (chase) {
      cam.layers.enable(SHADOW_LAYER);
      // the world as the chase camera sees it: the cull and the clipper's facing were the head's, and from
      // behind the mech they drop what lies behind the head and every face turned from it - most of the
      // mech. The headset's frame is drawn already; the next frame syncs for the head again
      sr.sync(farther(viewerFromCamera(cam, viewer(), this.chaseViewer), this.xrFar));
      if (cameraGlobals.cockpitViewActive !== 0) sr.carryOwned(mechs.playerMechIndex, this.carry);
    }
    const viewport = sr.uniforms.uViewport.value.clone();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(target);
    sr.setViewport(w, h);
    renderer.clear();
    for (const p of this.xrPasses) if (!chase || p.world) p.draw(cam);
    sr.uniforms.uViewport.value.copy(viewport);
    renderer.xr.enabled = true;
    renderer.setRenderTarget(xrTarget);
    const fb = (renderer.properties.get(target) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    const xrFb = (renderer.properties.get(xrTarget) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!fb) return;
    const state = renderer.state;
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    state.setScissorTest(false);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (xrFb) state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, xrFb);
  }

  dispose(): void {
    const { webgl } = this;
    const host = this.opts.host;
    // a host's renderer, loop and session go on to the next view
    if (host) host.present(null);
    else webgl.setAnimationLoop(null);
    webgl.domElement.removeEventListener('webglcontextlost', this.onLost);
    webgl.domElement.removeEventListener('webglcontextrestored', this.onRestored);
    if (!host) void webgl.xr.getSession()?.end();
    this.xrInput.release();
    this.detachInput();
    if (renderPort.current === this.views) renderPort.current = null;
    this.views.dispose();
    this.hudOverlay.dispose();
    this.groundField.dispose();
    this.shadows.dispose();
    this.cockpit.dispose();
    this.spectatorTarget?.dispose();
    this.sr.clear();
    if (!host) webgl.dispose();
    this.el.removeChild(webgl.domElement);
  }
}

const ms = (t: number) => `${t.toFixed(0)} ms`;

/** The mech whose scene node is the root above `n`, or -1. */
export function mechOwning(n: SceneNode): number {
  let root = n;
  while (root.parent) root = root.parent;
  for (let i = 0; i < mechs.mechCount; i++) if (mechs.mechTable[i]!.node === root) return i;
  return -1;
}

/** The topmost ancestor of a three.js object (the scene it is in). */
function rootOf3(o: THREE.Object3D): THREE.Object3D {
  let r = o;
  while (r.parent) r = r.parent;
  return r;
}
