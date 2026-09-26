/**
 * The status widgets 16..21 (autopilot, speed, MASC, heat, heat rate, jets)
 * and their gauges.
 *
 * Each gauge smooths its value through a lowpass record {current, target,
 * shift} (lowpass_step) and draws with two bar painters: hud_draw_bar, a
 * horizontal bar shaded top to bottom colour - 1, colour, colour - 1,
 * colour - 2 by quarters of its height, and hud_draw_bar_vertical (in
 * damageDisplay.ts), the same standing upward. Where the bars go is
 * damageDisplay.gaugeLayout (0x96888..0x968d4): 16.16 fractions of each
 * widget's pane in the image, pixels once hud_gauge_layout_init has run
 * (hud_widgets_install). Its entries, by index: [0] [1] the throttle bar's
 * width and length, [2..5] the throttle frame {x0, y0, x1, y1}, [6] [7] the
 * throttle bar's x and base y, [8] [9] / [10] [11] the heat bar's {x, y} /
 * {length, height}, [12..15] the heat-rate bar's, [16..19] the jump-jet bar's.
 *
 * Every draw call here passes its pane, position and length in registers,
 * which the decompiled C drops; the arguments are read from the disassembly.
 */
import type { HudWidget, MechLoadout, ViewWindow } from '../../generated/classes.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { lowpassStep } from '../../core/ramp.ts';
import { clock } from '../../engine/clock.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32s } from '../../engine/image.ts';
import { vfxLineDraw, vfxStringDraw } from '../../engine/vfx/vfx.ts';
import { display } from '../display/video.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { damageDisplay, damageSub031520 } from './damageDisplay.ts';
import { hudFont, hudFontUnlock, widgetPane } from './hud.ts';

const lowpass = (addr: number): Int32Array => Int32Array.from(imageI32s(addr, 3, [0, 0, 1]));

function bootGauges() {
  return {
    /** 0x96858: the heat gauge's lowpass {current, target, shift}; shift 1 in the image */
    heatLowpass: lowpass(0x96858),
    /** 0x96864: the throttle gauge's lowpass; shift 1 */
    throttleLowpass: lowpass(0x96864),
    /** 0x96870: the heat-rate gauge's lowpass; shift 4 */
    heatRateLowpass: lowpass(0x96870),
    /** 0x9687c: the jump-jet gauge's lowpass; shift 1 */
    jetsLowpass: lowpass(0x9687c),
  };
}

/** The gauges' smoothing state (0x96858..0x96884); their layout is damageDisplay.gaugeLayout. */
export const gauges = registerGlobals('gauges', bootGauges(), () => {
  Object.assign(gauges, bootGauges());
});

const playerLoadout = (): MechLoadout => mechs.mechTable[mechs.playerMechIndex]!.loadout!;

/**
 * A horizontal bar: `length + 1` pixels from x, `height` rows from y, the
 * rows shaded by quarters colour - 1, colour, colour - 1, colour - 2
 * (the first quarter is height / 2 / 2 rows, the second up to height / 2, the
 * third up to height / 2 + (height - height / 2) / 2). Nothing for a length
 * of 0 or less. Arguments (pane EAX, x EDX, y EBX, length ECX, then height
 * and colour on the stack; ret 8), from the disassembly 0x31670..0x317a1.
 *
 * @mw2 hud_draw_bar 0x00031670
 * @fidelity exact
 */
export function hudDrawBar(pane: ViewWindow, x: number, y: number, length: number, height: number, colour: number): void {
  let half = cdiv(height, 2);
  let q = cdiv(half, 2);
  const x1 = (x + length) | 0;
  if (length <= 0) return;
  for (let i = 0; i < q; i++) vfxLineDraw(pane, x, (y + i) | 0, x1, (y + i) | 0, 0, (colour - 1) | 0);
  for (; q < half; q++) vfxLineDraw(pane, x, (y + q) | 0, x1, (y + q) | 0, 0, colour);
  const third = (half + cdiv((height - half) | 0, 2)) | 0;
  for (; half < third; half++) vfxLineDraw(pane, x, (y + half) | 0, x1, (y + half) | 0, 0, (colour - 1) | 0);
  half = third;
  for (; half < height; half++) vfxLineDraw(pane, x, (y + half) | 0, x1, (y + half) | 0, 0, (colour - 2) | 0);
}

