/**
 * The VR hands on the cockpit's switches and levers: which switch a
 * fingertip presses, which one a pointing hand picks out of reach, and the
 * throttle lever and stick in a closed hand. Pure - pilot space in, presses
 * and looks out - so the unit tests reach it; app/xrInput.ts feeds it the
 * controllers and cockpit.ts draws what it says.
 *
 *   POKE   a fingertip that comes down onto a cap from above presses it once
 *          it has pushed the cap most of its travel in, and lets go as it
 *          comes back up (the hysteresis between); the cap follows the tip.
 *          It presses again only once the tip has come up clear of the cap,
 *          so a tracked hand's jitter never presses twice
 *   RAY    a raised hand pointing at a switch it can't reach picks it out
 *          (the ray shows), and a fresh pull of the trigger presses it - that
 *          pull is the switch's, not the guns'
 *   COVER  a guarded switch's first press flips its cover up; the next press,
 *          while it is up, is the switch's, and shuts the cover again. The
 *          cover drops by itself after COVER_OPEN seconds
 *   GRAB   the grip closed near the throttle's or the stick's knob holds it
 *          until the grip opens: the throttle follows the hand round its
 *          pivot, with a stop at zero; the stick deflects with the hand
 *
 * @portOnly the VR controls
 */
import type { ControlDef } from './controls.ts';
import { add, CAP_HEIGHT, CAP_TRAVEL, dot, scale, sub, type ControlSlot, type V3 } from './kit.ts';

export interface HandInput {
  /** the fingertip, pilot space */
  tip: V3;
  /** the palm (the grip pose), pilot space */
  palm: V3;
  /** the pointing ray: where it starts and its unit direction, pilot space */
  rayFrom: V3;
  rayDir: V3;
  trigger: number;
  grip: number;
}

export type GrabName = 'throttle' | 'stick';

/** A part a hand can hold: its knob where it stands now, and its pivot (pilot space). */
export interface GrabPoint {
  name: GrabName;
  knob: V3;
  pivot: V3;
}

/** How a switch looks this frame. */
export interface ControlLook {
  /** how far in the cap is pushed, metres (0..CAP_TRAVEL) */
  depth: number;
  hover: boolean;
  coverOpen: boolean;
}

export interface TouchOutput {
  /** the switches pressed this frame */
  pressed: ControlDef[];
  looks: Map<string, ControlLook>;
  /** per hand (left, right): its trigger is a switch's, not the guns' */
  triggerTaken: [boolean, boolean];
  /** per hand: its grip holds a part */
  gripTaken: [boolean, boolean];
  /** per hand: the ray to a switch picked out of reach */
  rays: [{ from: V3; to: V3 } | null, { from: V3; to: V3 } | null];
  /** per hand: a haptic pulse's strength this frame (0: none) */
  haptics: [number, number];
  /** the throttle lever as held: -0.5 (full reverse, drawn half back as the gauge does) ..1; null while nobody holds it */
  lever: number | null;
  /** the stick's deflection as held, [right, back] -1..1 (a thumbstick's axes: forward negative); null while nobody holds it */
  stick: [number, number] | null;
}

/** a press goes in at this depth into the cap's travel, and lets go above that */
const PRESS_AT = CAP_HEIGHT - CAP_TRAVEL * 0.7;
const RELEASE_AT = CAP_HEIGHT - CAP_TRAVEL * 0.25;
/** the footprint's margin round a cap, metres */
const MARGIN = 0.006;
/** a tip this close over a cap is hovering */
const HOVER = 0.05;
/** a cover stands this high over its switch while shut */
export const COVER_HEIGHT = 0.016;
/** seconds a cover stays up */
export const COVER_OPEN = 4;
/** a switch further than this from the fingertip is out of reach (the ray's), metres */
const REACH = 0.15;
/** the furthest the ray picks a switch out, metres */
const RAY_RANGE = 1.6;
/** the ray only picks out a switch it meets within this angle of square on */
const RAY_FACING = Math.cos((75 * Math.PI) / 180);
/** a hand must be held above this (pilot space y, metres: armrests are about -0.5) to point */
const RAISED = -0.38;
/** analogue buttons press at PRESS and let go below RELEASE */
const PRESS = 0.6;
const RELEASE = 0.35;
/** a grip closes on a knob this close to the palm, metres */
const GRAB_RADIUS = 0.11;
/** the lever's swing for full travel, radians (cockpit.ts draws it 0.45 forward at full) */
const LEVER_SWING = 0.45;
/** the throttle's stop: a lever this near zero sits at it */
const STOP = 0.05;
/** the hand's travel for the stick's full deflection, metres */
const STICK_THROW = 0.07;

