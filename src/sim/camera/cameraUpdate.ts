/**
 * The camera, once a frame from main's loop (camera_update): zoom, the mode
 * (cameraMode: 0 and 6 cockpit, 1 orbit, 2 free fly - the default, 3 missile,
 * 4 ejection), that mode's handler, then the scrounge patch and the
 * billboards follow the new viewer.
 *
 * The camera keys are a queue of up to ten offset keyframes played on top of
 * the cockpit view; view_shake_impulse is their one producer (impacts,
 * landings, wall hits).
 */
import { fixedAtan2, fixedCos, fixedSin } from '../../core/angle/trig.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { cmod } from '../../core/int/cint.ts';
import { rampAngleSetTarget, rampAngleStart, rampAngleStep, rampStart, rampStep } from '../../core/ramp.ts';
import { transformPoint } from '../../core/math/matrix.ts';
import { vecToRangeBearing } from '../../core/math/vec.ts';
import { vec3Normalise } from '../../engine/collision/ray.ts';
import { Ramp, RampAngle, type MechEntity } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { objectsOnList, worldRootNode } from '../../engine/scene/objectLists.ts';
import { sceneNodeGetWorldEuler, sceneNodeGetWorldPos, sceneNodeSetEuler, sceneNodeTransform, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { soundCuePlay, soundPlay } from '../sound/sound.ts';
import { scroungeFollowViewer } from '../world/scrounge.ts';
import { worldFindHighestHit } from '../world/collision.ts';
import { missileCamPose } from '../weapons/projectiles.ts';
import { cameraGlobals } from './viewer.ts';

/** CameraKey - 0x1c bytes: an offset pose and how long to ease to it. */
export class CameraKey {
  offsetX = 0;
  offsetY = 0;
  offsetZ = 0;
  /** +0x0c */
  offsetYaw = 0;
  /** +0x10 */
  offsetPitch = 0;
  /** +0x14 */
  offsetRoll = 0;
  /** +0x18: ticks */
  ticks = 0;
}

const ramp = () => new Ramp();

export const cam = registerGlobals(
  'cameraState',
  {
    /** 0x96ec0.. the orbit camera's distance and bounds, cm */
    camOrbitDistance: 0,
    camOrbitDistanceMin: 0,
    camOrbitDistanceMax: 0,
    camOrbitHeight: 0,
    /** 0x96ed0: the orbit's angle around the subject */
    camOrbitAngle: 0,
    /** 0x14fb98, 0x14fb50 */
    camOrbitHeightMin: 0,
    camOrbitHeightMax: 0,
    /** 0x96ed4, 0x96ed8: the cockpit's zoom and every other view's (16.16) */
    cameraZoomPlayer: 0x10000,
    cameraZoomAlt: 0x10000,
    /** 0x96edc: the mode camera_update ran last frame (-1 forces a re-entry) */
    cameraModePrev: -1,
    /** 0x96ee0 */
    cameraModeBeforeMissile: 0,
    /** 0x96ee4: the mode camera_init starts in */
    dat00096ee4: 0,
    /** 0x96ef0: 1 while the pilot's own view is up (camera_pilot_view_pose sets it, camera_update and camera_cockpit_view clear it); player_cockpit_frame passes it to hud_overlay_draw, which draws the reticle only while it is set */
    dat00096ef0: 0,
    /** 0x96f18: no glance key was held last frame */
    dat00096f18: 0,
    /** 0x97020: cleared by camera_update each frame; what reads it is not established */
    dat00097020: 0,
    /** 0x954ec: raised by camera_apply_zoom on a change and by viewport_select; layout_rescale_all clears it; what reads it is not established */
    dat000954ec: 0,
    /** 0x96efc: the mech the camera follows */
    cameraSubject: null as MechEntity | null,
    /** 0x96f00 */
    cameraTrackIndex: 0,
    /** 0x96f0c, 0x96f10, 0x96f14: the ejection camera's climb */
    ejectCamVelocity: 0,
    ejectCamAccel: 15520,
    ejectCamStartTick: 0,
    /** 0x14fb10, 0x14fb00, 0x14faf0: the orbit camera's position offsets */
    camOrbitOffsetX: ramp(),
    camOrbitOffsetY: ramp(),
    camOrbitOffsetZ: ramp(),
    /** 0x14fb30 */
    camFlyForward: ramp(),
    /** the pilot's look-around */
    camPilotPan: ramp(),
    camPilotTilt: ramp(),
    /** 0x14fb68, 0x14fb54 */
    camOrbitYaw: new RampAngle(),
    camOrbitPitch: new RampAngle(),
    /** 0x14fb7c..0x14fb94: the view saved while the missile camera runs */
    savedViewPose: new Int32Array(6),
    dat0014fb94: 0,
    /** the camera keys: ten keyframes, the count, the active one and its elapsed ticks */
    cameraKeys: Array.from({ length: 10 }, () => new CameraKey()),
    cameraKeyCount: 0,
    cameraKeyIndex: 0,
    cameraKeyElapsed: 0,
    cameraKeysActive: 0,
    camKeyRampX: ramp(),
    camKeyRampY: ramp(),
    camKeyRampZ: ramp(),
    camKeyRampPitch: ramp(),
    camKeyRampYaw: ramp(),
    camKeyRampRoll: ramp(),
  },
  () => {
    const c = cam;
    c.camOrbitDistance = imageI32(LABEL.camOrbitDistance, 0);
    c.camOrbitDistanceMin = imageI32(LABEL.camOrbitDistanceMin, 0);
    c.camOrbitDistanceMax = imageI32(LABEL.camOrbitDistanceMax, 0);
    c.camOrbitHeight = imageI32(LABEL.camOrbitHeight, 0);
    c.camOrbitAngle = imageI32(LABEL.camOrbitAngle, 0);
    c.camOrbitHeightMin = imageI32(LABEL.camOrbitHeightMin, 0);
    c.camOrbitHeightMax = imageI32(0x14fb50, 0);
    c.cameraZoomPlayer = imageI32(LABEL.cameraZoomPlayer, 0x10000);
    c.cameraZoomAlt = imageI32(LABEL.cameraZoomAlt, 0x10000);
    c.cameraModePrev = imageI32(LABEL.cameraModePrev, -1);
    c.cameraModeBeforeMissile = imageI32(LABEL.cameraModeBeforeMissile, 0);
    c.dat00096ee4 = imageI32(0x96ee4, 0);
    c.dat00096ef0 = imageI32(0x96ef0, 0);
    c.dat00096f18 = imageI32(0x96f18, 0);
    c.dat00097020 = imageI32(0x97020, 0);
    c.dat000954ec = imageI32(0x954ec, 0);
    c.cameraSubject = null;
    c.cameraTrackIndex = imageI32(LABEL.cameraTrackIndex, 0);
    c.ejectCamVelocity = imageI32(LABEL.ejectCamVelocity, 0);
    c.ejectCamAccel = imageI32(LABEL.ejectCamAccel, 15520);
    c.ejectCamStartTick = imageI32(LABEL.ejectCamStartTick, 0);
    for (const k of ['camOrbitOffsetX', 'camOrbitOffsetY', 'camOrbitOffsetZ', 'camFlyForward', 'camPilotPan', 'camPilotTilt', 'camKeyRampX', 'camKeyRampY', 'camKeyRampZ', 'camKeyRampPitch', 'camKeyRampYaw', 'camKeyRampRoll'] as const) c[k] = ramp();
    c.camOrbitYaw = new RampAngle();
    c.camOrbitPitch = new RampAngle();
    c.savedViewPose = new Int32Array(6);
    c.dat0014fb94 = 0;
    c.cameraKeys = Array.from({ length: 10 }, () => new CameraKey());
    c.cameraKeyCount = imageI32(LABEL.cameraKeyCount, 0);
    c.cameraKeyIndex = imageI32(LABEL.cameraKeyIndex, 0);
    c.cameraKeyElapsed = imageI32(LABEL.cameraKeyElapsed, 0);
    c.cameraKeysActive = imageI32(LABEL.cameraKeysActive, 0);
  },
);

const vp = () => cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;

/** (distance * sin >> 16, rounded) >> 13: a 2.29 sine applied to cm */
const scale13 = (d: number, s: number) => mulr16(d, s) >> 13;

/**
 * @mw2 camera_keys_init 0x0003fbc0
 * @fidelity exact
 */
export function cameraKeysInit(): void {
  cameraKeysClear();
}

/**
 * @mw2 camera_keys_clear 0x0003ff00
 * @fidelity exact
 */
export function cameraKeysClear(): void {
  const c = cam;
  for (const k of c.cameraKeys) Object.assign(k, new CameraKey());
  c.cameraKeyCount = 0;
  c.cameraKeyIndex = 0;
  c.cameraKeyElapsed = 0;
  c.cameraKeysActive = 0;
}

/**
 * @mw2 camera_keys_active 0x0003ffb0
 * @fidelity exact
 */
export function cameraKeysActive(): number {
  return cam.cameraKeysActive;
}

/**
 * Queues a keyframe (at most ten); ticks = round(seconds * 182).
 *
 * @mw2 camera_key_add 0x0003ff40
 * @fidelity exact
 */
export function cameraKeyAdd(x: number, y: number, z: number, pitch: number, yaw: number, roll: number, seconds: number): void {
  const c = cam;
  if (c.cameraKeyCount >= 10) return;
  const k = c.cameraKeys[c.cameraKeyCount]!;
  k.offsetX = x | 0;
  k.offsetY = y | 0;
  k.offsetZ = z | 0;
  k.offsetPitch = pitch | 0;
  k.offsetYaw = yaw | 0;
  k.offsetRoll = roll | 0;
  // fistp in the default (round-to-nearest-even) mode
  k.ticks = roundEven(seconds * 182.0);
  c.cameraKeyCount++;
}

function roundEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Points the six key ramps at keyframe `index`, starting from where the view
 * is now (index 0) or where the ramps are.
 *
 * @mw2 camera_key_begin 0x0003fd90
 * @fidelity exact
 */
export function cameraKeyBegin(index: number): void {
  const c = cam;
  if (!(index < c.cameraKeyCount && index < 10 && -1 < index)) return;
  let x: number, y: number, z: number, pitch: number, yaw: number, roll: number;
  if (index === 0) {
    const p = cameraPilotViewPose();
    const v = vp();
    x = (v.posX - p.x) | 0;
    y = (v.posY - p.y) | 0;
    z = (v.posZ - p.z) | 0;
    pitch = (v.pitch - p.pitch) | 0;
    yaw = (v.yaw - p.yaw) | 0;
    roll = (v.roll - p.roll) | 0;
  } else {
    x = c.camKeyRampX.current;
    y = c.camKeyRampY.current;
    z = c.camKeyRampZ.current;
    pitch = c.camKeyRampPitch.current;
    yaw = c.camKeyRampYaw.current;
    roll = c.camKeyRampRoll.current;
  }
  const k = c.cameraKeys[index]!;
  // ticks * (1 / 182.0) (the double at 0x90ffc)
  const seconds = k.ticks * (1 / 182.0);
  const t = clock.simTick;
  rampStart(c.camKeyRampX, k.offsetX, x, seconds, t);
  rampStart(c.camKeyRampY, k.offsetY, y, seconds, t);
  rampStart(c.camKeyRampZ, k.offsetZ, z, seconds, t);
  rampStart(c.camKeyRampPitch, k.offsetPitch, pitch, seconds, t);
  rampStart(c.camKeyRampYaw, k.offsetYaw, yaw, seconds, t);
  rampStart(c.camKeyRampRoll, k.offsetRoll, roll, seconds, t);
}

/**
 * @mw2 camera_keys_start 0x0003fd50
 * @fidelity exact
 */
export function cameraKeysStart(): void {
  const c = cam;
  c.cameraKeyIndex = 0;
  c.cameraKeyElapsed = 0;
  if (0 < c.cameraKeyCount) {
    c.cameraKeysActive = 1;
    cameraKeyBegin(0);
  }
}

/**
 * Plays the keys on top of the pilot's view; 0 when none are active.
 *
 * @mw2 camera_keys_update 0x0003fc00
 * @fidelity exact
 */
export function cameraKeysUpdate(): number {
  const c = cam;
  if (c.cameraKeyIndex < 0 || c.cameraKeyCount <= c.cameraKeyIndex) c.cameraKeysActive = 0;
  if (c.cameraKeysActive === 0) return 0;
  c.cameraKeyElapsed = (c.cameraKeyElapsed + clock.tickDelta) | 0;
  if (c.cameraKeys[c.cameraKeyIndex]!.ticks <= c.cameraKeyElapsed) {
    c.cameraKeyIndex++;
    c.cameraKeyElapsed = 0;
    if (c.cameraKeyIndex < c.cameraKeyCount) cameraKeyBegin(c.cameraKeyIndex);
  }
  const p = cameraPilotViewPose();
  const v = vp();
  const t = clock.simTick;
  v.posX = (p.x + rampStep(c.camKeyRampX, t)) | 0;
  v.posY = (rampStep(c.camKeyRampY, t) + p.y) | 0;
  v.posZ = (rampStep(c.camKeyRampZ, t) + p.z) | 0;
  v.pitch = (rampStep(c.camKeyRampPitch, t) + p.pitch) | 0;
  v.yaw = (rampStep(c.camKeyRampYaw, t) + p.yaw) | 0;
  v.roll = (rampStep(c.camKeyRampRoll, t) + p.roll) | 0;
  return 1;
}

/**
 * Kicks the view away from an impact: three keyframes - the kick, half of
 * it back, rest - unless a shake is already playing.
 *
 * @mw2 view_shake_impulse 0x00028c70
 * @fidelity exact
 */
export function viewShakeImpulse(x: number, y: number, z: number): void {
  if (cameraKeysActive() !== 0) return;
  const v = [x | 0, y | 0, z | 0];
  vec3Normalise(v);
  const mag = v[0] === 0 && v[2] === 0 ? Math.imul(v[1]!, 0x1e) : Math.imul((v[1]! - v[2]!) | 0, 5);
  const kx = mulr16(v[0]!, -0x19);
  const ky = mulr16(v[1]!, -0x19);
  const kz = mulr16(v[2]!, -0x19);
  cameraKeysClear();
  cameraKeyAdd(kx, ky, kz, mag, 0, 0, 0.2);
  cameraKeyAdd(-(kx >> 1), -(ky >> 1), -(kz >> 1), -(mag >> 1), 0, 0, 0.5);
  cameraKeyAdd(0, 0, 0, 0, 0, 0, 0.2);
  cameraKeysStart();
}

/**
 * The cockpit zoom in cameraMode 0, the alternative zoom otherwise, into
 * the viewer; a change clicks.
 *
 * @mw2 camera_apply_zoom 0x00039440
 * @fidelity exact
 */
export function cameraApplyZoom(reset: number): void {
  const c = cam;
  const v = vp();
  const was = v.zoom;
  if (reset !== 0) {
    c.cameraZoomPlayer = 0x10000;
    c.cameraZoomAlt = 0x10000;
  }
  v.zoom = cameraGlobals.cameraMode === 0 ? c.cameraZoomPlayer : c.cameraZoomAlt;
  if (was !== v.zoom) {
    c.dat000954ec = 1;
    soundPlay(0x147, 100, 0x40, 5, 0x50);
  }
}

export interface Pose {
  pitch: number;
  yaw: number;
  roll: number;
  x: number;
  y: number;
  z: number;
}

/**
 * The pose the camera takes from cameraSubject: its body, or its aim node's
 * origin raised by the player's eye offset and turned by the torso.
 *
 * @mw2 camera_subject_eye_pose 0x000395d0
 * @fidelity exact
 */
export function cameraSubjectEyePose(): Pose {
  const o: Pose = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0 };
  const s = cam.cameraSubject;
  if (!s) return o;
  o.pitch = s.pitch;
  o.yaw = s.heading;
  o.roll = s.roll;
  if (!s.aimNode) {
    o.x = s.posX;
    o.y = s.posY;
    o.z = s.posZ;
    return o;
  }
  const eye = cameraGlobals.playerEyeOffsetY;
  if (eye) o.y = (o.y + eye.eyeOffsetY) | 0;
  const p = [o.x, o.y, o.z];
  transformPoint(sceneNodeTransform(s.aimNode), p);
  o.x = p[0]!;
  o.y = p[1]!;
  o.z = p[2]!;
  const w = sceneNodeGetWorldEuler(s.aimNode);
  if (mechRuntime.playerOut === 0) {
    o.pitch = (o.pitch + s.torsoPitch) | 0;
    o.yaw = (o.yaw + s.aimAngle) | 0;
    o.roll = w.roll >> 1;
  } else {
    o.pitch = w.pitch;
    o.yaw = w.yaw;
    o.roll = w.roll;
  }
  return o;
}

