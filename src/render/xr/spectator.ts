/**
 * The spectator camera: what the page shows while a headset plays, for
 * recording. A headset's raw view makes poor footage - every glance and
 * tremor of the head is in it, and it is one eye's odd shape - so the page
 * can show a camera of its own instead, drawn a second time each frame into
 * a target the page's shape and copied onto the canvas:
 *
 *   mirror  the left eye as the headset shows it (a framebuffer copy - no
 *           second drawing, the cheapest)
 *   smooth  the pilot's view with the head's shake taken out: at the head,
 *           turned as it is turned but eased (SpectatorSettings.smooth
 *           seconds) and with the head's roll left out, at its own field of
 *           view - the cockpit, the HUD and all
 *   chase   behind and above the mech, looking over it the way its torso
 *           faces, easing round after it as it turns: the whole mech
 *           (render/enhance/ownChassis.ts, the torso the headset does not
 *           draw), no cockpit, no HUD
 *
 * The easing is on the turn only. The camera stands at the head (or at the
 * chase offset from it) every frame: easing a position after a mech doing
 * 30 m/s would leave the camera metres behind it.
 *
 * Smooth and chase draw the frame a third time, on top of the headset's two
 * eyes, so they are the address's to ask for: `?spectator=smooth`,
 * `?spectator=chase`, or `?spectator` alone for the one last picked (smooth
 * at first). Without it the page mirrors the eye, whatever was picked
 * before. The field of view and the easing are remembered (localStorage, as
 * the other VR settings are), and the mode last picked.
 *
 * @portOnly
 */
import * as THREE from 'three';

export type SpectatorMode = 'mirror' | 'smooth' | 'chase';

export interface SpectatorSettings {
  mode: SpectatorMode;
  /** horizontal field of view, degrees */
  fov: number;
  /** the turn's easing time constant, seconds */
  smooth: number;
}

export const SPECTATOR_DEFAULTS: SpectatorSettings = { mode: 'mirror', fov: 90, smooth: 0.35 };

/** the chase camera: metres back from the eye, up from it, and how far below the eye it looks at, along the torso's facing */
export const CHASE = { back: 16, up: 4, lookDown: 3 };

const KEY = 'mw2.spectator';

/** the page's address query ('' outside a browser, as in the tests) */
const pageSearch = (): string => (globalThis as { location?: { search?: string } }).location?.search ?? '';

const isMode = (v: unknown): v is SpectatorMode => v === 'mirror' || v === 'smooth' || v === 'chase';

/** Whether the address asks for the drawn spectator cameras (`?spectator`). */
export function spectatorUnlocked(search = pageSearch()): boolean {
  return new URLSearchParams(search).has('spectator');
}

/** The mode the address gives: mirror without `?spectator`; its value; or, bare, the one last picked (smooth at first). */
export function spectatorModeFor(search: string, stored: unknown): SpectatorMode {
  const p = new URLSearchParams(search);
  if (!p.has('spectator')) return 'mirror';
  const v = p.get('spectator');
  if (isMode(v)) return v;
  return isMode(stored) ? stored : 'smooth';
}

export function recallSpectatorSettings(): SpectatorSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SpectatorSettings>;
    const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    return {
      mode: spectatorModeFor(pageSearch(), s.mode),
      fov: num(s.fov, SPECTATOR_DEFAULTS.fov, 40, 130),
      smooth: num(s.smooth, SPECTATOR_DEFAULTS.smooth, 0, 2),
    };
  } catch {
    return { ...SPECTATOR_DEFAULTS, mode: spectatorModeFor(pageSearch(), undefined) };
  }
}

/** Remembers the settings - the mode only when the address let it be picked (without `?spectator` it is mirror, not a pick). */
export function storeSpectatorSettings(s: SpectatorSettings): void {
  try {
    let mode: unknown = s.mode;
    if (!spectatorUnlocked()) mode = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SpectatorSettings>).mode;
    localStorage.setItem(KEY, JSON.stringify({ ...s, mode }));
  } catch {
    /* private window: not remembered */
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** The yaw and pitch (radians) of a camera orientation's forward (-z), roll dropped. */
export function yawPitch(q: THREE.Quaternion): { yaw: number; pitch: number } {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return { yaw: Math.atan2(-f.x, -f.z), pitch: Math.asin(Math.max(-1, Math.min(1, f.y))) };
}

/** A camera orientation from yaw and pitch, level (no roll). */
export function levelQuaternion(yaw: number, pitch: number, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

export class Spectator {
  /** the camera the page's view is drawn through; its aspect and field of view set by place() */
  readonly camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 20000);
  private readonly q = new THREE.Quaternion();
  private started = false;

  /** Forget the eased turn: the next place() stands straight at its target (a new session, a mode change). */
  reset(): void {
    this.started = false;
  }

  /**
   * Poses the camera for a frame, `dt` seconds after the last: `head` the
   * headset's camera (its world matrix), `rig` the cockpit's pose (the game's
   * viewer, xrRig.ts), `aspect` the page's width over its height.
   */
  place(s: SpectatorSettings, head: THREE.Object3D, rig: THREE.Object3D, dt: number, aspect: number): THREE.PerspectiveCamera {
    const cam = this.camera;
    const headPos = new THREE.Vector3();
    const headQ = new THREE.Quaternion();
    head.matrixWorld.decompose(headPos, headQ, new THREE.Vector3());
    let target: THREE.Quaternion;
    let at: THREE.Vector3;
    if (s.mode === 'chase') {
      // along the torso's facing, level: the rig's yaw alone
      const { yaw } = yawPitch(rig.getWorldQuaternion(new THREE.Quaternion()));
      const eye = rig.getWorldPosition(new THREE.Vector3());
      // the ease is on the angle round the eye; the camera's place follows the eased angle
      const eased = this.ease(levelQuaternion(yaw, 0), dt, s.smooth);
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(eased).multiplyScalar(CHASE.back);
      at = eye.clone().add(back).addScaledVector(UP, CHASE.up);
      const look = eye.clone().addScaledVector(UP, -CHASE.lookDown).sub(at).normalize();
      target = levelQuaternion(Math.atan2(-look.x, -look.z), Math.asin(look.y));
      cam.quaternion.copy(target);
    } else {
      const { yaw, pitch } = yawPitch(headQ);
      target = levelQuaternion(yaw, pitch);
      at = headPos;
      cam.quaternion.copy(this.ease(target, dt, s.smooth));
    }
    cam.position.copy(at);
    cam.aspect = aspect;
    const tanH = Math.tan((s.fov * Math.PI) / 360);
    cam.fov = (2 * Math.atan(tanH / aspect) * 180) / Math.PI;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  }

  /** The eased orientation: `target` approached with time constant `tau`, the first time reached at once. */
  private ease(target: THREE.Quaternion, dt: number, tau: number): THREE.Quaternion {
    if (!this.started || tau <= 0) {
      this.q.copy(target);
      this.started = true;
    } else this.q.slerp(target, 1 - Math.exp(-Math.max(0, dt) / tau));
    return this.q;
  }
}