interface HandState {
  /** the switch the tip is pushing, if it pressed it */
  down: string | null;
  /** switches the tip came onto from above, and may press */
  armed: Set<string>;
  /** switches the tip hovered over last frame */
  hovered: Set<string>;
  triggerDown: boolean;
  /** a trigger pull that went to a switch, until it lets go */
  triggerTaken: boolean;
  gripDown: boolean;
  held: { name: GrabName; palm0: V3; angle0: number; value0: number } | null;
  /** the switch the ray picked out last frame */
  aimed: string | null;
}

const newHand = (): HandState => ({ down: null, armed: new Set(), hovered: new Set(), triggerDown: false, triggerTaken: false, gripDown: false, held: null, aimed: null });

/** A point's place in a cap's frame: across, up and out from its foot. */
function local(s: ControlSlot, p: V3): [number, number, number] {
  const d = sub(p, s.f.c);
  return [dot(d, s.f.r), dot(d, s.f.u), dot(d, s.f.n)];
}

const inside = (s: ControlSlot, x: number, y: number, m = MARGIN) => Math.abs(x) <= s.w / 2 + m && Math.abs(y) <= s.h / 2 + m;

export class Touch {
  private readonly hands: [HandState, HandState] = [newHand(), newHand()];
  /** guarded switches whose covers are up, and when they drop (seconds) */
  private readonly covers = new Map<string, number>();
  /** the lever as last held, and whether it sat at the stop */
  private lever: number | null = null;
  private atStop = false;

