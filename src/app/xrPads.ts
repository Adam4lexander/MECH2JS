/**
 * The VR controllers' mapping onto what the pilot wants (sim/controls/
 * pilotIntent.ts): analog throttle, legs and torso, the guns and the jets
 * held, and a press's command. app/xrInput.ts reads the controllers and
 * hands this its states; the cockpit's own switches and levers are
 * render/cockpit/touch.ts's. Pure, and free of the DOM, so the unit tests
 * reach it.
 *
 *                 left hand (moving)                right hand (aim and fire)
 *   stick y       throttle up / down, held where    torso pitch
 *                 it is left, through a stop into
 *                 reverse
 *   stick x       turn the legs, proportional       torso twist
 *   stick click   all stop                          feet to torso
 *   trigger       jump jets (held)                  fire the selected weapon
 *   grip          hold the throttle lever           hold the stick; elsewhere,
 *                                                   fire the selected group
 *   X / Y, A / B  cycle weapon / main menu          nearest enemy / next target
 *
 * With an in-game menu up the sticks move through it, a trigger or A picks,
 * and B or Y backs out; whatever was held in the menu does nothing more until
 * it is let go.
 *
 * @portOnly the VR controls
 */
import { IDLE_INTENT, type PilotIntent, type PilotPulse } from '../sim/controls/pilotIntent.ts';
import { CMD } from '../render/cockpit/controls.ts';
import { leverThrottle } from '../render/cockpit/touch.ts';

/** One frame of both controllers, in the xr-standard gamepad mapping's terms. */
export interface PadState {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lTrigger: number;
  lGrip: number;
  lClick: boolean;
  rTrigger: number;
  rGrip: number;
  rClick: boolean;
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
}

export const IDLE_PAD: PadState = { lx: 0, ly: 0, rx: 0, ry: 0, lTrigger: 0, lGrip: 0, lClick: false, rTrigger: 0, rGrip: 0, rClick: false, a: false, b: false, x: false, y: false };

/** What the cockpit has taken from the controllers this frame (render/cockpit/touch.ts). */
export interface PadTaken {
  /** per hand (left, right): the trigger pressed a switch */
  trigger: [boolean, boolean];
  /** per hand: the grip holds the lever or the stick */
  grip: [boolean, boolean];
  /** the throttle lever as held (touch.ts's lever, -0.5..1), or null */
  lever: number | null;
  /** the stick as held, [right, back] -1..1, or null */
  stick: [number, number] | null;
}

export const NOTHING_TAKEN: PadTaken = { trigger: [false, false], grip: [false, false], lever: null, stick: null };

export interface PadOutput {
  intent: PilotIntent;
  commands: number[];
  pulses: PilotPulse[];
}

/** an analogue input presses at PRESS and lets go below RELEASE */
const PRESS = 0.6;
const RELEASE = 0.4;
/** the sticks' dead zone */
const DEAD = 0.12;
/** the throttle's travel a second at full stick: the whole range in two seconds */
export const THROTTLE_RATE = 0.5;
/** the torso's turn and pitch at full stick, degrees a second */
export const TORSO_PAN_RATE = 60;
export const TORSO_TILT_RATE = 40;

/** A stick axis outside the dead zone, rescaled to 0..1 beyond it. */
export function deadZone(v: number): number {
  return Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD);
}

/**
 * Turns controller states into the pilot's intent, held buttons and press
 * edges. Pure: the caller hands the result to the sim.
 */
export class PadMapper {
  private readonly held = new Set<string>();
  /** inputs held while a menu had them: theirs until let go, so a trigger that picked an order doesn't fire as the menu closes */
  private readonly spent = new Set<string>();

  update(p: PadState, menuOpen: boolean, taken: PadTaken = NOTHING_TAKEN): PadOutput {
    const intent: PilotIntent = { ...IDLE_INTENT };
    const commands: number[] = [];
    const pulses: PilotPulse[] = [];
    /** whether an input is held: a button, or an analogue one with hysteresis */
    const hold = (name: string, v: number | boolean): boolean => {
      const on = typeof v === 'boolean' ? v : this.held.has(name) ? v > RELEASE : v > PRESS;
      const pressed = on && !this.held.has(name);
      if (on) this.held.add(name);
      else {
        this.held.delete(name);
        this.spent.delete(name);
      }
      return pressed;
    };
    const was = (name: string) => this.held.has(name) && !this.spent.has(name);
    // every input's edge, whichever mode uses it
    const edge = {
      lTrigger: hold('lTrigger', p.lTrigger),
      rTrigger: hold('rTrigger', p.rTrigger),
      lGrip: hold('lGrip', p.lGrip),
      rGrip: hold('rGrip', p.rGrip),
      lClick: hold('lClick', p.lClick),
      rClick: hold('rClick', p.rClick),
      a: hold('a', p.a),
      b: hold('b', p.b),
      x: hold('x', p.x),
      y: hold('y', p.y),
    };
    if (menuOpen) {
      for (const name of this.held) this.spent.add(name);
      intent.menuItem = deadZone(p.ly) || deadZone(p.ry);
      intent.menuValue = deadZone(p.lx) || deadZone(p.rx);
      if ((edge.lTrigger && !taken.trigger[0]) || (edge.rTrigger && !taken.trigger[1]) || edge.a) pulses.push('menu_enter');
      if (edge.b || edge.y) pulses.push('menu_abort');
      return { intent, commands, pulses };
    }
    // stick forward is negative y
    if (taken.lever !== null) intent.throttleSet = leverThrottle(taken.lever);
    else intent.throttleRate = -deadZone(p.ly) * THROTTLE_RATE;
    intent.legs = deadZone(p.lx);
    const [sx, sy] = taken.stick ?? [deadZone(p.rx), deadZone(p.ry)];
    intent.torsoPanRate = sx * TORSO_PAN_RATE;
    intent.torsoTiltRate = sy * TORSO_TILT_RATE;
    intent.fire = was('rTrigger') && !taken.trigger[1];
    intent.jets = was('lTrigger') && !taken.trigger[0];
    intent.fireGroup = was('rGrip') && !taken.grip[1];
    if (edge.lClick) commands.push(CMD.THROTTLE_STOP);
    if (edge.rClick) commands.push(CMD.FEET_TO_TORSO);
    if (edge.x) pulses.push('weapon_cycle');
    if (edge.y) commands.push(CMD.MAIN_MENU);
    if (edge.a) commands.push(CMD.TARGET_NEAREST_ENEMY);
    if (edge.b) commands.push(CMD.NEXT_TARGET);
    return { intent, commands, pulses };
  }

  /** Lets go of everything held. */
  reset(): void {
    this.held.clear();
    this.spent.clear();
  }
}
