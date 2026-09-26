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
 * scales up with nearest filtering; Modern renders at native resolution.
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
import { cameraFromViewer, viewerFromCamera } from '../../render/bridge/cameraViewer.ts';
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
import { playerTargetPosition } from '../../render/xr/xrRig.ts';
import { aimDepth } from '../../render/xr/aim.ts';
import { HUD_LAYER } from '../../engine/vfx/vfx.ts';
import { projectionGlobals, viewerRefreshLodScale } from '../../sim/camera/projection.ts';

/** VR: the reticle's plane - out to this far with nothing under it, never nearer than the min, easing over RETICLE_EASE seconds (metres) */
const RETICLE_DISTANCE = 300;
const RETICLE_MIN_DISTANCE = 3;
const RETICLE_EASE = 0.12;
/** VR: the range the target marker's plane is held to (metres) */
const MARKER_MIN_DISTANCE = 5;
const MARKER_MAX_DISTANCE = 3000;

/** which camera Edit looks through */
type EditView = 'scene' | 'game';

export function Viewport({ game }: { game: Game }) {
  useRevision(engineStore);
  const host = useRef<HTMLDivElement>(null);
  const [faithful, setFaithful] = useState(true);
  const [editView, setEditView] = useState<EditView>('scene');
  const [info, setInfo] = useState('');
  const faithfulRef = useRef(faithful);
  const editViewRef = useRef(editView);
  const paletteDirty = useRef(false);
  const [xrSupported, setXrSupported] = useState(false);
  const [xrOn, setXrOn] = useState(false);
  /** enters VR, or leaves it while in it (set by the renderer's effect) */
  const toggleXr = useRef<(() => void) | null>(null);
  const [xrSettings, setXrSettings] = useState<XrSettings>(recallXrSettings);
  const xrSettingsRef = useRef(xrSettings);
  useEffect(() => {
    xrSettingsRef.current = xrSettings;
    storeXrSettings(xrSettings);
  }, [xrSettings]);
  useEffect(() => {
    faithfulRef.current = faithful;
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
    const drawSize = new THREE.Vector2();
    const skyGround = new SkyGround(sr.uniforms);
    sr.backdropScene.add(skyGround.mesh);
    const hudOverlay = new HudOverlay(sr.uniforms);
    renderer.autoClear = false;
    // VR: the rig the headset sits in, the sky about it, the controllers
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    const rig = new XrRig();
    const xrSky = new XrSky(sr.uniforms);
    sr.backdropScene.add(xrSky.mesh);
    const xrInput = new XrInput();
    const xrViewer = new Viewer();
    /** the cockpit scene carries the rig's matrix (reset on leaving VR) */
    let cockpitMoved = false;
    const onXrEnd = () => {
      xrInput.release();
      setXrOn(false);
    };
    toggleXr.current = () => {
      const current = renderer.xr.getSession();
      if (current) {
        void current.end();
        return;
      }
      navigator.xr
        ?.requestSession('immersive-vr', { optionalFeatures: ['local'] })
        .then(async (session) => {
          session.addEventListener('end', onXrEnd, { once: true });
          await renderer.xr.setSession(session);
          setXrOn(true);
        })
        .catch((err: unknown) => console.warn('VR session refused', err));
    };
    const fly = new FreeFly(sceneCam, el, sceneView);
    // start at the player's mech, else the mission's start view (VWST)
    const player = mechs.mechTable[mechs.playerMechIndex];
    const v = cameraGlobals.mainViewer;
    const start = player?.node ? [player.node.worldPos[0]!, player.node.worldPos[1]!, player.node.worldPos[2]!] : [v.posX, v.posY, v.posZ];
    const [sx, sy, sz] = toThree(start[0]!, start[1]!, start[2]!);
    sceneCam.position.set(sx - 15, sy + 12, sz + 25);
    fly.lookAt(new THREE.Vector3(sx, sy + 3, sz));

    // debug handle: window.mw2.view.camera (the scene camera) / .gameCamera / .fly (setting fly.yaw / fly.pitch aims it) / .renderer / .views
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
    if (dbg) dbg.view = { camera: sceneCam, gameCamera: gameCam, fly, renderer: sr, views };

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
      // the LOD distances: pushed out in a headset, the original's otherwise - set before the pass, whose mech_lod_update reads them
      const lodScale = xr ? xrSettingsRef.current.detail : 1;
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
      if (xr) {
        rig.settings = xrSettingsRef.current;
        rig.update(now);
        renderer.xr.updateCamera(rig.camera);
        head = renderer.xr.getCamera();
        // the game's viewer standing at the head: what a turned head sees is culled from there
        sr.sync(rig.cullViewer(head, viewer(), xrViewer));
        const vp = head.cameras[0]?.viewport;
        drawSize.set(vp?.z ?? 1, vp?.w ?? 1);
      } else {
        // the game's viewer as the cull, LOD and clipper see it: its own, or standing at the scene camera
        sr.sync(scene ? viewerFromCamera(sceneCam, cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer, editorViewer) : viewer());
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
      if (head) xrSky.update(new THREE.Vector3().setFromMatrixPosition(head.matrixWorld), tanH, skyState);
      else skyGround.update(camera, drawSize.x, drawSize.y, skyState);
      sr.setViewport(drawSize.x, drawSize.y);
      // the cockpit shell: in a headset, carried to the rig and enlarged about the eye (xrRig.ts)
      if (xr) {
        rig.cockpitMatrix(gameCam, sr.cockpitScene.matrix);
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
      // the game's 2D (HUD, radar, cockpit text) over it all, through the game's camera - in a headset on a plane ahead
      if (hudReady) {
        if (xr) {
          hudOverlay.reticleMesh.visible = false;
          hudOverlay.markerMesh.visible = false;
          hudOverlay.worldMesh.visible = true;
          hudOverlay.setWorldLayers(0b111 & ~lifted);
          rig.placeHud(hudOverlay.worldMesh, tanH, hudOverlay.aspect);
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
      rig.placeLifted(hudOverlay.reticleMesh, gameCam, 1 / reticleInvDepth, tanH, aspect);
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
    renderer.setAnimationLoop(frame);
    return () => {
      renderer.setAnimationLoop(null);
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
        <button className={!faithful ? 'active' : ''} onClick={() => setFaithful(false)} title="native resolution">
          Modern
        </button>
        {xrSupported && (
          <button
            className={xrOn ? 'active' : ''}
            disabled={!playing && !xrOn}
            onClick={() => toggleXr.current?.()}
            title={xrOn ? 'leave VR' : "VR: sit in the cockpit with a headset (Play). Left stick throttle and turn, right stick torso, triggers fire, A/B targets, X view, Y menu"}
          >
            VR
          </button>
        )}
        {xrSupported && (
          <>
            <XrSlider label="cockpit" title="the cockpit's size about your eye (1 = the mech's own scale)" value={xrSettings.cockpitScale} min={0.15} max={1.5} step={0.05} unit="x" onChange={(v) => setXrSettings((s) => ({ ...s, cockpitScale: v }))} />
            <XrSlider label="HUD" title="the HUD's width as a share of the game's view (the reticle and target brackets are drawn in the world, not on it)" value={xrSettings.hudScale} min={0.3} max={1} step={0.05} unit="%" onChange={(v) => setXrSettings((s) => ({ ...s, hudScale: v }))} />
            <XrSlider label="detail" title="how far out the detail steps are pushed in VR (1 = the original's)" value={xrSettings.detail} min={1} max={8} step={0.5} unit="x" onChange={(v) => setXrSettings((s) => ({ ...s, detail: v }))} />
            <XrSlider label="at" title="how far ahead of your eye the HUD stands" value={xrSettings.hudDistance} min={0.5} max={5} step={0.1} unit="m" onChange={(v) => setXrSettings((s) => ({ ...s, hudDistance: v }))} />
          </>
        )}
      </div>
    </div>
  );
}

/** One of the VR sizes: a slider and its value. */
function XrSlider(p: { label: string; title: string; value: number; min: number; max: number; step: number; unit: 'x' | '%' | 'm'; onChange: (v: number) => void }) {
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
