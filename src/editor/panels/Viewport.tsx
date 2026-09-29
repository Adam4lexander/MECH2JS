/**
 * The editor's 3D view: the game's screen (app/gameScreen.ts) through one of
 * two cameras:
 *
 *   game   the game's own viewer (camera_update's): the world as the player
 *          sees it, the cockpit shell and the game's 2D (HUD, radar) over it.
 *          Play always looks through it; nothing in the view is the editor's.
 *   scene  the editor's free camera: fly anywhere, click to pick (the
 *          object's scene node, or the object itself for static scenery), and
 *          the gizmo moves the selected node through the engine's own setter
 *          (scene_node_set_origin + scene_node_walk). Edit mode only; no HUD
 *          or cockpit shell, which belong to the game's camera.
 *
 * In Edit the bar picks which one to look through (the game camera shows the
 * paused frame). The scene camera keeps its own place across Play.
 *
 * The bar also sets how the screen draws: a fixed day phase for the palette,
 * Faithful (VGA resolution, nearest upscale, the original's distances) or
 * Modern (native resolution, drawn further out), the enhancements, Fill (the
 * view alone over the browser window, for recording) and VR where the
 * browser has a headset - the game's camera with the pilot's head inside it,
 * never the scene camera. All of it is remembered, Modern with the
 * enhancements and the hand-built cockpits at first, and the game
 * (GameView) draws with the same choices.
 *
 * @portOnly
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SceneNode } from '../../generated/classes.gen.ts';
import { SceneNode as SceneNodeClass, Viewer } from '../../generated/classes.gen.ts';
import type { Game } from '../../app/Game.ts';
import { GameScreen, mechOwning, type ScreenSettings } from '../../app/gameScreen.ts';
import { fromThree, toThree, CM_TO_UNITS } from '../../render/bridge/space.ts';
import { viewerFromCamera } from '../../render/bridge/cameraViewer.ts';
import { sceneNodeSetOrigin, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { cameraGlobals, viewer } from '../../sim/camera/viewer.ts';
import { mechLodUpdate } from '../../sim/world/detailRecords.ts';
import { scroungeFollowViewer } from '../../sim/world/scrounge.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { engineStore, editorStore, useRevision } from '../store/store.ts';
import { select, selected } from '../store/selection.ts';
import { FreeFly } from '../viewport/freeFly.ts';
import { syncFieldsFromNode } from '../inspector/poseSync.ts';
import { structOf } from './Inspector.tsx';
import { recallXrSettings, storeXrSettings, type XrSettings } from '../../render/xr/xrSettings.ts';
import { recallFaithful, recallViewSettings, storeFaithful, storeViewSettings, type ViewSettings } from '../../render/viewSettings.ts';
import { recallSpectatorSettings, spectatorUnlocked, storeSpectatorSettings, type SpectatorMode, type SpectatorSettings } from '../../render/xr/spectator.ts';
import { DESIGNS } from '../../render/cockpit/designs/index.ts';
import { ENHANCE_LABELS, recallEnhanceSettings, storeEnhanceSettings, type EnhanceSettings } from '../../render/enhance/enhanceSettings.ts';

/** which camera Edit looks through */
type EditView = 'scene' | 'game';