/**
 * The subject's eye pose plus the pilot's look-around (ramped toward
 * pilot_pan / pilot_tilt).
 *
 * @mw2 camera_pilot_view_pose 0x00039c50
 * @fidelity exact
 */
export function cameraPilotViewPose(): Pose {
  const c = cam;
  const o = cameraSubjectEyePose();
  if (mechRuntime.playerOut === 0) {
    const pc = mechs.playerControls;
    c.camPilotPan.target = pc.pilot_pan;
    const pan = rampStep(c.camPilotPan, clock.simTick);
    c.camPilotTilt.target = pc.pilot_tilt;
    const tilt = rampStep(c.camPilotTilt, clock.simTick);
    o.yaw = (o.yaw + pan) | 0;
    o.pitch = (o.pitch + tilt) | 0;
  }
  c.dat00096ef0 = 1;
  return o;
}

/**
 * cameraMode 0 and 6: the pilot's view, with the glance keys and the camera
 * keys on top.
 *
 * @mw2 camera_cockpit_view 0x00039b30
 * @fidelity exact
 */
export function cameraCockpitView(): void {
  const c = cam;
  const pc = mechs.playerControls;
  if (c.cameraModePrev !== 0) {
    c.camPilotPan.lastTick = clock.simTick;
    c.camPilotPan.current = 0;
    c.camPilotTilt.lastTick = clock.simTick;
    c.camPilotTilt.current = 0;
    cameraKeysClear();
    cameraApplyZoom(0);
  }
  cameraGlobals.cockpitViewActive = 1;
  c.dat00096ef0 = 0;
  if (pc.glance_left !== 0) pc.pilot_pan = -0x460000;
  else if (pc.glance_right !== 0) pc.pilot_pan = 0x460000;
  else if (pc.glance_up !== 0) pc.pilot_tilt = -0x320000;
  else if (pc.glance_down !== 0) pc.pilot_tilt = 0x280000;
  else if (c.dat00096f18 === 0) {
    pc.pilot_pan = 0;
    pc.pilot_tilt = 0;
  }
  c.dat00096f18 = pc.glance_right === 0 && pc.glance_left === 0 && pc.glance_up === 0 && pc.glance_down === 0 ? 1 : 0;
  if (cameraKeysUpdate() === 0) {
    const p = cameraPilotViewPose();
    const v = vp();
    v.pitch = p.pitch;
    v.yaw = p.yaw;
    v.roll = p.roll;
    v.posX = p.x;
    v.posY = p.y;
    v.posZ = p.z;
  }
}

