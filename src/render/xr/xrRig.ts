/**
 * The pilot's seat in VR: where the headset's eyes stand while the game's
 * viewer moves the cockpit.
 *
 * The rig is an Object3D posed as the game's viewer (cameraFromViewer, the
 * same pose the flat view looks through), and the XR camera is its child:
 * three's WebXRManager composes the head's pose, in the 'local' reference
 * space (seated, the origin where the head started), onto the camera's
 * parent. So the head moves inside a cockpit the game moves.
 *
 * The game moves its viewer once per pass of main's loop - 20 a second at
 * the default loop rate - while a headset draws 72 to 120 frames a second.
 * A cockpit stepping at 20 Hz around a smoothly tracked head is the quickest
 * way to make a pilot ill, so the rig is drawn one pass behind, between the
 * last two passes' poses (position lerped, orientation slerped). A jump no
 * interpolation should cross (the external view, a new mission) snaps.
 *
 * Three things the flat view can leave to the screen need the rig in
 * stereo:
 *
 *  - The cull. object_cull_main_view has no side test - only the far sphere
 *    and depth along the view's forward row against the near clip - so what
 *    it rejects is what lies behind the viewer. Behind the game's viewer is
 *    where a turned head looks, so cullViewer is the game's viewer standing
 *    at the head instead (as the editor's scene camera does,
 *    viewerFromCamera); the sides are the GPU's frustum clip, per eye. Its
 *    far distance is the mission's times settings.viewDistance: at the
 *    original's, buildings and hills popped in and out in plain view.
 *
 *  - The cockpit shell. It is painted over the world after a depth clear,
 *    so on a screen its size never mattered, and it is modelled at the
 *    mech's own scale: metres to ten metres from the eye (xrSettings.ts has
 *    the measurement). In stereo that is a canopy the size of a room.
 *    cockpitMatrix scales it about the eye by settings.cockpitScale: every
 *    point stays on its ray from the eye, so the flat picture is unchanged
 *    and only its depth changes. It also carries the shell from the pass's
 *    eye to the interpolated rig, so it stays rigid around the head.
 *    (Correction: the first cut took the shell to be centimetres from the
 *    eye and enlarged it 8x.)
 *
 *  - The HUD. See passes/hudOverlay.ts: a plane settings.hudDistance ahead
 *    in the rig, settings.hudScale of the game's field of view wide. The
 *    layers that mark the world (the reticle, the target marker) are not on
 *    it: placeLifted puts each on a plane of its own across the game's whole
 *    field of view, far out, posed at the pass's eye - not the interpolated
 *    rig - because the game drew them from that eye onto a world standing
 *    where that pass left it. So they lie on what they mark.
 *
 * @portOnly
 */
import * as THREE from 'three';
import type { Viewer } from '../../generated/classes.gen.ts';
import { viewerFromCamera } from '../bridge/cameraViewer.ts';
import { objectGetPosRadius } from '../../engine/scene/worldObject.ts';
import { playerTargetNode } from '../../sim/ai/targeting.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { recallXrSettings, type XrSettings } from './xrSettings.ts';

interface Pose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  t: number;
}

/** a jump between passes larger than this (metres, radians) is not interpolated */
const SNAP_DISTANCE = 30;
const SNAP_ANGLE = 1;

export class XrRig {
  readonly rig = new THREE.Object3D();
  /** the camera the renderer's XR camera follows; its near and far set the session's depth range */
  readonly camera = new THREE.PerspectiveCamera(90, 1, 0.1, 20000);
  /** the HUD's planes: the rig with the HUD plane (passes/hudOverlay.ts worldMesh), and passEye with the lifted layers */
  readonly hudScene = new THREE.Scene();
  /** posed at the last pass's eye, for the planes that must register with the world */
  readonly passEye = new THREE.Object3D();
  /** the cockpit's and HUD's sizes (read every frame, so a change shows at once) */
  settings: XrSettings = recallXrSettings();

