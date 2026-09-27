/**
 * The 3D view, through one of two cameras:
 *
 *   game   the game's own viewer (camera_update's): the world as the player
 *          sees it, the cockpit shell and the game's 2D (HUD, radar) over it.
 *          Play always looks through it; nothing in the view is the editor's.
 *   scene  the editor's free camera: fly anywhere, click to pick (the
 *          object's scene node, or the object itself for static scenery), and
 *          the gizmo moves the selected node through the engine's own setter
 *          (scene_node_set_origin + scene_node_walk). Edit mode only; no HUD
 *          or cockpit, which belong to the game's camera.
 *
 * In Edit the bar picks which one to look through (the game camera shows the
 * paused frame). The scene camera keeps its own place across Play.
 *
 * Faithful mode renders at VGA resolution (640 x 480 aspect-fitted) and
 * scales up with nearest filtering, at the original's draw and detail
 * distances; Modern renders at native resolution and draws further out
 * (render/viewSettings.ts), as a headset does.
 *
 * VR (WebXR, where the browser has a headset): the game's camera with the
 * pilot's head inside it - the world, the cockpit shell and the HUD drawn
 * through a rig that follows the game's viewer (render/xr/xrRig.ts), the sky
 * on a sphere (render/xr/xrSky.ts), the controllers as the game's keys and
 * mouse (app/xrInput.ts). The frame runs from the renderer's animation loop,
 * which is the headset's while a session is on.
 *
 * @portOnly
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SceneNode } from '../../generated/classes.gen.ts';
import { SceneNode as SceneNodeClass, Viewer } from '../../generated/classes.gen.ts';
import type { Game } from '../../app/Game.ts';
import { SceneRenderer } from '../../render/SceneRenderer.ts';
import { fromThree, toThree, CM_TO_UNITS } from '../../render/bridge/space.ts';
import { cameraFromViewer, copyViewer, viewerFromCamera } from '../../render/bridge/cameraViewer.ts';
import { attachHostInput } from '../../app/hostInput.ts';
import { sceneNodeSetOrigin, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { cameraGlobals, viewer } from '../../sim/camera/viewer.ts';
import { mechLodUpdate } from '../../sim/world/detailRecords.ts';
import { scroungeFollowViewer } from '../../sim/world/scrounge.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { engineStore, editorStore, useRevision } from '../store/store.ts';
import { select, selected } from '../store/selection.ts';
import { FreeFly } from '../viewport/freeFly.ts';
import { syncFieldsFromNode } from '../inspector/poseSync.ts';
import { SkyGround } from '../../render/passes/skyGround.ts';
import { defaultCanvas } from '../../sim/display/video.ts';
import { HudOverlay } from '../../render/passes/hudOverlay.ts';
import { IndexedViews } from '../../render/passes/indexedView.ts';
import { renderPort } from '../../sim/display/renderPort.ts';
import { renderOptions } from '../../render/shading/polygonColour.ts';
import { lighting } from '../../sim/world/environment.ts';
import { structOf } from './Inspector.tsx';
import { XrRig } from '../../render/xr/xrRig.ts';
import { XrSky } from '../../render/xr/xrSky.ts';
import { XrInput } from '../../app/xrInput.ts';
import { recallXrSettings, storeXrSettings, type XrSettings } from '../../render/xr/xrSettings.ts';
import { farther, recallViewSettings, storeViewSettings, type ViewSettings } from '../../render/viewSettings.ts';
import { playerTargetPosition } from '../../render/xr/xrRig.ts';
import { aimDepth } from '../../render/xr/aim.ts';
import { HUD_LAYER } from '../../engine/vfx/vfx.ts';
import { projectionGlobals, viewerRefreshLodScale } from '../../sim/camera/projection.ts';
import { GroundField } from '../../render/enhance/groundField.ts';
import { lightDirection, Shadows } from '../../render/enhance/shadows.ts';
import { OwnChassis } from '../../render/enhance/ownChassis.ts';
import { renderView } from '../../render/pipeline/viewLatch.ts';
import { commonRamps, CockpitRenderer, darkestIndex, nearestIndex, slotPanes } from '../../render/cockpit/cockpit.ts';
import { cockpitChassis } from '../../render/cockpit/chassis.ts';
import { buildDesign, DESIGNS } from '../../render/cockpit/designs/index.ts';
import { radar } from '../../sim/cockpit/radar.ts';
import { viewScene } from '../../sim/world/viewScene.ts';
import { hud } from '../../sim/cockpit/hud.ts';
import { skyPaletteChoice, type SkyChoice } from '../../render/enhance/skyDetail.ts';
import { groundShades } from '../../render/enhance/paletteRuns.ts';
import { ENHANCE_LABELS, recallEnhanceSettings, storeEnhanceSettings, type EnhanceSettings } from '../../render/enhance/enhanceSettings.ts';

/** VR: the reticle's plane - out to this far with nothing under it, never nearer than the min, easing over RETICLE_EASE seconds (metres) */
const RETICLE_DISTANCE = 300;
const RETICLE_MIN_DISTANCE = 3;
const RETICLE_EASE = 0.12;
/** VR: the range the target marker's plane is held to (metres) */
const MARKER_MIN_DISTANCE = 5;
const MARKER_MAX_DISTANCE = 3000;

/** which camera Edit looks through */
type EditView = 'scene' | 'game';