/**
 * cameraMode 1: the orbit camera around the subject. See the upstream note.
 *
 * @mw2 camera_orbit_update 0x00039800
 * @fidelity exact
 */
export function cameraOrbitUpdate(distanceDelta: number, heightDelta: number, tilt: number, orbitDelta: number): void {
  const c = cam;
  const t = clock.simTick;
  const eye = cameraSubjectEyePose();
  const v = vp();
  if (c.cameraModePrev !== 1) {
    if (mechRuntime.playerOut === 0) soundCuePlay(0x11, -1);
    if (c.camOrbitDistance === 0) {
      const l0 = mechs.mechTable[0]!.loadout!;
      c.camOrbitDistance = Math.imul(l0.radius, 3);
      c.camOrbitDistanceMin = c.camOrbitDistance >> 1;
      c.camOrbitDistanceMax = Math.imul(c.camOrbitDistance, 4);
      c.camOrbitHeight = c.camOrbitDistance >> 2;
      c.camOrbitHeightMax = c.camOrbitDistanceMax;
      c.camOrbitHeightMin = (200 - l0.rideHeight) | 0;
    }
    c.camOrbitOffsetX.lastTick = t;
    c.camOrbitOffsetY.lastTick = t;
    c.camOrbitOffsetZ.lastTick = t;
    c.camOrbitYaw.lastTick = t;
    c.camOrbitPitch.lastTick = t;
    c.camOrbitOffsetX.current = (v.posX - eye.x) | 0;
    c.camOrbitOffsetY.current = (v.posY - eye.y) | 0;
    c.camOrbitOffsetZ.current = (v.posZ - eye.z) | 0;
    c.camOrbitYaw.current = v.yaw;
    c.camOrbitPitch.current = v.pitch;
    v.roll = 0;
    if (v.posX === eye.x) v.posX = (v.posX + 10) | 0;
    c.cameraZoomAlt = 0x10000;
    cameraApplyZoom(0);
  }
  c.camOrbitDistance = (c.camOrbitDistance + distanceDelta) | 0;
  if (c.camOrbitDistanceMax < c.camOrbitDistance) c.camOrbitDistance = c.camOrbitDistanceMax;
  else if (c.camOrbitDistance < c.camOrbitDistanceMin) c.camOrbitDistance = c.camOrbitDistanceMin;
  const height = (c.camOrbitHeight + heightDelta) | 0;
  c.camOrbitAngle = cmod((c.camOrbitAngle + orbitDelta) | 0, 0x1680000);
  const rb = vecToRangeBearing(eye.x - v.posX, eye.y - v.posY, eye.z - v.posZ);
  rampAngleSetTarget(c.camOrbitPitch, (-(tilt >> 1) - rb.elevation) | 0);
  v.pitch = rampAngleStep(c.camOrbitPitch, t);
  rampAngleSetTarget(c.camOrbitYaw, rb.azimuth);
  v.yaw = rampAngleStep(c.camOrbitYaw, t);
  let rel = cmod((eye.yaw - c.camOrbitAngle) | 0, 0x1680000);
  if (rel < -0xb40000) rel += 0x1680000;
  else if (0xb40000 < rel) rel -= 0x1680000;
  const cs = fixedCos(rel);
  const sn = fixedSin(rel);
  c.camOrbitOffsetX.target = scale13(c.camOrbitDistance, sn);
  const ox = rampStep(c.camOrbitOffsetX, t);
  c.camOrbitOffsetZ.target = scale13(c.camOrbitDistance, cs);
  v.posX = (ox + eye.x) | 0;
  const oz = rampStep(c.camOrbitOffsetZ, t);
  v.posZ = (eye.z + oz) | 0;
  let floor = worldFindHighestHit(v.posX, v.posY, v.posZ);
  floor = floor < 1 ? floor + 200 : floor + 500;
  c.camOrbitOffsetY.target = height;
  if (eye.y + height < floor) c.camOrbitOffsetY.target = (floor - eye.y) | 0;
  if (c.camOrbitHeightMax < height) c.camOrbitHeight = c.camOrbitHeightMax;
  else c.camOrbitHeight = height < c.camOrbitHeightMin ? c.camOrbitHeightMin : height;
  v.posY = (eye.y + rampStep(c.camOrbitOffsetY, t)) | 0;
}

