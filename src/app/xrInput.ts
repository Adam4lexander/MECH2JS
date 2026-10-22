/**
 * The VR controllers as the game's own input: every action is a key the
 * game already binds (INPUT.MAP / GAMEKEY.MAP), pressed and released through
 * the keyboard's scancodes, and the right stick is the mouse the game reads
 * as a centring joystick (it steers the torso).
 *
 *   left stick      up / down: throttle + / - (= and -, held); left / right: turn (arrows)
 *   left click      reverse direction (`)
 *   left trigger    cycle weapon (Enter)
 *   left grip       throttle stop (1)
 *   X / Y           cockpit / external view (c) / the main menu (Esc)
 *   right stick     torso twist and pitch (the mouse; , . and the arrows' torso keys if there is none)
 *   right click     feet to torso (m)
 *   right trigger   fire the selected weapon (Space)
 *   right grip      fire the selected group (;)
 *   A / B           nearest enemy (e) / next target (t)
 *
 * Recentring the view is the headset's own (the 'local' reference space
 * follows the system's recentre).
 *
 * @portOnly
 */
import { releaseSentKeys, sendKey, setMouseStick } from './hostInput.ts';
import { IDLE_PAD, PadMapper, type PadState } from './xrPads.ts';

/** The state of an XR session's controllers (xr-standard: axes 2 / 3 the stick, buttons 0 trigger, 1 grip, 3 stick click, 4 A / X, 5 B / Y). */
export function readPads(session: XRSession): PadState {
  const p = { ...IDLE_PAD };
  for (const src of session.inputSources) {
    const g = src.gamepad;
    if (!g) continue;
    const ax = (i: number) => g.axes[i] ?? 0;
    const val = (i: number) => g.buttons[i]?.value ?? 0;
    const on = (i: number) => g.buttons[i]?.pressed ?? false;
    if (src.handedness === 'left') {
      p.lx = ax(2);
      p.ly = ax(3);
      p.lTrigger = val(0);
      p.lGrip = val(1);
      p.lClick = on(3);
      p.x = on(4);
      p.y = on(5);
    } else if (src.handedness === 'right') {
      p.rx = ax(2);
      p.ry = ax(3);
      p.rTrigger = val(0);
      p.rGrip = val(1);
      p.rClick = on(3);
      p.a = on(4);
      p.b = on(5);
    }
  }
  return p;
}

/** Feeds the game from an XR session's controllers, one call per display frame. */
export class XrInput {
  private readonly mapper = new PadMapper();
  /** the torso keys the stick falls back to without a mouse device */
  private readonly torsoKeys = new PadMapper();

  poll(session: XRSession, active: boolean): void {
    if (!active) {
      this.release();
      return;
    }
    const { keys, torso } = this.mapper.update(readPads(session));
    for (const k of keys) sendKey(k.code, k.down);
    if (torso && !setMouseStick(torso[0], torso[1])) {
      const t = this.torsoKeys.update({ ...IDLE_PAD, lx: torso[0] });
      // the same hysteresis, on , and .
      for (const k of t.keys) if (k.code === 'ArrowLeft' || k.code === 'ArrowRight') sendKey(k.code === 'ArrowLeft' ? 'Comma' : 'Period', k.down);
    }
  }

  release(): void {
    this.mapper.reset();
    this.torsoKeys.reset();
    releaseSentKeys();
    setMouseStick(0, 0);
  }
}
