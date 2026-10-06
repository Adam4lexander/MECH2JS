// The VR hands on the cockpit (render/cockpit/touch.ts): a fingertip presses a
// switch it comes down on, once, and lets go with hysteresis; a guarded
// switch's first press lifts its cover; a raised hand pointing at a switch out
// of reach presses it with the trigger, which the guns then don't get; a
// closed grip holds the throttle lever, with a stop at zero, and the stick.
import { describe, expect, it } from 'vitest';
import { PANELS, type ControlDef } from '../../src/render/cockpit/controls.ts';
import { CAP_HEIGHT, frameAt, type ControlSlot, type V3 } from '../../src/render/cockpit/kit.ts';
import { labelAtlas, CELL_H, CELL_W } from '../../src/render/cockpit/labelFont.ts';
import { COVER_OPEN, leverThrottle, throttleLever, Touch, type GrabPoint, type HandInput } from '../../src/render/cockpit/touch.ts';

const button: ControlDef = { id: 'b', label: 'B', action: { command: 1 } };
const guarded: ControlDef = { id: 'g', label: 'G', action: { command: 2 }, guarded: true };

/** a switch facing up (+y) at `c`, 3 cm by 2.4 */
const slot = (def: ControlDef, c: V3): ControlSlot => ({ def, f: frameAt(c, [0, 1, 0]), w: 0.03, h: 0.024 });

/** a hand at rest in the lap, its tip at `tip` */
const hand = (tip: V3, more: Partial<HandInput> = {}): HandInput => ({ tip, palm: [tip[0], tip[1], tip[2] + 0.1], rayFrom: tip, rayDir: [0, 0, -1], trigger: 0, grip: 0, ...more });

const at = (c: V3, height: number): V3 => [c[0], c[1] + height, c[2]];

describe('poking a switch', () => {
  const c: V3 = [0, -0.5, -0.3];
  const s = slot(button, c);

  it('presses once as the tip comes down past most of the travel, and lets go as it rises', () => {
    const t = new Touch();
    const step = (h: number) => t.update([null, hand(at(c, h))], [s], [], 0, 0);
    expect(step(0.03).pressed).toEqual([]);
    expect(step(0.03).looks.get('b')!.hover).toBe(true);
    // the cap follows the tip down
    expect(step(CAP_HEIGHT - 0.002).looks.get('b')!.depth).toBeCloseTo(0.002);
    expect(step(0.0035).pressed).toEqual([button]);
    // held down, or wobbling in the hysteresis, it doesn't press again
    expect(step(0.003).pressed).toEqual([]);
    expect(step(0.0045).pressed).toEqual([]);
    // up and down again: a second press
    expect(step(0.02).pressed).toEqual([]);
    expect(step(0.003).pressed).toEqual([button]);
  });

  it('keeps the cap down under the tip while it is pressed', () => {
    const t = new Touch();
    const step = (h: number) => t.update([null, hand(at(c, h))], [s], [], 0, 0);
    step(0.03);
    step(0.0035);
    expect(step(0.003).looks.get('b')!.depth).toBeCloseTo(CAP_HEIGHT - 0.003);
  });

  it('ticks once as the tip arrives over a cap, not every frame it stays', () => {
    const t = new Touch();
    const step = (h: number) => t.update([null, hand(at(c, h))], [s], [], 0, 0).haptics[1];
    expect(step(0.1)).toBe(0);
    expect(step(0.03)).toBeGreaterThan(0);
    expect(step(0.03)).toBe(0);
    expect(step(0.025)).toBe(0);
    expect(step(0.1)).toBe(0);
    expect(step(0.03)).toBeGreaterThan(0);
  });

  it("doesn't press from below or the side: the tip has to come onto the cap from above", () => {
    const t = new Touch();
    expect(t.update([null, hand([c[0] + 0.1, c[1] + 0.003, c[2]])], [s], [], 0, 0).pressed).toEqual([]);
    expect(t.update([null, hand(at(c, 0.003))], [s], [], 0, 0).pressed).toEqual([]);
  });

  it('lifts a cover with the first press, and presses the switch under it with the next', () => {
    const g = slot(guarded, c);
    const t = new Touch();
    const step = (h: number, now = 0) => t.update([hand(at(c, h)), null], [g], [], now, 0);
    step(0.03);
    let out = step(0.004);
    expect(out.pressed).toEqual([]);
    expect(out.looks.get('g')!.coverOpen).toBe(true);
    step(0.03);
    out = step(0.003);
    expect(out.pressed).toEqual([guarded]);
    expect(out.looks.get('g')!.coverOpen).toBe(false);
  });

  it('drops a lifted cover after a while', () => {
    const g = slot(guarded, c);
    const t = new Touch();
    t.update([hand(at(c, 0.03)), null], [g], [], 0, 0);
    t.update([hand(at(c, 0.004)), null], [g], [], 0, 0);
    expect(t.update([null, null], [g], [], COVER_OPEN - 0.1, 0).looks.get('g')!.coverOpen).toBe(true);
    expect(t.update([null, null], [g], [], COVER_OPEN + 0.1, 0).looks.get('g')!.coverOpen).toBe(false);
  });
});