/**
 * cameraMode 2: the free-flying camera.
 *
 * @mw2 camera_free_fly 0x00039d90
 * @fidelity exact
 */
export function cameraFreeFly(heightRate: number, forwardRate: number, strafeRate: number, yawRate: number, pitchRate: number): void {
  const c = cam;
  const v = vp();
  const sy = fixedSin(v.yaw);
  const cy = fixedCos(v.yaw);
  fixedSin(v.pitch);
  const cp = fixedCos(v.pitch);
  if (c.cameraModePrev !== 2) {
    if (mechRuntime.playerOut !== 0) {
      v.posX = (v.posX - scale13(c.camOrbitDistance, sy)) | 0;
      v.posZ = (v.posZ - scale13(c.camOrbitDistance, cy)) | 0;
    }
    v.roll = 0;
    c.camFlyForward.lastTick = clock.simTick;
    c.cameraZoomAlt = c.cameraZoomPlayer;
    c.camFlyForward.current = 0;
    cameraApplyZoom(0);
  }
  v.posX = (v.posX + (mulr16(strafeRate, cy) >> 0xb)) | 0;
  v.posZ = (v.posZ - (mulr16(strafeRate, sy) >> 0xb)) | 0;
  v.pitch = (v.pitch - pitchRate) | 0;
  if (!(v.pitch < 0x5a0001)) v.pitch = 0x5a0000;
  else if (v.pitch < -0x5a0000) v.pitch = -0x5a0000;
  v.posY = (v.posY + Math.imul(heightRate, 4)) | 0;
  c.camFlyForward.target = forwardRate << 4;
  let f = rampStep(c.camFlyForward, clock.simTick);
  if (f < 0x20 && -0x20 < f) f = 0;
  v.yaw = (v.yaw + yawRate) | 0;
  v.posX = (v.posX - (mulr16(mulr16(f, sy) >> 0xd, cp) >> 0xd)) | 0;
  v.posZ = (v.posZ - (mulr16(mulr16(f, cy) >> 0xd, cp) >> 0xd)) | 0;
  let floor = worldFindHighestHit(v.posX, v.posY, v.posZ);
  floor = floor < 1 ? floor + 200 : floor + 500;
  if (v.posY < floor) v.posY = floor;
}