  /**
   * One frame: `hands` the left and right (null: not tracked), `controls`
   * the cockpit's switches and `grabs` its holdable parts as they stand,
   * `now` seconds. `lever` is the throttle lever as the sim has it now, for
   * a hand that takes hold of it.
   */
  update(hands: [HandInput | null, HandInput | null], controls: readonly ControlSlot[], grabs: readonly GrabPoint[], now: number, lever: number): TouchOutput {
    const out: TouchOutput = { pressed: [], looks: new Map(), triggerTaken: [false, false], gripTaken: [false, false], rays: [null, null], haptics: [0, 0], lever: null, stick: null };
    for (const [id, until] of this.covers) if (until <= now) this.covers.delete(id);
    const look = (id: string): ControlLook => {
      let l = out.looks.get(id);
      if (!l) out.looks.set(id, (l = { depth: 0, hover: false, coverOpen: this.covers.has(id) }));
      return l;
    };
    for (const s of controls) look(s.def.id);
    /** Presses a switch, or lifts its cover. */
    const press = (s: ControlSlot, h: number): void => {
      const id = s.def.id;
      out.haptics[h] = Math.max(out.haptics[h]!, 0.5);
      if (s.def.guarded && !this.covers.has(id)) {
        this.covers.set(id, now + COVER_OPEN);
        look(id).coverOpen = true;
        return;
      }
      if (s.def.guarded) {
        this.covers.delete(id);
        look(id).coverOpen = false;
      }
      out.pressed.push(s.def);
    };

    hands.forEach((hand, h) => {
      const st = this.hands[h]!;
      if (!hand) {
        this.hands[h] = newHand();
        return;
      }
      // poke: the cap under the fingertip
      let near = Infinity;
      const hovered = new Set<string>();
      for (const s of controls) {
        const id = s.def.id;
        const [x, y, z] = local(s, hand.tip);
        near = Math.min(near, Math.hypot(...sub(hand.tip, s.f.c)));
        const top = s.def.guarded && !this.covers.has(id) ? COVER_HEIGHT : CAP_HEIGHT;
        if (!inside(s, x, y)) {
          st.armed.delete(id);
          if (st.down === id) st.down = null;
          continue;
        }
        if (z > top) st.armed.add(id);
        if (z < HOVER) {
          // a tick as the tip arrives over a cap, not every frame it stays
          if (!st.hovered.has(id) && z > top) out.haptics[h] = Math.max(out.haptics[h]!, 0.08);
          hovered.add(id);
          look(id).hover = true;
        }
        // the cap follows the tip down, and stays down under it while pressed
        if (top === CAP_HEIGHT && (st.armed.has(id) || st.down === id)) look(id).depth = Math.max(look(id).depth, Math.min(CAP_TRAVEL, Math.max(0, CAP_HEIGHT - z)));
        if (st.down === id) {
          if (z > RELEASE_AT) st.down = null;
        } else if (st.down === null && st.armed.has(id) && z < (top === CAP_HEIGHT ? PRESS_AT : COVER_HEIGHT - CAP_TRAVEL)) {
          st.down = id;
          press(s, h);
          // the tip comes up clear of the cap (or out of the cover it lifted) before pressing again: a
          // tracked hand's jitter never presses twice
          st.armed.delete(id);
        }
      }
      st.hovered = hovered;

      // the trigger
      const trig = st.triggerDown ? hand.trigger > RELEASE : hand.trigger > PRESS;
      const pulled = trig && !st.triggerDown;
      st.triggerDown = trig;
      if (!trig) st.triggerTaken = false;

      // ray: a raised hand, every switch out of reach, pointing square enough at one
      let aimed: ControlSlot | null = null;
      let aimedAt: V3 | null = null;
      if (near > REACH && hand.palm[1] > RAISED && !st.held) {
        let best = RAY_RANGE;
        for (const s of controls) {
          const den = dot(hand.rayDir, s.f.n);
          if (den > -RAY_FACING) continue;
          const t = dot(sub(s.f.c, hand.rayFrom), s.f.n) / den;
          if (t <= 0 || t >= best) continue;
          const p = add(hand.rayFrom, scale(hand.rayDir, t));
          const [x, y] = local(s, p);
          if (!inside(s, x, y, MARGIN * 2)) continue;
          best = t;
          aimed = s;
          aimedAt = p;
        }
      }
      if (aimed && aimedAt) {
        out.rays[h] = { from: hand.rayFrom, to: aimedAt };
        look(aimed.def.id).hover = true;
        if (st.aimed !== aimed.def.id) out.haptics[h] = Math.max(out.haptics[h]!, 0.08);
        if (pulled) {
          st.triggerTaken = true;
          press(aimed, h);
        }
      }
      st.aimed = aimed?.def.id ?? null;
      out.triggerTaken[h] = st.triggerTaken;

      // grab
      const grip = st.gripDown ? hand.grip > RELEASE : hand.grip > PRESS;
      const closed = grip && !st.gripDown;
      st.gripDown = grip;
      if (!grip) st.held = null;
      if (closed && !st.held) {
        const other = this.hands[1 - h]!.held?.name;
        let best = GRAB_RADIUS;
        for (const g of grabs) {
          const d = Math.hypot(...sub(hand.palm, g.knob));
          if (g.name === other || d >= best) continue;
          best = d;
          st.held = { name: g.name, palm0: hand.palm, angle0: leverAngle(hand.palm, g.pivot), value0: g.name === 'throttle' ? lever : 0 };
        }
        if (st.held) out.haptics[h] = Math.max(out.haptics[h]!, 0.4);
      }
      if (st.held) {
        out.gripTaken[h] = true;
        const g = grabs.find((q) => q.name === st.held!.name);
        if (st.held.name === 'throttle' && g) {
          let v = Math.max(-0.5, Math.min(1, st.held.value0 + (leverAngle(hand.palm, g.pivot) - st.held.angle0) / LEVER_SWING));
          const stop = Math.abs(v) < STOP;
          if (stop) v = 0;
          if (stop !== this.atStop || (this.lever !== null && (v === 1 || v === -0.5) && v !== this.lever)) out.haptics[h] = Math.max(out.haptics[h]!, 0.3);
          this.atStop = stop;
          this.lever = v;
          out.lever = v;
        } else if (st.held.name === 'stick') {
          const d = sub(hand.palm, st.held.palm0);
          const k = (v: number) => Math.max(-1, Math.min(1, v / STICK_THROW));
          out.stick = [k(d[0]), k(d[2])];
        }
      }
    });
    if (out.lever === null) this.lever = null;
    return out;
  }
}

/** The lever's lean towards the hand round its pivot: radians forward of upright, in the y-z plane. */
function leverAngle(palm: V3, pivot: V3): number {
  const d = sub(palm, pivot);
  return Math.atan2(-d[2], d[1]);
}

/** The throttle a lever position asks for: forward 0..1, and back to -0.5 for full reverse (-1). */
export function leverThrottle(lever: number): number {
  return lever >= 0 ? lever : lever / 0.5;
}

/** The lever position for a throttle (-1..1, negative reverse): the inverse of leverThrottle. */
export function throttleLever(throttle: number): number {
  return throttle >= 0 ? throttle : throttle * 0.5;
}
