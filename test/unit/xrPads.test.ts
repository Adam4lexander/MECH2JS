// The VR controllers' mapping onto the pilot's intent (app/xrPads.ts): the
// sticks proportional past their dead zone, a press's command once, the guns
// and jets held with hysteresis, the cockpit's claims on a trigger, a grip,
// the lever and the stick, and the sticks moving through a menu.
import { describe, expect, it } from 'vitest';
import { CMD } from '../../src/render/cockpit/controls.ts';
import { deadZone, IDLE_PAD, NOTHING_TAKEN, PadMapper, THROTTLE_RATE, TORSO_PAN_RATE, TORSO_TILT_RATE, type PadState } from '../../src/app/xrPads.ts';

const pad = (p: Partial<PadState>): PadState => ({ ...IDLE_PAD, ...p });

describe('PadMapper', () => {
  it('moves the throttle at a rate with the left stick, forward up', () => {
    const m = new PadMapper();
    expect(m.update(pad({ ly: -1 }), false).intent.throttleRate).toBeCloseTo(THROTTLE_RATE);
    expect(m.update(pad({ ly: 1 }), false).intent.throttleRate).toBeCloseTo(-THROTTLE_RATE);
    expect(m.update(pad({ ly: 0.05 }), false).intent.throttleRate).toBeCloseTo(0);
    expect(m.update(pad({}), false).intent.throttleSet).toBeNull();
  });

  it('turns the legs in proportion past the dead zone', () => {
    const m = new PadMapper();
    expect(m.update(pad({ lx: 1 }), false).intent.legs).toBeCloseTo(1);
    expect(m.update(pad({ lx: -0.56 }), false).intent.legs).toBeCloseTo(deadZone(-0.56));
    expect(deadZone(0.1)).toBe(0);
    expect(deadZone(-0.56)).toBeCloseTo(-0.5);
  });

  it('turns and pitches the torso at a rate with the right stick', () => {
    const m = new PadMapper();
    const i = m.update(pad({ rx: 1, ry: -1 }), false).intent;
    expect(i.torsoPanRate).toBeCloseTo(TORSO_PAN_RATE);
    expect(i.torsoTiltRate).toBeCloseTo(-TORSO_TILT_RATE);
    // at rest: nothing moves it, so it holds
    expect(m.update(pad({}), false).intent.torsoPanRate).toBe(0);
  });

  it('holds the guns with hysteresis between the press and release thresholds', () => {
    const m = new PadMapper();
    expect(m.update(pad({ rTrigger: 0.5 }), false).intent.fire).toBe(false);
    expect(m.update(pad({ rTrigger: 0.7 }), false).intent.fire).toBe(true);
    expect(m.update(pad({ rTrigger: 0.5 }), false).intent.fire).toBe(true);
    expect(m.update(pad({ rTrigger: 0.3 }), false).intent.fire).toBe(false);
    expect(m.update(pad({ lTrigger: 1 }), false).intent.jets).toBe(true);
    expect(m.update(pad({ rGrip: 1 }), false).intent.fireGroup).toBe(true);
  });

  it('sends a button press once', () => {
    const m = new PadMapper();
    expect(m.update(pad({ a: true }), false).commands).toEqual([CMD.TARGET_NEAREST_ENEMY]);
    expect(m.update(pad({ a: true }), false).commands).toEqual([]);
    expect(m.update(pad({}), false).commands).toEqual([]);
    expect(m.update(pad({ b: true, rClick: true, lClick: true }), false).commands.sort()).toEqual([CMD.THROTTLE_STOP, CMD.FEET_TO_TORSO, CMD.NEXT_TARGET].sort());
    expect(m.update(pad({ x: true }), false).pulses).toEqual(['weapon_cycle']);
    expect(m.update(pad({ y: true }), false).commands).toEqual([CMD.MAIN_MENU]);
  });

  it("leaves the cockpit what it took: a trigger on a switch, a grip on a part, the lever and the stick", () => {
    const m = new PadMapper();
    const out = m.update(pad({ rTrigger: 1, lTrigger: 1, rGrip: 1, ly: -1, rx: 1 }), false, { trigger: [true, true], grip: [false, true], lever: -0.25, stick: [0.5, -1] });
    expect(out.intent.fire).toBe(false);
    expect(out.intent.jets).toBe(false);
    expect(out.intent.fireGroup).toBe(false);
    // the lever outright, a quarter back: half reverse
    expect(out.intent.throttleSet).toBeCloseTo(-0.5);
    expect(out.intent.throttleRate).toBe(0);
    expect(out.intent.torsoPanRate).toBeCloseTo(0.5 * TORSO_PAN_RATE);
    expect(out.intent.torsoTiltRate).toBeCloseTo(-TORSO_TILT_RATE);
  });

  it('moves through a menu with the sticks, picks with a trigger, backs out with B', () => {
    const m = new PadMapper();
    const out = m.update(pad({ ly: -1, rTrigger: 1 }), true);
    expect(out.intent.menuItem).toBeCloseTo(-1);
    expect(out.intent.throttleRate).toBe(0);
    expect(out.intent.fire).toBe(false);
    expect(out.pulses).toEqual(['menu_enter']);
    expect(m.update(pad({ b: true }), true).pulses).toEqual(['menu_abort']);
    expect(m.update(pad({ b: true }), true).pulses).toEqual([]);
    expect(m.update(pad({ a: true }), true, NOTHING_TAKEN).commands).toEqual([]);
  });

  it("doesn't fire with the trigger that picked a menu item, after the menu closes, until it is let go", () => {
    const m = new PadMapper();
    expect(m.update(pad({ rTrigger: 1 }), true).pulses).toEqual(['menu_enter']);
    // the menu is gone, the trigger still held
    expect(m.update(pad({ rTrigger: 1 }), false).intent.fire).toBe(false);
    expect(m.update(pad({}), false).intent.fire).toBe(false);
    expect(m.update(pad({ rTrigger: 1 }), false).intent.fire).toBe(true);
  });

  it('forgets what it held on reset', () => {
    const m = new PadMapper();
    m.update(pad({ a: true }), false);
    m.reset();
    expect(m.update(pad({ a: true }), false).commands).toEqual([CMD.TARGET_NEAREST_ENEMY]);
  });
});