/**
 * cameraMode 4: the ejection camera, climbing and spinning over the mech.
 *
 * @mw2 camera_eject_view 0x00039cc0
 * @fidelity exact
 */
export function cameraEjectView(): void {
  const c = cam;
  const eye = cameraSubjectEyePose();
  const v = vp();
  if (c.cameraModePrev !== 4) {
    c.ejectCamVelocity = 0;
    v.pitch = 0x5a0000;
    c.ejectCamStartTick = clock.simTick;
    cameraApplyZoom(0);
  }
  const td = clock.tickDelta;
  const stepBase = ((Math.imul(c.ejectCamAccel, td) >> 1) + c.ejectCamVelocity) | 0;
  c.ejectCamVelocity = (c.ejectCamVelocity + Math.imul(c.ejectCamAccel, td)) | 0;
  v.posY = (v.posY + mulShr16(stepBase, td)) | 0;
  v.posX = eye.x;
  v.posZ = eye.z;
  v.yaw = (v.yaw + Math.imul((clock.simTick - c.ejectCamStartTick) | 0, 300)) | 0;
}

function mulShr16(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a | 0) * BigInt(b | 0)) >> 16n));
}

/**
 * cameraMode 3: follows a missile until it is gone. On entry it remembers
 * the mode it came from and the viewer's pose and zooms 2x; each frame it
 * copies missile_cam_pose into the viewer while the pose's valid word is set.
 * When the missile is gone it returns to the saved mode (after an ejection,
 * the post-eject mode) and, from the free camera, to the saved pose.
 *
 * @mw2 camera_missile_view 0x000396b0
 * @fidelity exact
 */