describe('pointing at a switch out of reach', () => {
  const c: V3 = [0, -0.3, -0.8];
  const s: ControlSlot = { def: button, f: frameAt(c, [0, 0, 1]), w: 0.03, h: 0.024 };
  const raised = (trigger: number, y = -0.2): HandInput => ({ tip: [0, y, -0.3], palm: [0, y, -0.2], rayFrom: [0, y, -0.3], rayDir: norm([0, -0.3 - y, -0.5]), trigger, grip: 0 });

  it('shows the ray, and the trigger presses the switch and is taken from the guns', () => {
    const t = new Touch();
    let out = t.update([null, raised(0)], [s], [], 0, 0);
    expect(out.rays[1]).not.toBeNull();
    expect(out.looks.get('b')!.hover).toBe(true);
    out = t.update([null, raised(1)], [s], [], 0, 0);
    expect(out.pressed).toEqual([button]);
    expect(out.triggerTaken[1]).toBe(true);
    // held, it stays the switch's and doesn't press again
    out = t.update([null, raised(1)], [s], [], 0, 0);
    expect(out.pressed).toEqual([]);
    expect(out.triggerTaken[1]).toBe(true);
    expect(t.update([null, raised(0)], [s], [], 0, 0).triggerTaken[1]).toBe(false);
  });

  it('leaves a hand in the lap alone: it fires', () => {
    const t = new Touch();
    const out = t.update([null, raised(1, -0.55)], [s], [], 0, 0);
    expect(out.rays[1]).toBeNull();
    expect(out.pressed).toEqual([]);
    expect(out.triggerTaken[1]).toBe(false);
  });

  it("doesn't take a trigger already held when the ray came onto the switch", () => {
    const t = new Touch();
    t.update([null, { ...raised(1), rayDir: [0, 0, -1], rayFrom: [0.5, -0.2, -0.3] }], [s], [], 0, 0);
    expect(t.update([null, raised(1)], [s], [], 0, 0).pressed).toEqual([]);
  });
});

describe('holding the throttle and the stick', () => {
  const pivot: V3 = [-0.42, -0.5, -0.2];
  const knob: V3 = [-0.42, -0.32, -0.21];
  const grabs: GrabPoint[] = [{ name: 'throttle', knob, pivot }];
  /** the palm at `lean` radians forward round the pivot, at the knob's height */
  const palmAt = (lean: number): V3 => [pivot[0], pivot[1] + 0.18 * Math.cos(lean), pivot[2] - 0.18 * Math.sin(lean)];

  it('takes hold with the grip near the knob and follows the hand round the pivot, from where the lever was', () => {
    const t = new Touch();
    let out = t.update([hand(knob, { palm: palmAt(0), grip: 1 }), null], [], grabs, 0, 0.5);
    expect(out.gripTaken[0]).toBe(true);
    expect(out.lever).toBeCloseTo(0.5);
    out = t.update([hand(knob, { palm: palmAt(0.45 * 0.25), grip: 1 }), null], [], grabs, 0, 0.5);
    expect(out.lever).toBeCloseTo(0.75);
    out = t.update([hand(knob, { palm: palmAt(1), grip: 1 }), null], [], grabs, 0, 0.5);
    expect(out.lever).toBe(1);
    out = t.update([hand(knob, { palm: palmAt(1), grip: 0 }), null], [], grabs, 0, 0.5);
    expect(out.lever).toBeNull();
    expect(out.gripTaken[0]).toBe(false);
  });

  it('sits at the stop near zero, and reaches full reverse half back', () => {
    const t = new Touch();
    t.update([hand(knob, { palm: palmAt(0), grip: 1 }), null], [], grabs, 0, 0);
    expect(t.update([hand(knob, { palm: palmAt(0.01), grip: 1 }), null], [], grabs, 0, 0).lever).toBe(0);
    expect(t.update([hand(knob, { palm: palmAt(-1), grip: 1 }), null], [], grabs, 0, 0).lever).toBe(-0.5);
    expect(leverThrottle(-0.5)).toBe(-1);
    expect(throttleLever(-1)).toBe(-0.5);
    expect(leverThrottle(throttleLever(0.3))).toBeCloseTo(0.3);
  });

  it("doesn't take hold from afar", () => {
    const t = new Touch();
    expect(t.update([hand(knob, { palm: [0.3, 0, -0.3], grip: 1 }), null], [], grabs, 0, 0).gripTaken[0]).toBe(false);
  });

  it('deflects the stick with the hand', () => {
    const stick: GrabPoint[] = [{ name: 'stick', knob: [0.42, -0.25, -0.19], pivot: [0.42, -0.5, -0.18] }];
    const t = new Touch();
    t.update([null, hand([0, 0, 0], { palm: [0.42, -0.25, -0.19], grip: 1 })], [], stick, 0, 0);
    const out = t.update([null, hand([0, 0, 0], { palm: [0.42 + 0.035, -0.25, -0.19 - 0.1], grip: 1 })], [], stick, 0, 0);
    expect(out.stick![0]).toBeCloseTo(0.5);
    expect(out.stick![1]).toBe(-1);
  });
});

describe('switch labels', () => {
  it('fit every label in its cell, and ink every character', () => {
    const labels = Object.values(PANELS).flatMap((p) => p.map((d) => d.label));
    for (const l of labels) expect(l.length, l).toBeLessThanOrEqual(4);
    const a = labelAtlas(labels);
    expect(a.width).toBe(CELL_W);
    for (const l of labels) {
      const [x, y, w, h] = a.cells.get(l)!;
      let ink = 0;
      for (let r = y; r < y + h; r++) for (let q = x; q < x + w; q++) ink += a.data[r * a.width + q]! ? 1 : 0;
      expect(h).toBe(CELL_H);
      // every character has a few pixels of ink: none fell back to a blank
      expect(ink, l).toBeGreaterThan(l.replace(/ /g, '').length * 5);
    }
  });

  it('gives every switch a unique id', () => {
    const ids = Object.values(PANELS).flatMap((p) => p.map((d) => d.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function norm(v: V3): V3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}
