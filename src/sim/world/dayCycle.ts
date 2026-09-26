/**
 * The day/night cycle. main calls day_cycle_init once before the game loop
 * and day_cycle_tick every frame. The planet's day (lighting.dayLengthSeconds)
 * is split into four phases starting at hours 5, 7, 17 and 19 of it; every 10
 * seconds the tick works out the time of day and fades the palette to the
 * phase's slot group (dayPhasePaletteSlot: 4, 0, 4, 8 - dawn, day, dusk,
 * night; phase 3 also covers the hours before 5).
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv, cmod, i8 } from '../../core/int/cint.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { divergence } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s, imageU8 } from '../../engine/image.ts';
import { lighting } from './environment.ts';
import { paletteFadeToNewBase } from './palettes.ts';
import { planet } from './planet.ts';

function bootDayCycle() {
  // dayPhasePaletteSlot and dayPhaseFadeTicks are one interleaved table of
  // five {slot, ticks} pairs at 0x95788 (stride 8); no index reaches the fifth
  const pairs = imageI32s(LABEL.dayPhasePaletteSlot, 10, [4, 2730, 0, 2730, 4, 3640, 8, 2730, -1, 360]);
  return {
    /** 0x957cc: timeOfDay as day_cycle_init latched it */
    timeOfDayAtStart: imageI32(LABEL.timeOfDayAtStart, 0),
    /** 0xa55d0: int[4], the seconds each phase starts at */
    dayPhaseStart: Int32Array.from(imageI32s(LABEL.dayPhaseStart, 4, [0, 0, 0, 0])),
    /** 0x957a8: the phase last faded to, -1 for none */
    dayPhase: imageI32(LABEL.dayPhase, -1),
    /** 0xa55e0: simTick of the next re-evaluation */
    dayCycleNextTick: imageI32(LABEL.dayCycleNextTick, 0),
    /** 0xa55e4: the first two ticks only count this up; at 2 the first fade is a 2 s one and it becomes 3 */
    dayCycleWarmup: imageI32(LABEL.dayCycleWarmup, 0),
    /** 0xa55e8 (byte): day_cycle_set_phase does nothing unless it is 1 */
    dayCycleEnabled: imageU8(LABEL.dayCycleEnabled, 0),
    /** 0xa55e9 (byte): the INFRARED vision mode (command 0x9d) */
    infraredOn: imageU8(LABEL.infraredOn, 0),
    /** 0x95788 (stride 8): the palette slot each phase fades to */
    dayPhasePaletteSlot: Int32Array.from([0, 2, 4, 6, 8].map((k) => pairs[k]!)),
    /** 0x9578c (stride 8): the fade length of each phase, in ticks */
    dayPhaseFadeTicks: Int32Array.from([1, 3, 5, 7, 9].map((k) => pairs[k]!)),
  };
}

export const dayCycle = registerGlobals('dayCycle', bootDayCycle(), () => {
  Object.assign(dayCycle, bootDayCycle());
});

/**
 * Enables the cycle, latches the start time, puts the phase boundaries at
 * dayLength/24 * 5, 7, 17 and 19 and marks the phase unset. It also recomputes
 * gravitySetting as (gravity << 16) / 0x794 - the inverse of the PLNT
 * branch's scaling, unrelated to the cycle.
 *
 * @mw2 day_cycle_init 0x00014ee0
 * @fidelity exact
 */
export function dayCycleInit(): void {
  const d = dayCycle;
  d.dayCycleEnabled = 1;
  const hour = cdiv(lighting.dayLengthSeconds, 0x18);
  d.timeOfDayAtStart = lighting.timeOfDay;
  d.dayPhaseStart[0] = Math.imul(hour, 5);
  d.dayPhaseStart[1] = Math.imul(hour, 7);
  d.dayPhaseStart[2] = Math.imul(hour, 0x11);
  d.dayPhaseStart[3] = Math.imul(hour, 0x13);
  d.dayPhase = -1;
  planet.gravitySetting = sdivShl(planet.gravity, 16, 0x794);
}

/**
 * Every 0x71c ticks (10 s) after two warm-up calls: timeOfDay = (start +
 * simTick / 182) % dayLength, bumping dayOfYear when it wrapped, and fades to
 * the last phase whose start is not after it (3 when none is).
 *
 * @mw2 day_cycle_tick 0x00014f80
 * @fidelity partial
 * @divergence the first test - hudWidgets[0] +6 above 0 while infrared is on turns infrared off through vfx_font_sub_0150f0 - needs the HUD, which is not ported; infraredOn is only set by that HUD path, so it stays 0 and the branch cannot run
 */
export function dayCycleTick(): void {
  const d = dayCycle;
  const L = lighting;
  let phase = 3;
  if (d.infraredOn === 1) divergence('day_cycle_tick: hudWidgets[0] check for leaving infrared not ported');
  if (d.dayCycleWarmup < 2) {
    d.dayCycleNextTick = 0;
    d.dayCycleWarmup = d.dayCycleWarmup + 1;
    return;
  }
  const now = clock.simTick;
  if (now < d.dayCycleNextTick) return;
  d.dayCycleNextTick = (now + 0x71c) | 0;
  const t = cmod((d.timeOfDayAtStart + cdiv(now, 0xb6)) | 0, L.dayLengthSeconds);
  if (t < L.timeOfDay) L.dayOfYear = cmod((L.dayOfYear + 1) | 0, L.daysPerYear);
  L.timeOfDay = t;
  for (let i = 0; i < 4; i++) if (d.dayPhaseStart[i]! <= L.timeOfDay) phase = i;
  dayCycleSetPhase(phase);
}

/**
 * While the cycle is enabled, fades to a new phase's palette slot and adopts
 * it as the base: over the phase's own fade time, 1 s when leaving infrared
 * (which it switches off), and 2 s for the first fade of a mission.
 *
 * @mw2 day_cycle_set_phase 0x00015070
 * @fidelity exact
 */
export function dayCycleSetPhase(phase: number): void {
  const d = dayCycle;
  if (i8(d.dayCycleEnabled) !== 1 || phase === d.dayPhase) return;
  let duration: number;
  if (d.infraredOn === 1) {
    duration = 0xb6;
    d.infraredOn = 0;
  } else {
    duration = d.dayPhaseFadeTicks[phase]!;
  }
  if (d.dayCycleWarmup === 2) {
    duration = 0x16c;
    d.dayCycleWarmup = 3;
  }
  paletteFadeToNewBase(d.dayPhasePaletteSlot[phase]!, duration);
  d.dayPhase = phase;
}
