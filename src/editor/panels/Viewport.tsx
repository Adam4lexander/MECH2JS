/**
 * The 3D view. In Edit mode it looks through a free camera; click picks the
 * object under the cursor (selecting its scene node, or the object itself for
 * static scenery), and the gizmo moves the selected node through the
 * engine's own setter (scene_node_set_origin + scene_node_walk).
 *
 * Faithful mode renders at VGA resolution (640 x 480 aspect-fitted) and
 * scales up with nearest filtering; Modern renders at native resolution.
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
import { mainLoop } from '../../mission/mainLoop.ts';
import { cam } from '../../sim/camera/cameraUpdate.ts';
import { viewerBuildTransform, viewerUpdateProjection } from '../../sim/camera/projection.ts';
import { sceneNodeSetOrigin, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { cameraGlobals, viewer } from '../../sim/camera/viewer.ts';
import { mechLodUpdate } from '../../sim/world/detailRecords.ts';
import { scroungeFollowViewer } from '../../sim/world/scrounge.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { engineStore, editorStore } from '../store/store.ts';
import { select, selected } from '../store/selection.ts';
import { FreeFly } from '../viewport/freeFly.ts';
import { syncFieldsFromNode } from '../inspector/poseSync.ts';
import { SkyGround } from '../../render/passes/skyGround.ts';
import { defaultCanvas, display } from '../../sim/display/video.ts';
import { HudOverlay } from '../../render/passes/hudOverlay.ts';
import { vfxWindowClearPane } from '../../engine/vfx/vfx.ts';
import { renderOptions } from '../../render/shading/polygonColour.ts';
import { lighting } from '../../sim/world/environment.ts';
import { structOf } from './Inspector.tsx';

export function Viewport({ game }: { game: Game }) {
  const host = useRef<HTMLDivElement>(null);
  const [faithful, setFaithful] = useState(true);
  const [info, setInfo] = useState('');
  const faithfulRef = useRef(faithful);
  const paletteDirty = useRef(false);
  useEffect(() => {
    faithfulRef.current = faithful;
  }, [faithful]);

  useEffect(() => {
    const el = host.current!;
    lodFrom = null;
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(1);
    el.appendChild(renderer.domElement);
    const sr = new SceneRenderer();
    const pal = game.paletteRgb();
    if (pal) sr.setPalette(pal);
    const luma = game.lumaRows();
    if (luma) sr.setLuma(luma);
    game.bindTextures(sr);

    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.5, 20000);
    const editorViewer = new Viewer();
    const drawSize = new THREE.Vector2();
    const skyGround = new SkyGround(sr.uniforms);
    sr.backdropScene.add(skyGround.mesh);
    const hudOverlay = new HudOverlay(sr.uniforms);
    renderer.autoClear = false;
    const fly = new FreeFly(camera, el);
    // start at the player's mech, else the mission's start view (VWST)
    const player = mechs.mechTable[mechs.playerMechIndex];
    const v = cameraGlobals.mainViewer;
    const start = player?.node ? [player.node.worldPos[0]!, player.node.worldPos[1]!, player.node.worldPos[2]!] : [v.posX, v.posY, v.posZ];
    const [sx, sy, sz] = toThree(start[0]!, start[1]!, start[2]!);
    camera.position.set(sx - 15, sy + 12, sz + 25);
    fly.lookAt(new THREE.Vector3(sx, sy + 3, sz));

    // debug handle: window.mw2.view.camera / .fly (setting fly.yaw / fly.pitch aims it) / .renderer
    const dbg = (window as unknown as { mw2?: Record<string, unknown> }).mw2;
    if (dbg) dbg.view = { camera, fly, renderer: sr };

    const gizmo = new TransformControls(camera, renderer.domElement);
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

    // F: frame the selection, as in Unity
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyF' || !gizmoNode || (e.target as HTMLElement).tagName === 'INPUT') return;
      // aim a few metres up the node (a mech's node is at its feet) from 25 m out
      const t = proxy.position.clone().add(new THREE.Vector3(0, 4, 0));
      const back = new THREE.Vector3().subVectors(camera.position, t);
      if (back.lengthSq() < 1e-6) back.set(0, 0.5, 1);
      camera.position.copy(t).add(back.normalize().multiplyScalar(25));
      fly.lookAt(t);
    };
    window.addEventListener('keydown', onKey);

    const ray = new THREE.Raycaster();
    const onClick = (e: MouseEvent) => {
      if (dragEnded) {
        dragEnded = false;
        return;
      }
      if (e.button !== 0 || gizmo.dragging) return;
      const r = renderer.domElement.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(p, camera);
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
    // DAT_00097074, the frame's render call inside main's loop: its sim half
    // (vfx_video_sub_010490's projection refresh and viewer_build_transform);
    // the drawing itself happens once the loop pass returns
    // It also paints the 3D viewport over whatever 2D was in the window there
    // (vfxWindowClearPane), which the HUD then draws over again.
    mainLoop.renderHook = () => {
      vfxWindowClearPane(display.currentViewport);
      const v = viewer();
      if (cam.dat000954ec !== 0) {
        viewerUpdateProjection(v);
        cam.dat000954ec = 0;
      }
      if (cam.dat00097020 === 0) viewerBuildTransform(v);
    };

    let raf = 0;
    let last = performance.now();
    let lastInfo = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      const elapsedMs = now - last;
      last = now;
      const playing = game.mode === 'play';
      if (playing) {
        if (!game.playFrame(elapsedMs)) game.setMode('edit');
        engineStore.bumpThrottled();
      } else {
        fly.update(dt);
        editorViewUpdate(camera);
      }
      if (paletteDirty.current) {
        paletteDirty.current = false;
        const p = game.paletteRgb();
        if (p) sr.setPalette(p);
      }
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (faithfulRef.current) {
        const scale = Math.min(w / 640, h / 480);
        renderer.setSize(Math.floor(640), Math.floor(480), false);
        renderer.domElement.style.width = `${Math.floor(640 * scale)}px`;
        renderer.domElement.style.height = `${Math.floor(480 * scale)}px`;
        renderer.domElement.style.imageRendering = 'pixelated';
        camera.aspect = 640 / 480;
      } else {
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = `${w}px`;
        renderer.domElement.style.height = `${h}px`;
        renderer.domElement.style.imageRendering = 'auto';
        camera.aspect = w / h;
      }
      camera.updateProjectionMatrix();
      if (playing) cameraFromViewer(viewer(), camera, camera.aspect);
      const eye = fromThree(camera.position.x, camera.position.y, camera.position.z);
      game.updateTextures(sr);
      // the game's viewer, standing at the editor camera: the cull, LOD and clipper see what three.js draws
      // Edit: the game's viewer, standing at the editor camera, so the cull, LOD
      // and clipper see what three.js draws. Play: the game's own viewer.
      sr.sync(playing ? viewer() : viewerFromCamera(camera, cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer, editorViewer));
      renderer.getDrawingBufferSize(drawSize);
      skyGround.update(camera, drawSize.x, drawSize.y, {
        sky: lighting.skyColour,
        ground: lighting.groundColour,
        skyOn: lighting.skyEnabled !== 0,
        groundOn: lighting.groundEnabled !== 0,
        bandHeight: lighting.horizonBandHeight,
        screenWidth: Math.max(1, defaultCanvas.xMax + 1),
        bandOn: lighting.horizonBandEnabled !== 0 && renderOptions.shadedFillEnabled !== 0,
      });
      sr.setViewport(drawSize.x, drawSize.y);
      // the sky and the backdrop, then the world over them
      renderer.clear();
      renderer.render(sr.backdropScene, camera);
      renderer.clearDepth();
      renderer.render(sr.scene, camera);
      // the cockpit shell, painted over the world (empty outside the cockpit view). Its near clip
      // is 8 cm, inside three's 50 cm near plane, so the pass runs with the plane pulled in
      renderer.clearDepth();
      const near = camera.near;
      camera.near = 0.04;
      camera.updateProjectionMatrix();
      renderer.render(sr.cockpitScene, camera);
      camera.near = near;
      camera.updateProjectionMatrix();
      // the game's 2D (HUD, radar, cockpit text) over it all, in Play
      if (playing && hudOverlay.update(defaultCanvas, drawSize.x, drawSize.y)) renderer.render(hudOverlay.scene, hudOverlay.camera);
      if (now - lastInfo > 250) {
        lastInfo = now;
        setInfo(`${sr.stats.objects} objects · ${sr.stats.polygons} polygons · eye ${eye.map((c) => (c * CM_TO_UNITS).toFixed(0)).join(', ')} m`);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      unsubSel();
      unsubEngine();
      window.removeEventListener('keydown', onKey);
      renderer.domElement.removeEventListener('click', onClick);
      detachInput();
      mainLoop.renderHook = null;
      hudOverlay.dispose();
      gizmo.dispose();
      fly.dispose();
      sr.clear();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [game, game.mission]);

  return (
    <div className="viewport" ref={host}>
      <div className="viewport-overlay">
        {game.mode === 'edit' ? 'EDIT' : 'PLAY'} · {info}
        <div className="hint">
          {game.mode === 'edit'
            ? 'right-drag look · WASD/QE fly · wheel speed · click select · F frame'
            : 'the game has the keyboard (INPUT.MAP / GAMEKEY.MAP) · click to capture the mouse · Edit to leave'}
        </div>
      </div>
      <div className="viewport-bar">
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
      </div>
    </div>
  );
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
 * functions with the viewer standing, for the call, where the editor camera is.
 *
 * @portOnly
 */
let lodFrom: [number, number, number] | null = null;
function editorViewUpdate(camera: THREE.Camera): void {
  const [x, y, z] = fromThree(camera.position.x, camera.position.y, camera.position.z);
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