/** (int64)a * b / d, the low 32 bits - imul then idiv. */
function mulDiv(a: number, b: number, d: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a | 0) * BigInt(b | 0)) / BigInt(d | 0)));
}

/**
 * The heat bar in widget 19: heatLevel * length / 100, smoothed, drawn as
 * the whole bar in 0xb once it reaches the length, in 7 at 0 or below, and
 * otherwise as three bars - colour 3 at both ends, edi wide, around a middle
 * of length - 2 * edi in 7 while the level is under half the length (edi =
 * the level) and in 0xb from there (edi = length - level). The pane comes in
 * EAX; read from the disassembly 0x310b0..0x311e3, which the C shows wrongly.
 *
 * @mw2 hud_gauge_heat 0x000310b0
 * @fidelity exact
 */
export function hudGaugeHeat(pane: ViewWindow): void {
  const g = gauges;
  const L = damageDisplay.gaugeLayout;
  const x = L[8]!;
  const y = L[9]!;
  const len = L[10]!;
  const h1 = (L[11]! - 1) | 0;
  g.heatLowpass[1] = mulDiv(playerLoadout().heatLevel, len, 100);
  const v = lowpassStep(g.heatLowpass) >> 16;
  if (v >= len) {
    hudDrawBar(pane, x, y, len, h1, 0xb);
    return;
  }
  if (v <= 0) {
    hudDrawBar(pane, x, y, len, h1, 7);
    return;
  }
  let edi: number;
  let colour: number;
  if (v < len >> 1) {
    edi = v;
    colour = 7;
  } else {
    edi = (len - v) | 0;
    colour = 0xb;
  }
  const mid = (len - edi * 2) | 0;
  const midX = (x + edi + 1) | 0;
  hudDrawBar(pane, x, y, edi, h1, 3);
  hudDrawBar(pane, midX, y, mid, h1, colour);
  hudDrawBar(pane, (midX + mid) | 0, y, edi, h1, 3);
}

/**
 * The heat-rate bar in widget 20: (heatThisTick - heatDissipation *
 * tickDelta) >> 6, smoothed. Below 1 the bar is empty (rest in 7); below
 * 0x300 it fills in 3 over 7; from 0x300 it wraps once, filling
 * value - 0x300 in 0xb over 3. The fill is length * value / 0x300, clamped
 * to 0..length. From the disassembly 0x311f0..0x312f7.
 *
 * @mw2 hud_gauge_heat_rate 0x000311f0
 * @fidelity exact
 */
export function hudGaugeHeatRate(pane: ViewWindow): void {
  const g = gauges;
  const L = damageDisplay.gaugeLayout;
  const l = playerLoadout();
  g.heatRateLowpass[1] = ((l.heatThisTick - Math.imul(l.heatDissipation, clock.tickDelta)) | 0) >> 6;
  let v = lowpassStep(g.heatRateLowpass);
  let fill: number;
  let rest: number;
  if (v < 1) {
    fill = 7;
    rest = 7;
    v = 0;
  } else if (v < 0x300) {
    fill = 3;
    rest = 7;
  } else {
    fill = 0xb;
    rest = 3;
    v = (v - 0x300) | 0;
  }
  const len = L[14]!;
  let n = 0;
  if (v > 0) {
    n = mulDiv(len, v, 0x300);
    if (n < 0) n = 0;
    else if (n > len) n = len;
  }
  const x = L[12]!;
  const y = L[13]!;
  const h1 = (L[15]! - 1) | 0;
  if (n > 0) hudDrawBar(pane, x, y, n, h1, fill);
  if (n < len) hudDrawBar(pane, (x + n) | 0, y, (len - n) | 0, h1, rest);
}