export function Viewport({ game }: { game: Game }) {
  useRevision(engineStore);
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<GameScreen | null>(null);
  const [faithful, setFaithful] = useState(recallFaithful);
  const [editView, setEditView] = useState<EditView>('scene');
  const [info, setInfo] = useState('');
  const editViewRef = useRef(editView);
  const [xrSupported, setXrSupported] = useState(false);
  const [xrOn, setXrOn] = useState(false);
  /** the view alone over the whole browser window, for recording (the bar's Fill) */
  const [filled, setFilled] = useState(false);
  /** VR asked for and the headset not yet given it (the browser and the XR runtime can take a minute) */
  const [xrPending, setXrPending] = useState(false);
  const [xrSettings, setXrSettings] = useState<XrSettings>(recallXrSettings);
  const [viewSettings, setViewSettings] = useState<ViewSettings>(recallViewSettings);
  const [spectatorSettings, setSpectatorSettings] = useState<SpectatorSettings>(recallSpectatorSettings);
  const [enhance, setEnhance] = useState<EnhanceSettings>(recallEnhanceSettings);
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  /** how the screen draws, read by it every frame */
  const settingsRef = useRef<ScreenSettings>({ faithful, view: viewSettings, enhance, xr: xrSettings, spectator: spectatorSettings });
  useEffect(() => {
    settingsRef.current = { faithful, view: viewSettings, enhance, xr: xrSettings, spectator: spectatorSettings };
  }, [faithful, viewSettings, enhance, xrSettings, spectatorSettings]);
  useEffect(() => storeFaithful(faithful), [faithful]);
  useEffect(() => storeEnhanceSettings(enhance), [enhance]);
  useEffect(() => storeXrSettings(xrSettings), [xrSettings]);
  useEffect(() => storeViewSettings(viewSettings), [viewSettings]);
  useEffect(() => storeSpectatorSettings(spectatorSettings), [spectatorSettings]);
  // Esc leaves the filled view - unless the game is playing, when Esc is the game's (its main menu)
  useEffect(() => {
    if (!filled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && game.mode !== 'play') setFilled(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filled, game]);
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
    /** the editor's view: flown with FreeFly, picked through, the gizmo's */
    const sceneCam = new THREE.PerspectiveCamera(60, 4 / 3, 0.5, 20000);
    /** true while the editor's scene camera is the one shown (Edit, scene view) */
    const sceneView = () => game.mode === 'edit' && editViewRef.current === 'scene';
    const editorViewer = new Viewer();
    /**
     * The hand-built cockpit through the scene camera too, where it stands: at the game's eye. In the
     * cockpit view the player's mech is built at its cockpit level, so round it there is only the head's
     * arms and guns - the cockpit is a box standing in the air above the legs, which is what it is.
     */
    let cockpitOutside = true;
    /** debug: the scene camera sees the cockpit through the mech round it (drawn after a depth clear) */
    let cockpitXray = false;
    const fly = new FreeFly(sceneCam, el, sceneView);
    // start at the player's mech, else the mission's start view (VWST)
    const player = mechs.mechTable[mechs.playerMechIndex];
    const v = cameraGlobals.mainViewer;
    const start = player?.node ? [player.node.worldPos[0]!, player.node.worldPos[1]!, player.node.worldPos[2]!] : [v.posX, v.posY, v.posZ];
    const [sx, sy, sz] = toThree(start[0]!, start[1]!, start[2]!);
    sceneCam.position.set(sx - 15, sy + 12, sz + 25);
    fly.lookAt(new THREE.Vector3(sx, sy + 3, sz));

    let gizmoNode: SceneNode | null = null;
    let lastInfo = 0;
    const gs = new GameScreen(el, game, {
      settings: () => settingsRef.current,
      vr: true,
      onVrState: (s) => {
        setXrOn(s.on);
        setXrPending(s.pending);
      },
      lookThrough: (dt, presenting) => {
        // a headset always looks through the game's camera
        const scene = sceneView() && !presenting;
        // the gizmo is the scene camera's alone
        gizmo.enabled = scene;
        gizmoHelper.visible = scene && gizmoNode !== null;
        if (scene) {
          fly.update(dt);
          viewUpdateFrom(sceneCam.position);
          return {
            camera: sceneCam,
            // the game's viewer, standing at the scene camera
            viewer: () => viewerFromCamera(sceneCam, cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer, editorViewer),
            cockpit: !cockpitOutside ? 'hidden' : cockpitXray ? 'xray' : 'shown',
          };
        }
        if (game.mode !== 'play') {
          // the paused game view: the detail the game's own viewer would choose
          const gv = viewer();
          viewUpdateFrom(new THREE.Vector3(...toThree(gv.posX, gv.posY, gv.posZ)));
        } else lodFrom = null;
        return null;
      },
      afterFrame: (now, camera) => {
        if (game.mode === 'play') engineStore.bumpThrottled();
        if (now - lastInfo > 250) {
          lastInfo = now;
          const eye = fromThree(camera.position.x, camera.position.y, camera.position.z);
          setInfo(`${gs.sr.stats.objects} objects · ${gs.sr.stats.polygons} polygons · eye ${eye.map((c) => (c * CM_TO_UNITS).toFixed(0)).join(', ')} m`);
        }
      },
    });
    screen.current = gs;
    const canvas = gs.webgl.domElement;

    // debug handle: window.mw2.view.camera (the scene camera) / .gameCamera / .fly (setting fly.yaw / fly.pitch aims it) / .renderer / .views / .cockpit / .hudOverlay; window.mw2.vrMirror
    const dbg = (window as unknown as { mw2?: Record<string, unknown> }).mw2;
    const cockpitDebug = {
      keys: Object.keys(DESIGNS),
      /** draws `key`'s cockpit whatever the player's chassis (null: the player's own) */
      preview(key: string | null) {
        gs.cockpitPreview = key;
      },
      get current() {
        return gs.cockpitShown;
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
    if (dbg) {
      dbg.view = { camera: sceneCam, gameCamera: gs.gameCamera, fly, renderer: gs.sr, views: gs.views, cockpit: cockpitDebug, hudOverlay: gs.hudOverlay };
      dbg.vrMirror = gs.mirror;
    }

    const gizmo = new TransformControls(sceneCam, canvas);
    gizmo.setSpace('world');
    const gizmoHelper = gizmo.getHelper();
    gs.sr.scene.add(gizmoHelper);
    const proxy = new THREE.Object3D();
    gs.sr.scene.add(proxy);
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
      const r = canvas.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(p, sceneCam);
      const hits = ray.intersectObjects(gs.sr.pickables(), false);
      const obj = hits.length ? gs.sr.objectOf(hits[0]!.object) : null;
      if (!obj) return;
      // Unity-style: a click selects the gamepiece the part belongs to; Alt+click the part itself
      const owner = !e.altKey && obj.node ? mechOwning(obj.node) : -1;
      if (owner >= 0) {
        const m = mechs.mechTable[owner]!;
        select({ label: `Gamepieces[${owner}] ${m.name}`, struct: 'MechEntity', target: m });
      } else if (obj.node) select({ label: `node of object (type 0x${obj.type.toString(16)})`, struct: 'SceneNode', target: obj.node });
      else select({ label: `object (type 0x${obj.type.toString(16)})`, struct: structOf(obj), target: obj });
    };
    canvas.addEventListener('click', onClick);

    return () => {
      unsubSel();
      unsubEngine();
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('click', onClick);
      gizmo.dispose();
      fly.dispose();
      if (screen.current === gs) screen.current = null;
      gs.dispose();
    };
  }, [game, game.mission]);

  const playing = game.mode === 'play';
  const view: EditView = playing ? 'game' : editView;
  return (
    <div className={`viewport${playing ? ' playing' : ''}${filled ? ' filled' : ''}`} ref={host}>
      {filled && (
        <button className="unfill" onClick={() => setFilled(false)} title="back to the editor">
          ×
        </button>
      )}
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
            screen.current?.invalidatePalette();
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
        <button onClick={() => setFilled(true)} title="the view alone over the whole browser window, without this bar - for recording. Esc, or the corner button, leaves">
          Fill
        </button>
        {xrSupported && (
          <button
            className={xrOn ? 'active' : xrPending ? 'pending' : ''}
            disabled={xrPending || (!playing && !xrOn)}
            onClick={() => screen.current?.toggleVr()}
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
            {/* the drawn page cameras are the address's (?spectator): each draws the frame a third time */}
            {spectatorUnlocked() && (
              <select
                title="what the page shows while you play in the headset, for recording: the left eye as you see it, your view with the head's shake eased out, or a camera behind the mech"
                value={spectatorSettings.mode}
                onChange={(e) => setSpectatorSettings((s) => ({ ...s, mode: e.target.value as SpectatorMode }))}
              >
                <option value="mirror">page: eye</option>
                <option value="smooth">page: smooth</option>
                <option value="chase">page: chase</option>
              </select>
            )}
            {spectatorSettings.mode !== 'mirror' && (
              <>
                <Slider label="fov" title="the page camera's horizontal field of view" value={spectatorSettings.fov} min={50} max={120} step={5} unit="deg" onChange={(v) => setSpectatorSettings((s) => ({ ...s, fov: v }))} />
                <Slider label="ease" title="how slowly the page camera turns after your head (or the mech, chasing it): seconds" value={spectatorSettings.smooth} min={0} max={1.5} step={0.05} unit="s" onChange={(v) => setSpectatorSettings((s) => ({ ...s, smooth: v }))} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One of the view's or the VR sizes: a slider and its value. */
function Slider(p: { label: string; title: string; value: number; min: number; max: number; step: number; unit: 'x' | '%' | 'm' | 'deg' | 's'; onChange: (v: number) => void }) {
  const shown =
    p.unit === '%'
      ? `${Math.round(p.value * 100)}%`
      : p.unit === 'x'
        ? `${p.value.toFixed(2)}x`
        : p.unit === 'deg'
          ? `${Math.round(p.value)}°`
          : p.unit === 's'
            ? `${p.value.toFixed(2)} s`
            : `${p.value.toFixed(1)} m`;
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

function rootOf(n: SceneNode): SceneNode {
  let r = n;
  while (r.parent) r = r.parent;
  return r;
}