  private prev: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), t: 0 };
  private cur: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), t: 0 };
  private started = false;
  private readonly cull = new THREE.PerspectiveCamera(90, 4 / 3, 0.1, 20000);
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();

  constructor() {
    this.rig.add(this.camera);
    this.hudScene.add(this.rig);
    this.hudScene.add(this.passEye);
    this.hudScene.matrixAutoUpdate = false;
  }

  /** A pass of the loop has run: `eye` (the game camera, posed from the viewer) is its pose. */
  recordPass(eye: THREE.Camera, now: number): void {
    const [a, b] = [this.cur, this.prev];
    this.prev = a;
    this.cur = b;
    this.cur.pos.copy(eye.position);
    this.cur.quat.copy(eye.quaternion);
    this.cur.t = now;
    const jump = !this.started || this.cur.pos.distanceTo(this.prev.pos) > SNAP_DISTANCE || this.cur.quat.angleTo(this.prev.quat) > SNAP_ANGLE;
    if (jump) {
      this.prev.pos.copy(this.cur.pos);
      this.prev.quat.copy(this.cur.quat);
      this.prev.t = now;
      this.started = true;
    }
  }

  /** No loop running (Edit, the paused game): the rig stands at `eye`. */
  hold(eye: THREE.Camera, now: number): void {
    this.started = false;
    this.recordPass(eye, now);
  }

  /** Poses the rig for a display frame at `now`: between the last two passes, one pass behind. */
  update(now: number): void {
    const span = this.cur.t - this.prev.t;
    const a = span > 0 ? Math.min(1, Math.max(0, (now - this.cur.t) / span)) : 1;
    this.rig.position.lerpVectors(this.prev.pos, this.cur.pos, a);
    this.rig.quaternion.slerpQuaternions(this.prev.quat, this.cur.quat, a);
    this.rig.scale.set(1, 1, 1);
    this.rig.updateMatrixWorld(true);
  }

  /**
   * Sizes the HUD plane: `tanH` the tangent of half the game's horizontal
   * field of view, `aspect` the window's height / width.
   */
  placeHud(hud: THREE.Object3D, tanH: number, aspect: number, hudScale = this.settings.hudScale): void {
    place(this.rig, hud, this.settings.hudDistance, tanH * hudScale, aspect);
  }

  /**
   * A lifted HUD layer: its plane `distance` metres out from the pass's eye
   * (`eye`, the game camera), as wide as the game's field of view there.
   */
  placeLifted(mesh: THREE.Object3D, eye: THREE.Camera, distance: number, tanH: number, aspect: number): void {
    this.passEye.position.copy(eye.position);
    this.passEye.quaternion.copy(eye.quaternion);
    this.passEye.updateMatrixWorld(true);
    place(this.passEye, mesh, distance, tanH, aspect);
  }

  /**
   * The cockpit scene's matrix: from the pass's eye (`eye`, the game camera)
   * to the rig, scaled settings.cockpitScale times about the eye (`k` in
   * its place: 1 when a hand-built cockpit stands in for the shell and only
   * the head's arms remain, at their own scale).
   */
  cockpitMatrix(eye: THREE.Camera, out: THREE.Matrix4, k = this.settings.cockpitScale): THREE.Matrix4 {
    eye.updateMatrixWorld();
    return out.copy(this.rig.matrixWorld).multiply(this.m.makeScale(k, k, k)).multiply(this.m.copy(eye.matrixWorld).invert());
  }

  /**
   * The game's viewer standing at the head (`head`, the renderer's XR
   * camera, its matrixWorld in world space), for the cull, LOD and clipper.
   */
  cullViewer(head: THREE.Camera, src: Viewer, out: Viewer): Viewer {
    head.matrixWorld.decompose(this.cull.position, this.cull.quaternion, this.s);
    this.cull.scale.set(1, 1, 1);
    viewerFromCamera(this.cull, src, out);
    // the far distance pushed out (settings.viewDistance): the cull's far sphere (+0xb4) and the clipper's far
    // limit, which it latches times 4 - so kept under 2^29 cm
    const k = this.settings.viewDistance;
    if (k !== 1) {
      const far = (cm: number) => Math.min(0x1fffffff, Math.max(0, Math.round(cm * k))) | 0;
      out.farClip = far(src.farClip);
      out.field_0xb4 = far(src.field_0xb4);
    }
    return out;
  }
}

/** A unit plane facing its parent's -z, `d` ahead, `2 d tanH` wide. */
function place(parent: THREE.Object3D, mesh: THREE.Object3D, d: number, tanH: number, aspect: number): void {
  if (mesh.parent !== parent) parent.add(mesh);
  const w = 2 * d * tanH;
  mesh.position.set(0, 0, -d);
  mesh.quaternion.identity();
  mesh.scale.set(w, w * aspect, 1);
  mesh.updateMatrixWorld(true);
}

/**
 * Where the player's target is, in world cm - what hud_target_marker_draw
 * marks: the tracked point (0x100), the mech (0x200) or the gamething's
 * object (0x400); null with no target (or the 0x1000 bit).
 */
export function playerTargetPosition(): [number, number, number] | null {
  const e = mechs.mechTable[mechs.playerMechIndex];
  if (!e) return null;
  const h = e.targetHandle >>> 0;
  if (h === 0 || (h & 0x1000) !== 0) return null;
  const type = h & 0xf00;
  if (type === 0x100) return [e.targetX, e.targetY, e.targetZ];
  if (type === 0x200) {
    const m = mechs.mechTable[h & 0xff];
    return m ? [m.posX, m.posY, m.posZ] : null;
  }
  if (type === 0x400) {
    const n = playerTargetNode();
    if (!n?.userData) return null;
    const o = objectGetPosRadius(n.userData);
    return [o.x, o.y, o.z];
  }
  return null;
}