/**
 * The throttle gauge in widget 17: a frame in colour 10, then a bar
 * standing up from throttleBarY, (throttle << 16) * length / 0x400 smoothed
 * (>> 16), in 0xf and capped at the length. In reverse the target is halved
 * and negated and the bar hangs downward (y + |value|, capped at length / 2)
 * in 7. From the disassembly 0x31300..0x31470.
 *
 * @mw2 hud_gauge_throttle 0x00031300
 * @fidelity exact
 */
export function hudGaugeThrottle(pane: ViewWindow): void {
  const g = gauges;
  const L = damageDisplay.gaugeLayout;
  const l = playerLoadout();
  vfxLineDraw(pane, L[2]!, L[3]!, L[2]!, L[5]!, 0, 10);
  vfxLineDraw(pane, L[4]!, L[3]!, L[4]!, L[5]!, 0, 10);
  vfxLineDraw(pane, L[2]!, L[3]!, L[4]!, L[3]!, 0, 10);
  vfxLineDraw(pane, L[2]!, L[5]!, L[4]!, L[5]!, 0, 10);
  const len = L[1]!;
  const control = l.entity!.control!;
  let target = mulDiv(control.throttle << 16, len, 0x400);
  if (control.reverseDirection !== 0) target = cdiv(target, -2);
  g.throttleLowpass[1] = target;
  let v = lowpassStep(g.throttleLowpass) >> 16;
  let y = L[7]!;
  let colour = 0xf;
  if (control.reverseDirection !== 0) {
    v = -v | 0;
    const half = cdiv(len, 2);
    if (v > half) v = half;
    colour = 7;
    y = (y + v) | 0;
  } else if (v > len) v = len;
  damageSub031520(pane, L[6]!, y, (L[0]! - 1) | 0, (v + 1) | 0, colour);
}

/**
 * The jump-jet bar in widget 21: jumpFuel smoothed, (length + 1) * value /
 * 0x71c filled in 0xf (capped at the length), the rest in 0xb; nothing at all
 * while jumpFuel is negative. From the disassembly 0x31480..0x3151f.
 *
 * @mw2 hud_gauge_jumpjets 0x00031480
 * @fidelity exact
 */
export function hudGaugeJumpjets(pane: ViewWindow): void {
  const g = gauges;
  const L = damageDisplay.gaugeLayout;
  const fuel = playerLoadout().jumpFuel;
  if (fuel < 0) return;
  g.jetsLowpass[1] = fuel;
  const v = lowpassStep(g.jetsLowpass);
  const len = L[18]!;
  let n = mulDiv((len + 1) | 0, v, 0x71c);
  if (n > len) n = len;
  const x = L[16]!;
  const y = L[17]!;
  const h1 = (L[19]! - 1) | 0;
  hudDrawBar(pane, x, y, n, h1, 0xf);
  hudDrawBar(pane, (x + n) | 0, y, (len - n) | 0, h1, 0xb);
}

/** The widget's text position, as pushed to vfx_string_draw ([+0x34], [+0x34] + 4). */
const textX = (w: HudWidget): number => (w.textPos as Int32Array)[0]!;
const textY = (w: HudWidget): number => (w.textPos as Int32Array)[1]!;

/** Sets the label (methods[4]) and draws it at the text position in the HUD font. */
function drawLabel(w: HudWidget, text: string): boolean {
  w.methods[4]!(w, text);
  const font = hudFont();
  if (!font) return false;
  vfxStringDraw(widgetPane(w), textX(w), textY(w), font, w.label, display.textColourTable);
  hudFontUnlock();
  return true;
}

/**
 * 'AUTOPILOT' at the text position while the player's autopilotEngaged is 1
 * or 2.
 *
 * @mw2 hud_autopilot_tick 0x00031fe0
 * @fidelity exact
 */
