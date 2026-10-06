/**
 * The VR controllers as the pilot's hands. Each display frame:
 *
 *  1. the controllers' sticks, triggers, grips and buttons, and where the
 *     hands are (the grip and pointing poses, in the rig's 'local' space -
 *     the space the head is tracked in - moved into the cockpit's pilot
 *     space by the seat's height);
 *  2. the cockpit's switches and levers under them (render/cockpit/
 *     touch.ts): a press, a hand on the throttle or the stick, and the
 *     trigger or grip each takes for itself;
 *  3. the rest mapped onto the pilot's intent (xrPads.ts), which the sim
 *     applies at its next pass (sim/controls/pilotIntent.ts).
 *
 * The keyboard and mouse still work alongside. Recentring the view is the
 * headset's own (the 'local' reference space follows the system's
 * recentre).
 *
 * @portOnly the VR controls
 */
import * as THREE from 'three';
import type { ControlDef } from '../render/cockpit/controls.ts';
import type { CockpitLook, HandLook } from '../render/cockpit/cockpit.ts';
import type { ControlSlot, V3 } from '../render/cockpit/kit.ts';
import { Touch, type GrabPoint, type HandInput, type TouchOutput } from '../render/cockpit/touch.ts';
import { pilot, pilotCommand, pilotMenuOpen, pilotPulse, pilotRelease } from '../sim/controls/pilotIntent.ts';
import { IDLE_PAD, PadMapper, type PadState, type PadTaken } from './xrPads.ts';

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

/** The cockpit as the hands find it: its switches and holdable parts, pilot space. */
export interface CockpitReach {
  controls: readonly ControlSlot[];
  grabs: readonly GrabPoint[];
  /** how far pilot space stands above the rig's (the seat slider, xrSettings dashDrop) */
  seatLift: number;
  /** the throttle lever where the sim has it now (touch.ts throttleLever) */
  lever: number;
}

/** the fingertip, in the pointing pose: a little ahead of where the ray starts */
const TIP = new THREE.Vector3(0, 0, -0.02);

/** Sends a switch's press: its command, or its channel for a pass. */
function sendPress(d: ControlDef): void {
  if ('command' in d.action) pilotCommand(d.action.command);
  else pilotPulse(d.action.channel);
}

export class XrInput {
  private readonly mapper = new PadMapper();
  private touch = new Touch();
  private hands: [HandLook | null, HandLook | null] = [null, null];
  private touched: TouchOutput | null = null;
  /** whether anything is held to let go of (the editor sits in Edit for many frames) */
  private live = false;

  /**
   * One display frame: `active` while a mission plays; `frame` and `space`
   * the frame's XRFrame and the rig's reference space, for the hands;
   * `reach` the cockpit (null: none shown); `now` in seconds.
   */
  poll(session: XRSession, active: boolean, frame: XRFrame | null, space: XRReferenceSpace | null, reach: CockpitReach | null, now: number): void {
    if (!active) {
      if (this.live) this.release();
      return;
    }
    this.live = true;
    const inputs = this.readHands(session, frame, space, reach?.seatLift ?? 0);
    const t = (this.touched = this.touch.update(inputs, reach?.controls ?? [], reach?.grabs ?? [], now, reach?.lever ?? 0));
    for (const d of t.pressed) sendPress(d);
    this.hands.forEach((hand, i) => {
      if (hand) hand.ray = t.rays[i] ?? null;
    });
    this.pulse(session, t.haptics);
    const taken: PadTaken = { trigger: t.triggerTaken, grip: t.gripTaken, lever: t.lever, stick: t.stick };
    const out = this.mapper.update(readPads(session), pilotMenuOpen(), taken);
    pilot.active = true;
    pilot.intent = out.intent;
    for (const c of out.commands) pilotCommand(c);
    for (const p of out.pulses) pilotPulse(p);
  }

  /** The switches and hands for the cockpit to draw this frame, its lamps `lit`. */
  look(lit: ReadonlySet<string>): CockpitLook {
    return { controls: this.touched?.looks ?? new Map(), lit, hands: this.hands };
  }

  /** The throttle lever as a hand holds it (touch.ts lever), or null. */
  get heldLever(): number | null {
    return this.touched?.lever ?? null;
  }

  /** The stick as a hand holds it, [right, back], or null. */
  get heldStick(): [number, number] | null {
    return this.touched?.stick ?? null;
  }

  release(): void {
    this.live = false;
    this.mapper.reset();
    // covers drop and hands let go: the next session starts clean
    this.touch = new Touch();
    this.hands = [null, null];
    this.touched = null;
    pilotRelease();
  }

  /** Each hand's grip and pointing poses, pilot space; also kept for drawing (hands). */
  private readHands(session: XRSession, frame: XRFrame | null, space: XRReferenceSpace | null, lift: number): [HandInput | null, HandInput | null] {
    const out: [HandInput | null, HandInput | null] = [null, null];
    this.hands = [null, null];
    if (!frame || !space) return out;
    const up = new THREE.Matrix4().makeTranslation(0, lift, 0);
    const v = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];
    for (const src of session.inputSources) {
      if ((src.handedness !== 'left' && src.handedness !== 'right') || !src.gripSpace) continue;
      const h = src.handedness === 'left' ? 0 : 1;
      const grip = frame.getPose(src.gripSpace, space);
      const ray = frame.getPose(src.targetRaySpace, space);
      if (!grip || !ray) continue;
      const g = up.clone().multiply(new THREE.Matrix4().fromArray(grip.transform.matrix));
      const r = up.clone().multiply(new THREE.Matrix4().fromArray(ray.transform.matrix));
      const from = new THREE.Vector3().setFromMatrixPosition(r);
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(r);
      const tip = TIP.clone().applyMatrix4(r);
      const pad = src.gamepad;
      out[h] = { tip: v(tip), palm: v(new THREE.Vector3().setFromMatrixPosition(g)), rayFrom: v(from), rayDir: v(dir), trigger: pad?.buttons[0]?.value ?? 0, grip: pad?.buttons[1]?.value ?? 0 };
      this.hands[h] = { grip: g, tip: v(tip), ray: null };
    }
    return out;
  }

  /** Rumbles each hand that touched something (haptic actuators, where there are any). */
  private pulse(session: XRSession, strength: readonly number[]): void {
    for (const src of session.inputSources) {
      const h = src.handedness === 'left' ? 0 : src.handedness === 'right' ? 1 : -1;
      const s = h < 0 ? 0 : (strength[h] ?? 0);
      if (s <= 0) continue;
      const act = (src.gamepad as (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, ms: number) => Promise<boolean> }> }) | undefined)?.hapticActuators?.[0];
      act?.pulse?.(s, 25)?.catch(() => {});
    }
  }
}
