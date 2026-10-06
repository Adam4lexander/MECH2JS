/**
 * The VR controls' way into the sim. The controllers and the cockpit's
 * switches don't pretend to be keys: the app sets what the pilot wants
 * (pilot.intent, pilotCommand) at display rate, and each sim pass applies
 * it to playerControls after input_poll_controls and runs the commands
 * after key_command_update, where the keyboard's would run.
 *
 * Analog channels are set through their sinks (inputSetAnalogSlot), so the
 * keyboard and mouse carry on from wherever the controllers left them. The
 * rates are integrated here, per pass, over the pass's own ticks: the app
 * runs several frames a pass and couldn't.
 *
 * @portOnly the VR controls
 */
import { divergence } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { commandExecute } from '../ui/commands.ts';
import { input, inputSetAnalogSlot } from './input.ts';

/** clock ticks a second (engine/clock.ts) */
const TICKS_PER_SECOND = 182;

export interface PilotIntent {
  /** the throttle's travel a second, -1..1 of full forward (negative pulls it back, through a stop into reverse) */
  throttleRate: number;
  /** the throttle outright, -1 (full reverse) ..1 (full forward); wins over the rate */
  throttleSet: number | null;
  /** turn the legs, -1 (left) ..1 (right), proportional */
  legs: number;
  /** torso twist and pitch, degrees a second */
  torsoPanRate: number;
  torsoTiltRate: number;
  fire: boolean;
  fireGroup: boolean;
  jets: boolean;
  /** an in-game menu's item and value axes, -1..1 (menu_item, menu_value: up and left negative) */
  menuItem: number;
  menuValue: number;
}

export const IDLE_INTENT: PilotIntent = { throttleRate: 0, throttleSet: null, legs: 0, torsoPanRate: 0, torsoTiltRate: 0, fire: false, fireGroup: false, jets: false, menuItem: 0, menuValue: 0 };

/** The ControlState channels a press holds for one pass: action channels no command sets. */
export type PilotPulse = 'weapon_cycle' | 'menu_enter' | 'menu_abort';

export const pilot = registerGlobals(
  'pilotIntent',
  {
    /** whether the controllers are in charge (a VR session in a mission) */
    active: false,
    intent: { ...IDLE_INTENT } as PilotIntent,
    /** command ids waiting for the next pass */
    commands: [] as number[],
    /** channels waiting to be held for the next pass */
    pulses: [] as PilotPulse[],
    /** the throttle reached the stop while being moved; it stays there until the rate lets go */
    atStop: false,
  },
  () => {
    pilot.active = false;
    pilot.intent = { ...IDLE_INTENT };
    pilot.commands = [];
    pilot.pulses = [];
    pilot.atStop = false;
  },
);

/** Queues a command (command_execute's ids) for the next sim pass. */
export function pilotCommand(id: number): void {
  pilot.commands.push(id);
}

/** Holds a channel for the next sim pass. */
export function pilotPulse(p: PilotPulse): void {
  pilot.pulses.push(p);
}

/** Lets go of everything, presses still waiting too: the keyboard and mouse alone drive. */
export function pilotRelease(): void {
  pilot.active = false;
  pilot.intent = { ...IDLE_INTENT };
  pilot.commands = [];
  pilot.pulses = [];
  pilot.atStop = false;
}

/**
 * While PAUSE_GAME waits for a key (cheats_sub_046ac0): whether a press of
 * the controllers' or the cockpit's came, which ends the wait as a key
 * does - and is spent on it, as the key is.
 */
export function pilotPressEndsPause(): boolean {
  if (pilot.commands.length === 0 && pilot.pulses.length === 0) return false;
  pilot.commands = [];
  pilot.pulses = [];
  return true;
}

/** Whether a menu has the controls (input_sub_048c50 clears gameControlsLive while one is up). */
export function pilotMenuOpen(): boolean {
  return input.gameControlsLive === 0;
}

/** The player's throttle as -1..1, negative in reverse. */
export function pilotThrottle(): number {
  const pc = mechs.playerControls;
  return ((pc.reverseDirection !== 0 ? -1 : 1) * pc.throttle) / 1024;
}

function setThrottle(v: number): void {
  const pc = mechs.playerControls;
  pc.reverseDirection = v < 0 ? 1 : 0;
  inputSetAnalogSlot('throttle', Math.round(Math.abs(v) * 1024));
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** After input_poll_controls: the intent onto playerControls. */
export function pilotIntentApply(): void {
  if (!pilot.active) {
    pilot.pulses = [];
    return;
  }
  divergence('the VR controls write playerControls directly', 'pilotIntentApply');
  const pc = mechs.playerControls;
  const it = pilot.intent;
  const pulses = pilot.pulses;
  pilot.pulses = [];
  // the menu channels are live with a menu up or not (input_poll_controls reads 'menu_' channels either way)
  if (it.menuItem !== 0) pc.menu_item = Math.round(clamp(it.menuItem, -1, 1) * 0x10000);
  if (it.menuValue !== 0) pc.menu_value = Math.round(clamp(it.menuValue, -1, 1) * 0x10000);
  for (const p of pulses) if (p === 'menu_enter' || p === 'menu_abort') pc[p] = 1;
  if (input.gameControlsLive === 0) return;
  for (const p of pulses) if (p === 'weapon_cycle') pc.weapon_cycle = 1;
  const sec = clock.tickDelta / TICKS_PER_SECOND;

  const cur = pilotThrottle();
  if (it.throttleSet !== null) {
    pilot.atStop = false;
    const v = clamp(it.throttleSet, -1, 1);
    // a forward or stopped lever takes reverse off too
    if (Math.abs(v - cur) > 0.5 / 1024 || (v < 0) !== (pc.reverseDirection !== 0)) setThrottle(v);
  } else if (it.throttleRate !== 0) {
    if (!pilot.atStop) {
      let v = clamp(cur + it.throttleRate * sec, -1, 1);
      // through zero only from a standstill: the stop holds until the stick lets go
      if (cur !== 0 && Math.sign(v) !== Math.sign(cur)) {
        v = 0;
        pilot.atStop = true;
      }
      if (v !== cur) setThrottle(v);
    }
  } else pilot.atStop = false;

  if (it.legs !== 0) inputSetAnalogSlot('legs_pan_delta', Math.round(clamp(it.legs, -1, 1) * 1024 * 0x10000));
  if (it.torsoPanRate !== 0) inputSetAnalogSlot('torso_pan', Math.round(clamp(pc.torso_pan + it.torsoPanRate * sec * 0x10000, -90 * 0x10000, 90 * 0x10000)));
  if (it.torsoTiltRate !== 0) inputSetAnalogSlot('torso_tilt', Math.round(clamp(pc.torso_tilt + it.torsoTiltRate * sec * 0x10000, -60 * 0x10000, 60 * 0x10000)));

  if (it.fire) pc.weapon_fire = 1;
  if (it.fireGroup) pc.weapon_fire_group = 1;
  if (it.jets) pc.jumpjet_enabled = 1;
}

/** After key_command_update: the queued commands, in order. */
export function pilotCommandsDrain(): void {
  if (pilot.commands.length === 0) return;
  const queued = pilot.commands;
  pilot.commands = [];
  for (const id of queued) commandExecute(id);
}