export function cameraMissileView(): void {
  const c = cam;
  const v = vp();
  if (c.cameraModePrev !== 3) {
    c.cameraModeBeforeMissile = c.cameraModePrev;
    c.savedViewPose.set([v.posX, v.posY, v.posZ, v.yaw, v.pitch, v.roll]);
    c.dat0014fb94 = 1;
    c.cameraZoomAlt = 0x20000;
    cameraApplyZoom(0);
  }
  const pose = missileCamPose();
  if (pose === null) {
    const g = cameraGlobals;
    g.cameraMode = c.cameraModeBeforeMissile;
    if (mechRuntime.playerOut !== 0) {
      g.cameraMode = g.ejectCameraMode;
      if (g.ejectCameraMode === -1) {
        g.ejectCameraMode = 1;
        g.cameraMode = 1;
      }
    }
    if (c.cameraModeBeforeMissile !== 2 || c.dat0014fb94 === 0) return;
    const s = c.savedViewPose;
    v.posX = s[0]!;
    v.posY = s[1]!;
    v.posZ = s[2]!;
    v.yaw = s[3]!;
    v.pitch = s[4]!;
    v.roll = s[5]!;
    return;
  }
  if (pose[6] === 0) return;
  v.posX = pose[0]!;
  v.posY = pose[1]!;
  v.posZ = pose[2]!;
  v.yaw = pose[3]!;
  v.pitch = pose[4]!;
  v.roll = pose[5]!;
}