/** Faithful (VGA) or Modern (native resolution), remembered (localStorage, as the loop rate is); Faithful at first. */
const FAITHFUL_KEY = 'mw2.faithful';
function recallFaithful(): boolean {
  try {
    return localStorage.getItem(FAITHFUL_KEY) !== 'modern';
  } catch {
    return true;
  }
}
function storeFaithful(on: boolean): void {
  try {
    localStorage.setItem(FAITHFUL_KEY, on ? 'faithful' : 'modern');
  } catch {
    /* private window: not remembered */
  }
}

export function Viewport({ game }: { game: Game }) {
  useRevision(engineStore);
  const host = useRef<HTMLDivElement>(null);
  const [faithful, setFaithful] = useState(recallFaithful);
  const [editView, setEditView] = useState<EditView>('scene');
  const [info, setInfo] = useState('');
  const faithfulRef = useRef(faithful);
  const editViewRef = useRef(editView);
  const paletteDirty = useRef(false);
  const [xrSupported, setXrSupported] = useState(false);
  const [xrOn, setXrOn] = useState(false);
  /** VR asked for and the headset not yet given it (the browser and the XR runtime can take a minute) */
  const [xrPending, setXrPending] = useState(false);
  /** enters VR, or leaves it while in it (set by the renderer's effect) */
  const toggleXr = useRef<(() => void) | null>(null);
  const [xrSettings, setXrSettings] = useState<XrSettings>(recallXrSettings);
  const xrSettingsRef = useRef(xrSettings);
  const [viewSettings, setViewSettings] = useState<ViewSettings>(recallViewSettings);
  const viewSettingsRef = useRef(viewSettings);
  const [enhance, setEnhance] = useState<EnhanceSettings>(recallEnhanceSettings);
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const enhanceRef = useRef(enhance);
  useEffect(() => {
    enhanceRef.current = enhance;
    storeEnhanceSettings(enhance);
  }, [enhance]);
  useEffect(() => {
    xrSettingsRef.current = xrSettings;
    storeXrSettings(xrSettings);
  }, [xrSettings]);
  useEffect(() => {
    viewSettingsRef.current = viewSettings;
    storeViewSettings(viewSettings);
  }, [viewSettings]);
  useEffect(() => {
    faithfulRef.current = faithful;
    storeFaithful(faithful);
  }, [faithful]);
  useEffect(() => {
    navigator.xr
      ?.isSessionSupported('immersive-vr')
      .then(setXrSupported)
      .catch(() => setXrSupported(false));
  }, []);
  useEffect(() => {
    editViewRef.current = editView;
  }, [editView]);

  useEffect(() => {
    const el = host.current!;
    lodFrom = null;
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(1);
    el.appendChild(renderer.domElement);
    const sr = new SceneRenderer();
    const pal = game.paletteRgb();
    if (pal) sr.setPalette(pal);
    let lastPalette = game.paletteKey();
    const luma = game.lumaRows();
    if (luma) sr.setLuma(luma);
    game.bindTextures(sr);

    /** the editor's view: flown with FreeFly, picked through, the gizmo's */
    const sceneCam = new THREE.PerspectiveCamera(60, 4 / 3, 0.5, 20000);
    /** the game's view: set from the game's viewer every frame it is shown */
    const gameCam = new THREE.PerspectiveCamera(60, 4 / 3, 0.5, 20000);
    /** true while the editor's scene camera is the one shown (Edit, scene view) */
    const sceneView = () => game.mode === 'edit' && editViewRef.current === 'scene';
    const editorViewer = new Viewer();
    /** the game's viewer as the Modern view culls for it: its far distance pushed out (viewSettings.ts) */
    const modernViewer = new Viewer();
    const drawSize = new THREE.Vector2();
    const skyGround = new SkyGround(sr.uniforms);
    sr.backdropScene.add(skyGround.mesh);
    const hudOverlay = new HudOverlay(sr.uniforms);
    // the hand-built cockpits (render/cockpit): the chassis's design, its colours, and a preview override
    const cockpit = new CockpitRenderer(hudOverlay.windowUniforms);
    let cockpitKey: string | null = null;
    let previewKey: string | null = null;
    /**
     * The hand-built cockpit through the scene camera too, where it stands: at the game's eye. In the
     * cockpit view the player's mech is built at its cockpit level, so round it there is only the head's
     * arms and guns - the cockpit is a box standing in the air above the legs, which is what it is.
     */
    let cockpitOutside = true;
    /** debug: the scene camera sees the cockpit through the mech round it (drawn after a depth clear) */
    let cockpitXray = false;
    let cockpitRampsOf: string | null = null;
    let hullRamps: number[] = [];
    const lampColours = { red: 0, amber: 0, green: 0, blank: 0 };
    renderer.autoClear = false;
    // VR: the rig the headset sits in, the sky about it, the controllers
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    const rig = new XrRig();
    const xrSky = new XrSky(sr.uniforms);
    sr.backdropScene.add(xrSky.mesh);
    // the enhancements (render/enhance): the ground surface with the backdrop, the scrounge field in the world
    const groundField = new GroundField(sr.uniforms);
    sr.backdropScene.add(groundField.grid);
    sr.scene.add(groundField.field);
    const shadows = new Shadows();
    const ownChassis = new OwnChassis();
    const readPoly = (id: number) => game.data.prj.readResource('POLY', id);
    let skyChoice: SkyChoice | null = null;
    /** the ground grid's five shades of the ground colour (paletteRuns.ts groundShades) */
    let groundShadesNow: number[] = [0xef, 0xef, 0xef, 0xef, 0xef];
    let skyChoiceFor = '';
    const xrInput = new XrInput();
    const xrViewer = new Viewer();
    /** the pass's eye to the interpolated rig, for the mech's own parts (SceneRenderer.carryOwned) */
    const carry = new THREE.Matrix4();
    /** the cockpit scene carries the rig's matrix (reset on leaving VR) */
    let cockpitMoved = false;
    const onXrEnd = () => {
      xrInput.release();
      setXrOn(false);
    };
    /**
     * Entering VR, timed (one console line once the headset has had five frames): the session's grant,
     * three's setSession (which awaits makeXRCompatible - a context the headset's GPU cannot use is
     * lost and rebuilt, every shader and texture with it), the first headset frame, and the first few
     * frames' cost with the shaders compiled for them. Measured on the user's PC headset: the grant took
     * 55 s - the browser and the XR runtime starting up, before the page is involved - and all the
     * rest under 50 ms.
     */
    let xrEntry: { t0: number; granted: number; set: number; frames: number[]; programs: number; lost: boolean } | null = null;
    const ms = (t: number) => `${t.toFixed(0)} ms`;
    const vrLog = (text: string) => console.info(`[vr] ${text}`);
    const onLost = () => {
      if (xrEntry) xrEntry.lost = true;
      console.warn(`[vr] WebGL context lost${xrEntry ? ` ${ms(performance.now() - xrEntry.t0)} into entering VR` : ''}`);
    };
    const onRestored = () => console.warn(`[vr] WebGL context restored${xrEntry ? ` ${ms(performance.now() - xrEntry.t0)} into entering VR` : ''}`);
    renderer.domElement.addEventListener('webglcontextlost', onLost);
    renderer.domElement.addEventListener('webglcontextrestored', onRestored);
    toggleXr.current = () => {
      const current = renderer.xr.getSession();
      if (current) {
        void current.end();
        return;
      }
      if (!navigator.xr) return;
      const entry = { t0: performance.now(), granted: 0, set: 0, frames: [] as number[], programs: renderer.info.programs?.length ?? 0, lost: false };
      xrEntry = entry;
      // the mission holds (the game's own pause, sound and all) until the headset is showing it: the
      // session can take a minute to be granted, and the pilot is not in the seat yet
      const resume = game.mode === 'play';
      if (resume) game.setMode('edit');
      setXrPending(true);
      const done = () => {
        setXrPending(false);
        if (resume && game.mode !== 'play') game.setMode('play');
      };
      navigator.xr
        .requestSession('immersive-vr', { optionalFeatures: ['local'] })
        .then(async (session) => {
          entry.granted = performance.now();
          session.addEventListener('end', onXrEnd, { once: true });
          await renderer.xr.setSession(session);
          entry.set = performance.now();
          setXrOn(true);
          done();
        })
        .catch((err: unknown) => {
          xrEntry = null;
          done();
          console.warn('VR session refused', err);
        });
    };
    /** Times a headset frame while entering VR; reports after the fifth. */
    const timeXrFrame = (start: number) => {
      const e = xrEntry;
      if (!e || !renderer.xr.isPresenting) return;
      const end = performance.now();
      if (e.frames.length === 0) e.frames.push(start - e.set);
      e.frames.push(end - start);
      if (e.frames.length < 6) return;
      xrEntry = null;
      const [wait, ...cost] = e.frames;
      const compiled = (renderer.info.programs?.length ?? 0) - e.programs;
      vrLog(
        `entered VR: session granted after ${ms(e.granted - e.t0)}, setSession ${ms(e.set - e.granted)}, ` +
          `first headset frame ${ms(wait!)} later; first frames took ${cost.map(ms).join(', ')}; ${compiled} shader programs compiled for them` +
          (e.lost ? '; the WebGL context was lost and rebuilt' : ''),
      );
    };
    const fly = new FreeFly(sceneCam, el, sceneView);
    // start at the player's mech, else the mission's start view (VWST)
    const player = mechs.mechTable[mechs.playerMechIndex];
    const v = cameraGlobals.mainViewer;
    const start = player?.node ? [player.node.worldPos[0]!, player.node.worldPos[1]!, player.node.worldPos[2]!] : [v.posX, v.posY, v.posZ];
    const [sx, sy, sz] = toThree(start[0]!, start[1]!, start[2]!);
    sceneCam.position.set(sx - 15, sy + 12, sz + 25);
    fly.lookAt(new THREE.Vector3(sx, sy + 3, sz));

    // debug handle: window.mw2.view.camera (the scene camera) / .gameCamera / .fly (setting fly.yaw / fly.pitch aims it) / .renderer / .views / .dash / .hudOverlay
    const dbg = (window as unknown as { mw2?: Record<string, unknown> }).mw2;

    const gizmo = new TransformControls(sceneCam, renderer.domElement);
    gizmo.setSpace('world');
    const gizmoHelper = gizmo.getHelper();
    sr.scene.add(gizmoHelper);
    const proxy = new THREE.Object3D();
    sr.scene.add(proxy);
    let gizmoNode: SceneNode | null = null;
    gizmo.addEventListener('objectChange', () => {
      if (!gizmoNode) return;
      // world -> the node's parent space is not needed for roots; for children, move by the world delta
      const [gx, gy, gz] = fromThree(proxy.position.x, proxy.position.y, proxy.position.z);
      const dx = gx - gizmoNode.worldPos[0]!;
      const dy = gy - gizmoNode.worldPos[1]!;
      const dz = gz - gizmoNode.worldPos[2]!;
      sceneNodeSetOrigin(gizmoNode, gizmoNode.localX + dx, gizmoNode.localY + dy, gizmoNode.localZ + dz);
      sceneNodeWalk(rootOf(gizmoNode));
      syncFieldsFromNode(selected()?.target);
      engineStore.bump();
    });
    // the mouse-up that ends a drag also arrives as a click: it must not re-pick
    let dragEnded = false;
    gizmo.addEventListener('dragging-changed', (ev) => {
      if (!(ev as { value?: boolean }).value) dragEnded = true;
    });
    // an edit made elsewhere (the inspector) can move the node: keep the handle on it
    const unsubEngine = engineStore.subscribe(() => {
      if (!gizmoNode || gizmo.dragging) return;
      const [px, py, pz] = toThree(gizmoNode.worldPos[0]!, gizmoNode.worldPos[1]!, gizmoNode.worldPos[2]!);
      proxy.position.set(px, py, pz);
    });

    const unsubSel = editorStore.subscribe(() => {
      const s = selected();
      const node = s && s.target instanceof SceneNodeClass ? s.target : ((s?.target as { node?: SceneNode | null } | undefined)?.node ?? null);
      gizmoNode = node instanceof SceneNodeClass ? node : null;
      if (gizmoNode) {
        const [px, py, pz] = toThree(gizmoNode.worldPos[0]!, gizmoNode.worldPos[1]!, gizmoNode.worldPos[2]!);
        proxy.position.set(px, py, pz);
        gizmo.attach(proxy);
      } else gizmo.detach();
    });

    // F: frame the selection, as in Unity (scene view only - in the game, F is TARGET_FRIENDLY)
    const onKey = (e: KeyboardEvent) => {
      if (!sceneView() || e.code !== 'KeyF' || !gizmoNode || isTextField(e.target)) return;
      // aim a few metres up the node (a mech's node is at its feet) from 25 m out
      const t = proxy.position.clone().add(new THREE.Vector3(0, 4, 0));
      const back = new THREE.Vector3().subVectors(sceneCam.position, t);
      if (back.lengthSq() < 1e-6) back.set(0, 0.5, 1);
      sceneCam.position.copy(t).add(back.normalize().multiplyScalar(25));
      fly.lookAt(t);
    };
    window.addEventListener('keydown', onKey);

    const ray = new THREE.Raycaster();
    const onClick = (e: MouseEvent) => {
      if (dragEnded) {
        dragEnded = false;
        return;
      }
      if (!sceneView() || e.button !== 0 || gizmo.dragging) return;
      const r = renderer.domElement.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(p, sceneCam);
      const hits = ray.intersectObjects(sr.pickables(), false);
      const obj = hits.length ? sr.objectOf(hits[0]!.object) : null;
      if (!obj) return;
      // Unity-style: a click selects the gamepiece the part belongs to; Alt+click the part itself
      const owner = !e.altKey && obj.node ? mechOwning(obj.node) : -1;
      if (owner >= 0) {
        const m = mechs.mechTable[owner]!;
        select({ label: `Gamepieces[${owner}] ${m.name}`, struct: 'MechEntity', target: m });
      } else if (obj.node) select({ label: `node of object (type 0x${obj.type.toString(16)})`, struct: 'SceneNode', target: obj.node });
      else select({ label: `object (type 0x${obj.type.toString(16)})`, struct: structOf(obj), target: obj });
    };
    renderer.domElement.addEventListener('click', onClick);

    // Play: the PC's keyboard and mouse feed the game's GIDDI drivers
    const detachInput = attachHostInput(renderer.domElement, () => game.mode === 'play');
    // the game's render calls: main's render hook (vfx_video_sub_010490) asks for the main
    // view, drawn below once the loop pass returns; the HUD's inset views and the map are
    // drawn when the game asks, into the window's pixels (render/passes/indexedView.ts)
    const views = new IndexedViews(renderer, sr.uniforms);
    renderPort.current = views;
    const cockpitDebug = {
      keys: Object.keys(DESIGNS),
      /** draws `key`'s cockpit whatever the player's chassis (null: the player's own) */
      preview(key: string | null) {
        previewKey = key;
      },
      get current() {
        return cockpit.current?.key ?? null;
      },
      /** whether the scene camera sees the cockpit (on by default) */
      set outside(on: boolean) {
        cockpitOutside = on;
      },
      /** whether the scene camera sees the cockpit through the mech round it (off by default) */
      set xray(on: boolean) {
        cockpitXray = on;
      },
    };
    if (dbg) dbg.view = { camera: sceneCam, gameCamera: gameCam, fly, renderer: sr, views, cockpit: cockpitDebug, hudOverlay };

    let last = performance.now();
    let lastInfo = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      const elapsedMs = now - last;
      last = now;
      const session = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
      const xr = session !== null;
      // the controllers are read before the pass, as the keyboard's interrupts arrive before it
      if (session) xrInput.poll(session, game.mode === 'play');
      // the draw and LOD distances: pushed out in Modern and in a headset, the original's in Faithful - set
      // before the pass, whose mech_lod_update reads them
      const en = enhanceRef.current;
      const far = xr || !faithfulRef.current ? viewSettingsRef.current : { viewDistance: 1, detail: 1 };
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
        engineStore.bumpThrottled();
      }
      // after the frame: the loop may have ended and left Edit. A headset always looks through the game's camera
      const scene = sceneView() && !xr;
      const camera = scene ? sceneCam : gameCam;
      // the gizmo is the scene camera's alone
      gizmo.enabled = scene;
      gizmoHelper.visible = scene && gizmoNode !== null;
      if (scene) {
        fly.update(dt);
        viewUpdateFrom(sceneCam.position);
      } else if (!playing) {
        // the paused game view: the detail the game's own viewer would choose
        const gv = viewer();
        viewUpdateFrom(new THREE.Vector3(...toThree(gv.posX, gv.posY, gv.posZ)));
      } else lodFrom = null;
      // the palette on screen follows the game's (day cycle, infrared, flashes) as well as the editor's choice
      const key = game.paletteKey();
      if (paletteDirty.current || key !== lastPalette) {
        paletteDirty.current = false;
        lastPalette = key;
        const p = game.paletteRgb();
        if (p) sr.setPalette(p);
      }
      // the sky enhancement's indices, from the palette on screen and the mission's sky colour
      const skyFor = `${key}|${lighting.skyColour}|${lighting.groundColour}|${paletteDirty.current}`;
      if (skyFor !== skyChoiceFor) {
        skyChoiceFor = skyFor;
        const p = game.paletteRgb();
        skyChoice = p ? skyPaletteChoice(p, lighting.skyColour & 255) : null;
        const g = lighting.groundColour & 255;
        groundShadesNow = p ? groundShades(p, g) : [g, g, g, g, g];
        if (p) shadows.setPalette(p, sr.uniforms);
        if (p) {
          lampColours.blank = darkestIndex(p);
          lampColours.red = nearestIndex(p, 63, 8, 4);
          lampColours.amber = nearestIndex(p, 63, 42, 0);
          lampColours.green = nearestIndex(p, 12, 60, 12);
        }
      }
      const w = el.clientWidth;
      const h = el.clientHeight;
      let aspect: number;
      if (xr) {
        // the headset owns the framebuffer's size (three refuses a resize while presenting)
        aspect = 640 / 480;
      } else if (faithfulRef.current) {
        const s = Math.min(w / 640, h / 480);
        renderer.setSize(Math.floor(640), Math.floor(480), false);
        renderer.domElement.style.width = `${Math.floor(640 * s)}px`;
        renderer.domElement.style.height = `${Math.floor(480 * s)}px`;
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
        sceneCam.aspect = aspect;
        sceneCam.updateProjectionMatrix();
      } else cameraFromViewer(viewer(), gameCam, aspect);
      // the rig follows the viewer pass by pass (interpolated between them), or stands with it while paused
      if (!scene) {
        if (!playing) rig.hold(gameCam, now);
        else if (passed) rig.recordPass(gameCam, now);
      }
      const eye = fromThree(camera.position.x, camera.position.y, camera.position.z);
      game.updateTextures(sr);
      const tanH = 0x10000 / Math.min(0x100000, Math.max(0x8000, viewer().zoom | 0));
      let head: THREE.ArrayCamera | null = null;
      // the player's mech whole round the cockpit (render/enhance/ownChassis.ts): the torso in view too
      // from the scene camera, which stands outside it
      sr.ownChassis = ownChassis.update(en.ownChassis, cameraGlobals.cockpitViewActive !== 0, readPoly, scene);
      if (xr) {
        rig.settings = xrSettingsRef.current;
        rig.update(now, game.loopRate === null);
        renderer.xr.updateCamera(rig.camera);
        head = renderer.xr.getCamera();
        // the game's viewer standing at the head: what a turned head sees is culled from there
        sr.sync(rig.cullViewer(head, viewer(), xrViewer, far.viewDistance));
        // the mech's own arms and guns ride with the cockpit (a pass behind), not with the world
        if (cameraGlobals.cockpitViewActive !== 0) sr.carryOwned(mechs.playerMechIndex, rig.cockpitMatrix(gameCam, carry, 1));
        const vp = head.cameras[0]?.viewport;
        drawSize.set(vp?.z ?? 1, vp?.w ?? 1);
      } else {
        // the game's viewer as the cull, LOD and clipper see it: its own, or standing at the scene camera -
        // a copy whenever its far distance is pushed out, the sim reading the game's own
        const k = far.viewDistance;
        if (scene) sr.sync(farther(viewerFromCamera(sceneCam, cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer, editorViewer), k));
        else sr.sync(k === 1 ? viewer() : farther(copyViewer(viewer(), modernViewer), k));
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
      skyGround.mesh.visible = !xr;
      xrSky.mesh.visible = xr;
      skyGround.setDetail(en.sky && wipe === null ? skyChoice : null);
      xrSky.setDetail(en.sky && wipe === null ? skyChoice : null);
      // the ground surface under the eye, and the scrounge field round the game's patch
      const eyeAt = head ? new THREE.Vector3().setFromMatrixPosition(head.matrixWorld) : camera.position;
      groundField.updateGrid(eyeAt, groundShadesNow, en.ground && wipe === null && lighting.groundEnabled !== 0);
      groundField.updateField(sr, en.ground);
      // the shadow map along the mission's light (the one sync just latched), round the eye
      if (en.shadows && (!playing || views.mainRequested)) {
        const [ex, ey, ez] = fromThree(eyeAt.x, eyeAt.y, eyeAt.z);
        shadows.render(renderer, sr.scene, eyeAt, lightDirection(renderView.light, [ex, ey, ez]), sr.uniforms);
      } else sr.uniforms.uShadowOn.value = 0;
      if (head) xrSky.update(new THREE.Vector3().setFromMatrixPosition(head.matrixWorld), tanH, skyState);
      else skyGround.update(camera, drawSize.x, drawSize.y, skyState);
      sr.setViewport(drawSize.x, drawSize.y);
      // the cockpit: the chassis's hand-built design when there is one, in place of the shell's own mesh
      const mapUp = radar.mode >= 3;
      const inCockpit = en.cockpit && (!scene || cockpitOutside) && cameraGlobals.cockpitViewActive !== 0 && !mapUp;
      if (cockpitKey === null && viewScene.cockpitHeadNode) cockpitKey = cockpitChassis(game.data.prj);
      const headObj = viewScene.cockpitHeadNode?.userData ?? null;
      const headEntry = headObj ? sr.cockpitEntryOf(headObj) : null;
      const design = inCockpit && headEntry ? (DESIGNS[previewKey ?? cockpitKey ?? ''] ?? null) : null;
      if (design && headEntry) {
        // its colours are the shell's: the ramps its words are in
        if (cockpitRampsOf !== `${design.key}|${lastPalette}`) {
          const words: number[] = [];
          for (const m of headEntry.meshes) for (const w of m.draw) words.push(w);
          hullRamps = commonRamps(words);
          if (hullRamps.length) cockpitRampsOf = `${design.key}|${lastPalette}`;
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
        cockpitMoved = true;
      } else if (cockpitMoved) {
        sr.cockpitScene.matrix.identity();
        sr.cockpitScene.matrixWorldNeedsUpdate = true;
        cockpitMoved = false;
      }
      const view = xr ? rig.camera : camera;
      const hudReady = !scene && hudOverlay.update(defaultCanvas, drawSize.x, drawSize.y);
      /** the HUD layers drawn apart this frame, in the world (a headset only) */
      let lifted = 0;
      renderer.clear();
      if (!playing || views.mainRequested) {
        // the sky and the backdrop, then the world over them
        renderer.render(sr.backdropScene, view);
        renderer.clearDepth();
        renderer.render(sr.scene, view);
        if (xr) {
          // the reticle and the target marker, across the game's field of view far out from the pass's
          // eye, so they lie on what they mark; no depth test against the world, and the cockpit covers them
          if (hudReady) {
            lifted = liftHudLayers(tanH, dt);
            if (lifted) {
              hudOverlay.worldMesh.visible = false;
              renderer.render(rig.hudScene, rig.camera);
            }
          }
          // scaled, the shell's nearest parts stay well beyond the headset's 10 cm near plane
          renderer.clearDepth();
          renderer.render(sr.cockpitScene, view);
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
      if (design && (hudReady || (scene && cockpitOutside))) {
        const hull = hullRamps[0] ?? 0x40;
        cockpit.setColours({ hull, trim: hullRamps[1] ?? hull, ...lampColours });
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
        const seat = new THREE.Matrix4().makeTranslation(0, -xrSettingsRef.current.dashDrop, 0);
        cockpit.update((xr ? rig.rig.matrixWorld : gameCam.matrixWorld).clone().multiply(seat), panes, { throttle, turn: n(pc?.legsPan), tilt: n(pc?.torso_tilt) });
        if (xr) renderer.render(cockpit.scene, view);
        else if (scene) {
          if (cockpitXray) renderer.clearDepth();
          renderer.render(cockpit.scene, sceneCam);
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
          hudOverlay.reticleMesh.visible = false;
          hudOverlay.markerMesh.visible = false;
          hudOverlay.worldMesh.visible = true;
          hudOverlay.setWorldLayers(0b111 & ~lifted);
          // the satellite map takes the whole view, as in the original: the HUD plane at the game's full field of view
          rig.placeHud(hudOverlay.worldMesh, tanH, hudOverlay.aspect, mapUp ? 1 : undefined);
          renderer.render(rig.hudScene, rig.camera);
        } else renderer.render(hudOverlay.scene, hudOverlay.camera);
      }
      if (now - lastInfo > 250) {
        lastInfo = now;
        setInfo(`${sr.stats.objects} objects · ${sr.stats.polygons} polygons · eye ${eye.map((c) => (c * CM_TO_UNITS).toFixed(0)).join(', ')} m`);
      }
    };
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
    let reticleInvDepth = 1 / RETICLE_DISTANCE;
    const liftHudLayers = (tanH: number, dt: number): number => {
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
      const want = targetDepth ?? aimDepthNow();
      reticleInvDepth += (1 / want - reticleInvDepth) * (1 - Math.exp(-dt / RETICLE_EASE));
      rig.placeCarried(hudOverlay.reticleMesh, 1 / reticleInvDepth, tanH, aspect);
      hudOverlay.reticleMesh.visible = true;
      bits |= 1 << HUD_LAYER.reticle;
      return bits;
    };
    /** The depth of what lies under the reticle (render/xr/aim.ts), out to RETICLE_DISTANCE. */
    const aimDepthNow = (): number => {
      const c = hudOverlay.reticleCentre;
      const W = defaultCanvas.xMax + 1;
      const H = defaultCanvas.yMax + 1;
      if (!c || W <= 0 || H <= 0) return RETICLE_DISTANCE;
      const world = sr.pickables().filter((m) => rootOf3(m) === sr.scene);
      const own = (m: THREE.Object3D) => {
        const obj = sr.objectOf(m);
        return !!obj?.node && mechOwning(obj.node) === mechs.playerMechIndex;
      };
      return aimDepth(gameCam, new THREE.Vector2((c.x / W) * 2 - 1, 1 - (c.y / H) * 2), world, own, RETICLE_MIN_DISTANCE, RETICLE_DISTANCE);
    };
    // the renderer's loop: the window's animation frames, or the headset's while a session is on
    /**
     * The page's mirror of the headset: the left eye, copied onto the canvas after each headset frame
     * (one framebuffer blit - the scene is not drawn again). While presenting, three sizes the canvas's
     * drawing buffer to the headset's (both eyes side by side) but not its box on the page, so the eye
     * is cropped to the box's shape and stretched over the whole buffer; the page's scaling then shows
     * it undistorted. The crop is centred where straight ahead falls in the eye - a headset's eyes see
     * further to the outside than the nose side, so that is not the eye image's middle.
     */
    const mirror = { on: true };
    if (dbg) dbg.vrMirror = mirror;
    const mirrorEye = (target: THREE.WebGLRenderTarget) => {
      if (!mirror.on) return;
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
    };
    renderer.setAnimationLoop((now: number) => {
      const start = performance.now();
      // the headset's framebuffer for this frame: three binds it before calling back
      const xrTarget = renderer.xr.isPresenting ? renderer.getRenderTarget() : null;
      frame(now);
      if (xrTarget) mirrorEye(xrTarget);
      timeXrFrame(start);
    });
    return () => {
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
      toggleXr.current = null;
      void renderer.xr.getSession()?.end();
      xrInput.release();
      unsubSel();
      unsubEngine();
      window.removeEventListener('keydown', onKey);
      renderer.domElement.removeEventListener('click', onClick);
      detachInput();
      if (renderPort.current === views) renderPort.current = null;
      views.dispose();
      hudOverlay.dispose();
      groundField.dispose();
      shadows.dispose();
      cockpit.dispose();
      gizmo.dispose();
      fly.dispose();
      sr.clear();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [game, game.mission]);

  const playing = game.mode === 'play';
  const view: EditView = playing ? 'game' : editView;
  return (
    <div className={`viewport${playing ? ' playing' : ''}`} ref={host}>
      <div className="viewport-overlay">
        {playing ? 'PLAY' : 'EDIT'} · {view === 'game' ? 'game camera' : 'scene camera'} · {info}
        <div className="hint">
          {playing
            ? 'the game has the keyboard (INPUT.MAP / GAMEKEY.MAP) · click to capture the mouse · Edit to pause'
            : view === 'scene'
              ? 'right-drag look · WASD/QE fly · wheel speed · click select · F frame'
              : "the paused game, through the game's camera"}
        </div>
      </div>
      {xrPending && (
        <div className="xr-pending">
          <div className="title">Starting VR…</div>
          <div>Put the headset on. The mission is paused and carries on once the headset is showing it.</div>
          <div className="hint">The browser and the VR runtime (SteamVR, Quest Link) can take a minute to start the first time; leaving the runtime running makes it quick.</div>
        </div>
      )}
      <div className="viewport-bar">
        {!playing && (
          <>
            <button className={editView === 'scene' ? 'active' : ''} onClick={() => setEditView('scene')} title="the editor's free camera: fly, pick, move things">
              Scene
            </button>
            <button className={editView === 'game' ? 'active' : ''} onClick={() => setEditView('game')} title="the game's own camera, cockpit and HUD, paused">
              Game
            </button>
          </>
        )}
        <select
          title="palette: the game's own (day cycle at the current time) or a fixed day phase"
          value={game.palettePhase ?? -1}
          onChange={(e) => {
            const v = Number(e.target.value);
            game.setPalettePhase(v < 0 ? null : v);
            paletteDirty.current = true;
          }}
        >
          <option value={-1}>palette: game</option>
          <option value={0}>dawn</option>
          <option value={1}>day</option>
          <option value={2}>dusk</option>
          <option value={3}>night</option>
        </select>
        <button className={faithful ? 'active' : ''} onClick={() => setFaithful(true)} title="VGA resolution, nearest upscale">
          Faithful
        </button>
        <button className={!faithful ? 'active' : ''} onClick={() => setFaithful(false)} title="native resolution, drawn further out">
          Modern
        </button>
        {(!faithful || xrOn) && (
          <>
            <Slider label="view" title="Modern and VR: how far out things are drawn, as a multiple of the mission's far distance (1 = the original's)" value={viewSettings.viewDistance} min={1} max={8} step={0.5} unit="x" onChange={(v) => setViewSettings((s) => ({ ...s, viewDistance: v }))} />
            <Slider label="detail" title="Modern and VR: how far out the detail steps are pushed (1 = the original's)" value={viewSettings.detail} min={1} max={8} step={0.5} unit="x" onChange={(v) => setViewSettings((s) => ({ ...s, detail: v }))} />
          </>
        )}
        <div className="enhance">
          <button className={enhanceOpen ? 'active' : ''} onClick={() => setEnhanceOpen((o) => !o)} title="detail added in the game's own palette terms (the inset displays stay the original's)">
            Enhance
          </button>
          {enhanceOpen && (
            <div className="enhance-menu">
              {(Object.keys(ENHANCE_LABELS) as Array<keyof EnhanceSettings>).map((k) => (
                <label key={k}>
                  <input type="checkbox" checked={enhance[k]} onChange={(e) => setEnhance((s) => ({ ...s, [k]: e.target.checked }))} />
                  {ENHANCE_LABELS[k]}
                </label>
              ))}
            </div>
          )}
        </div>
        {xrSupported && (
          <button
            className={xrOn ? 'active' : xrPending ? 'pending' : ''}
            disabled={xrPending || (!playing && !xrOn)}
            onClick={() => toggleXr.current?.()}
            title={xrOn ? 'leave VR' : xrPending ? 'waiting for the headset' : "VR: sit in the cockpit with a headset (Play). Left stick throttle and turn, right stick torso, triggers fire, A/B targets, X view, Y menu"}
          >
            {xrPending ? 'VR…' : 'VR'}
          </button>
        )}
        {xrSupported && (
          <>
            <Slider label="cockpit" title="the cockpit's size about your eye (1 = the mech's own scale)" value={xrSettings.cockpitScale} min={0.15} max={1.5} step={0.05} unit="x" onChange={(v) => setXrSettings((s) => ({ ...s, cockpitScale: v }))} />
            <Slider label="HUD" title="the HUD's width as a share of the game's view (the reticle and target brackets are drawn in the world, not on it)" value={xrSettings.hudScale} min={0.3} max={1} step={0.05} unit="%" onChange={(v) => setXrSettings((s) => ({ ...s, hudScale: v }))} />
            <Slider label="seat" title="VR cockpit: how far the cockpit sits below its place (a taller or shorter pilot)" value={xrSettings.dashDrop} min={-0.3} max={0.3} step={0.02} unit="m" onChange={(v) => setXrSettings((s) => ({ ...s, dashDrop: v }))} />
            <Slider label="at" title="how far ahead of your eye the HUD stands" value={xrSettings.hudDistance} min={0.5} max={5} step={0.1} unit="m" onChange={(v) => setXrSettings((s) => ({ ...s, hudDistance: v }))} />
          </>
        )}
      </div>
    </div>
  );
}

/** One of the view's or the VR sizes: a slider and its value. */
function Slider(p: { label: string; title: string; value: number; min: number; max: number; step: number; unit: 'x' | '%' | 'm'; onChange: (v: number) => void }) {
  const shown = p.unit === '%' ? `${Math.round(p.value * 100)}%` : p.unit === 'x' ? `${p.value.toFixed(2)}x` : `${p.value.toFixed(1)} m`;
  return (
    <label className="xr-slider" title={p.title}>
      {p.label}
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <span>{shown}</span>
    </label>
  );
}

function isTextField(t: EventTarget | null): boolean {
  const tag = (t as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The mech whose scene node is the root above `n`, or -1. */
function mechOwning(n: SceneNode): number {
  const root = rootOf(n);
  for (let i = 0; i < mechs.mechCount; i++) if (mechs.mechTable[i]!.node === root) return i;
  return -1;
}

/**
 * Edit mode: every frame the game keeps some things where the viewer is -
 * each mech's detail level by its range (mech_lod_update) and the ground
 * detail patch snapped to the grid cell under the camera
 * (scrounge_follow_viewer, from camera_update). No frame runs while paused
 * and the scene camera is not the viewer, so the mechs would keep the detail
 * chosen from the start view and the patch, which scrounge_install takes out
 * of the world at load, would never come back. This runs the game's own two
 * functions with the viewer standing, for the call, where the camera shown
 * is (the scene camera, or the game's own viewer when looking through it).
 *
 * @portOnly
 */
let lodFrom: [number, number, number] | null = null;
function viewUpdateFrom(eye: THREE.Vector3): void {
  const [x, y, z] = fromThree(eye.x, eye.y, eye.z);
  if (lodFrom && Math.abs(lodFrom[0] - x) + Math.abs(lodFrom[1] - y) + Math.abs(lodFrom[2] - z) < 100) return;
  lodFrom = [x, y, z];
  const v = viewer();
  const saved = [v.posX, v.posY, v.posZ] as const;
  v.posX = x | 0;
  v.posY = y | 0;
  v.posZ = z | 0;
  const before = mechs.mechTable.slice(0, mechs.mechCount).map((m) => m!.detailLevel);
  try {
    mechLodUpdate();
    scroungeFollowViewer();
  } finally {
    [v.posX, v.posY, v.posZ] = saved;
  }
  if (before.some((d, i) => d !== mechs.mechTable[i]!.detailLevel)) engineStore.bump();
}

/** The topmost ancestor of a three.js object (the scene it is in). */
function rootOf3(o: THREE.Object3D): THREE.Object3D {
  let r = o;
  while (r.parent) r = r.parent;
  return r;
}

function rootOf(n: SceneNode): SceneNode {
  let r = n;
  while (r.parent) r = r.parent;
  return r;
}