export const hudAutopilotTick = registerCode('hud_autopilot_tick', 0x31fe0, (w: HudWidget): void => {
  if (w.visible === 0) return;
  const a = playerLoadout().autopilotEngaged >>> 0;
  if (a !== 1 && a !== 2) return;
  const font = hudFont();
  if (!font) return;
  vfxStringDraw(widgetPane(w), textX(w), textY(w), font, 'AUTOPILOT', display.textColourTable);
  hudFontUnlock();
});

/**
 * The speed: the loadout velocity's max-plus-quarter-sum norm
 * ((4 * max + mid + min) >> 2) / 0x2712, times 1.5 (the double at 0x90cb7)
 * truncated (clib_fp_trunc, round-to-zero, then fistp), drawn as '%d kph' -
 * negated and in ink colour 6 while the throttle ramp (ramps[2]) is negative,
 * else in 0xe - then the throttle gauge. The ink colour is set before the
 * font is loaded and put back to 0xe only after a draw.
 *
 * @mw2 hud_speed_tick 0x00032080
 * @fidelity exact
 */
export const hudSpeedTick = registerCode('hud_speed_tick', 0x32080, (w: HudWidget): void => {
  if (w.visible === 0) return;
  const l = playerLoadout();
  let a = Math.abs(l.velocityX | 0) | 0;
  let b = Math.abs(l.velocityY | 0) | 0;
  let c = Math.abs(l.velocityZ | 0) | 0;
  if (a < b) [a, b] = [b, a];
  if (a < c) [a, c] = [c, a];
  const norm = cdiv(((Math.imul(a, 4) + b + c) | 0) >> 2, 0x2712);
  let kph = Math.trunc(norm * 1.5) | 0;
  if (l.ramps[2]!.current < 0) {
    kph = -kph | 0;
    display.textColourTable[0xe] = 6;
  } else display.textColourTable[0xe] = 0xe;
  const font = hudFont();
  if (!font) return;
  vfxStringDraw(widgetPane(w), textX(w), textY(w), font, `${kph} kph`, display.textColourTable);
  display.textColourTable[0xe] = 0xe;
  hudFontUnlock();
  hudGaugeThrottle(widgetPane(w));
});

/**
 * 'MASC' while MASC is engaged.
 *
 * @mw2 hud_masc_tick 0x000321b0
 * @fidelity exact
 */
export const hudMascTick = registerCode('hud_masc_tick', 0x321b0, (w: HudWidget): void => {
  if (w.visible === 0 || mechRuntime.mascEngaged === 0) return;
  drawLabel(w, 'MASC');
});

/**
 * 'Heat', then the heat gauge.
 *
 * @mw2 hud_heat_tick 0x00032230
 * @fidelity exact
 */
export const hudHeatTick = registerCode('hud_heat_tick', 0x32230, (w: HudWidget): void => {
  if (w.visible === 0) return;
  if (drawLabel(w, 'Heat')) hudGaugeHeat(widgetPane(w));
});

/**
 * 'dH/dT', then the heat-rate gauge.
 *
 * @mw2 hud_heat_rate_tick 0x000322b0
 * @fidelity exact
 */
export const hudHeatRateTick = registerCode('hud_heat_rate_tick', 0x322b0, (w: HudWidget): void => {
  if (w.visible === 0) return;
  if (drawLabel(w, 'dH/dT')) hudGaugeHeatRate(widgetPane(w));
});

/**
 * 'Jets', then the jump-jet gauge, while jumpFuel is not negative.
 *
 * @mw2 hud_jets_tick 0x00032330
 * @fidelity exact
 */
export const hudJetsTick = registerCode('hud_jets_tick', 0x32330, (w: HudWidget): void => {
  if (w.visible === 0 || playerLoadout().jumpFuel < 0) return;
  if (drawLabel(w, 'Jets')) hudGaugeJumpjets(widgetPane(w));
});