/**
 * The next or previous mech to follow, or the player's.
 *
 * @mw2 camera_track_cycle 0x00039560
 * @fidelity exact
 */
export function cameraTrackCycle(forward: number, fromPlayer: number): void {
  const c = cam;
  if (mechs.mechCount === 0) return;
  let step = -1;
  if (fromPlayer === 0) {
    if (forward !== 0) step = 1;
  } else {
    step = 0;
    c.cameraTrackIndex = mechs.playerMechIndex;
  }
  c.cameraTrackIndex = (c.cameraTrackIndex + step) | 0;
  if (c.cameraTrackIndex < 0) c.cameraTrackIndex = mechs.mechCount - 1;
  else if (mechs.mechCount <= c.cameraTrackIndex) c.cameraTrackIndex = 0;
  c.cameraSubject = mechs.mechTable[c.cameraTrackIndex] ?? null;
  c.cameraModePrev = -1;
}

/**
 * Turns every fire, smoke and jet-flame object (type families 0x10 and 0x60)
 * about Y to face the viewer's position.
 *
 * @mw2 billboards_face_viewer 0x00039fa0
 * @fidelity partial
 * @divergence the video-state-4 case (radar_map_up: a fixed yaw of 180 and pitch of -45) is not reproduced; the port is never in that state
 */
export function billboardsFaceViewer(): void {
  const v = vp();
  for (const o of objectsOnList(worldRootNode)) {
    const f = o.type & 0xf0;
    if ((f === 0x10 || f === 0x60) && o.node) {
      const p = sceneNodeGetWorldPos(o.node);
      const yaw = fixedAtan2((v.posX - p[0]) | 0, (v.posZ - p[2]) | 0);
      sceneNodeSetEuler(o.node, 0, yaw, 0, 0);
      sceneNodeWalk(o.node);
    }
  }
}

/**
 * Arms the camera ramps, unity zoom, the player as subject, the starting
 * mode.
 *
 * @mw2 camera_init 0x00038ff0
 * @fidelity exact
 */
export function cameraInit(): void {
  const c = cam;
  const t = clock.simTick;
  rampStart(c.camOrbitOffsetX, 0, 0, 0.5, t);
  rampStart(c.camOrbitOffsetZ, 0, 0, 0.5, t);
  rampStart(c.camOrbitOffsetY, 0, 0, 0.7, t);
  rampStart(c.camFlyForward, 0, 0, 1.0, t);
  rampStart(c.camPilotPan, 0, 0, 0.2, t);
  rampStart(c.camPilotTilt, 0, 0, 0.2, t);
  rampAngleStart(c.camOrbitYaw, 0, 0, 0.2, 0x1680000, t);
  rampAngleStart(c.camOrbitPitch, 0, 0, 0.2, 0x1680000, t);
  mechs.playerControls.zoom_factor = 0x10000;
  // the five-entry table at 0x14fb9c is cleared here; nothing the port has reads it
  const pm = mechs.mechTable[mechs.playerMechIndex];
  if (pm) {
    c.cameraTrackIndex = mechs.playerMechIndex;
    c.cameraSubject = pm;
  }
  cameraKeysInit();
  const g = cameraGlobals;
  g.cameraMode = c.dat00096ee4;
  if (mechRuntime.playerOut !== 0) {
    g.cameraMode = g.ejectCameraMode;
    if (g.ejectCameraMode === -1) {
      g.ejectCameraMode = 1;
      g.cameraMode = 1;
    }
  }
}

/** (int64)x * tickDelta / 182, truncated */
function perSecond(x: number): number {
  return Number(BigInt.asIntN(32, (BigInt(x | 0) * BigInt(clock.tickDelta | 0)) / 182n));
}

/**
 * Once a frame from main: zoom, the mode, its handler, then the scrounge
 * patch and billboards follow the viewer.
 *
 * @mw2 camera_update 0x00039190
 * @fidelity exact
 */
export function cameraUpdate(): void {
  const c = cam;
  const g = cameraGlobals;
  const pc = mechs.playerControls;
  c.cameraZoomPlayer = pc.zoom_factor;
  cameraApplyZoom(0);
  c.dat00096ef0 = 0;
  g.cockpitViewActive = 0;
  let mode: number;
  if (mechs.mechCount === 0) {
    g.cameraMode = 2;
    if (mechRuntime.playerOut !== 0) {
      g.cameraMode = g.ejectCameraMode;
      if (g.ejectCameraMode === -1) {
        g.ejectCameraMode = 1;
        g.cameraMode = 1;
      }
    }
    c.cameraSubject = null;
    mode = 2;
  } else {
    if (g.cameraMode === 0) c.cameraSubject = mechs.mechTable[mechs.playerMechIndex] ?? null;
    mode = c.cameraSubject ? g.cameraMode : 2;
  }
  c.dat00097020 = 0;
  switch (mode) {
    case 0:
    case 6:
      cameraCockpitView();
      break;
    case 1: {
      let orbit = perSecond(pc.eyepoint_pan_delta);
      if (mechRuntime.playerOut !== 0) orbit = clock.tickDelta << 0xe;
      cameraOrbitUpdate(perSecond(pc.track_distance_delta) >> 0x10, perSecond(pc.track_height_delta) >> 0x10, pc.eyepoint_tilt, orbit);
      break;
    }
    case 3:
      cameraMissileView();
      break;
    case 4:
      cameraEjectView();
      break;
    default: {
      let pitchRate = 0;
      if (0 < pc.eyepoint_tilt) pitchRate = (Math.imul(clock.tickDelta, 0x2d0000) / 0xb6) | 0;
      else if (pc.eyepoint_tilt < 0) pitchRate = (Math.imul(clock.tickDelta, -0x2d0000) / 0xb6) | 0;
      pc.eyepoint_tilt_reset = 1;
      cameraFreeFly(perSecond(pc.track_height_delta) >> 0xf, perSecond(pc.track_distance_delta) >> 0xf, perSecond(pc.eyepoint_slide_delta) >> 0x10, perSecond(pc.eyepoint_pan_delta), pitchRate);
      break;
    }
  }
  c.cameraModePrev = mode;
  scroungeFollowViewer();
  billboardsFaceViewer();
}

