/**
 * The per-device default profiles RESET DEFAULTS reads, giddi\<device>.cpc
 * (controls_reset_defaults), as the port's own data: which control each
 * device drives on which page, by input name. The install ships one per
 * driver; the port has drivers for the keyboard and the mouse only
 * (shell/controls/devices.ts), so it supplies those two. They are written
 * in the .cpc layout (0x40 bytes of name, 16 device records, 4 x 37
 * ControlBindings) and are byte for byte the install's GIDDI\KEYBOARD.CPC
 * and GIDDI\MOUSE.CPC (test/golden/shellControls.test.ts).
 *
 * @portOnly the port's own copies of files the original ships
 */
import { divergence } from '../../core/provenance.ts';
import type { GiddiRecord } from '../../sim/controls/giddi.ts';
import { BINDING, BINDING_COUNT, BINDING_SIZE, CONFIG_NAME_BYTES, CONTROLS, CPC_BYTES, RECORDS_BYTES } from './config.ts';

/** One binding of a profile. */
export interface ProfileBinding {
  /** 0..3: Primary .. Quaternary Controls */
  page: number;
  /** the control, by the sim's name for it (controlMapNames: 'throttle', 'legs_pan_delta' ...) */
  control: string;
  /**
   * 'axis' (kind 0): an axis control on one of the device's axes;
   * 'button' (kind 1): a button control on one button;
   * 'buttons' (kind 2): an axis control on two buttons, `input` its minus
   * end and `input2` its plus end
   */
  kind: 'axis' | 'button' | 'buttons';
  /** the device's axis or button, by its name (the driver's name table) */
  input: string;
  /** kind 'buttons': the second button */
  input2?: string;
  /** a modifier key that must be held */
  modifier?: 'Ctrl' | 'Alt' | 'Shift';
  /** the axis runs the other way (flags bit 31) */
  reversed?: boolean;
}

export interface DeviceProfile {
  /** the configuration name the file carries (RESET DEFAULTS replaces it with 'Default Config') */
  name: string;
  /** the device, by its driver's name */
  device: string;
  /**
   * The giddi\ list of the machine the file was saved on: its device
   * records, which the bindings' device numbers index. The shipped
   * profiles were saved with all eight shipped drivers present.
   */
  savedDevices: string[];
  /**
   * input2 of the profile's 'axis' and 'button' bindings, which the
   * editor left there: -1 in the keyboard's (every one of its buttons
   * was once the second half of a pair), 0 in the mouse's.
   */
  spareInput2: number;
  bindings: ProfileBinding[];
}

/** the eight drivers the install ships, in its giddi\ order */
const SHIPPED_DEVICES = ['fltstck', 'joystick', 'keyboard', 'mouse', 'msjstick', 'tmaster', 'vio1', 'vio2'];

/** GIDDI\KEYBOARD.CPC */
export const KEYBOARD_PROFILE: DeviceProfile = {
  name: 'name goes here',
  device: 'keyboard',
  savedDevices: SHIPPED_DEVICES,
  spareInput2: -1,
  bindings: [
    { page: 0, control: 'throttle', kind: 'buttons', input: 'Equal', input2: 'Minus', reversed: true },
    { page: 0, control: 'legs_pan_delta', kind: 'buttons', input: 'LeftArrow', input2: 'RightArrow' },
    { page: 0, control: 'torso_pan', kind: 'buttons', input: 'Comma', input2: 'Period' },
    { page: 0, control: 'torso_tilt', kind: 'buttons', input: 'UpArrow', input2: 'DownArrow', reversed: true },
    { page: 0, control: 'pilot_pan', kind: 'buttons', input: 'GreyLeftArrow', input2: 'GreyRightArrow', modifier: 'Ctrl' },
    { page: 0, control: 'pilot_tilt', kind: 'buttons', input: 'GreyDownArrow', input2: 'GreyUpArrow', modifier: 'Ctrl' },
    { page: 0, control: 'zoom_factor', kind: 'buttons', input: 'Z', input2: 'Z', modifier: 'Shift' },
    { page: 0, control: 'torso_tilt_reset', kind: 'button', input: 'Keypad5' },
    { page: 0, control: 'glance_left', kind: 'button', input: 'Home' },
    { page: 0, control: 'glance_right', kind: 'button', input: 'PageUp' },
    { page: 0, control: 'jumpjet_enabled', kind: 'button', input: 'J' },
    { page: 0, control: 'jumpjet_fire_forward', kind: 'button', input: 'GreyHome' },
    { page: 0, control: 'jumpjet_fire_backward', kind: 'button', input: 'GreyEnd' },
    { page: 0, control: 'jumpjet_fire_left', kind: 'button', input: 'GreyInsert' },
    { page: 0, control: 'jumpjet_fire_right', kind: 'button', input: 'GreyPageUp' },
    { page: 0, control: 'weapon_fire', kind: 'button', input: 'Space' },
    { page: 0, control: 'weapon_cycle', kind: 'button', input: 'Enter' },
    { page: 0, control: 'weapon_fire_group_1', kind: 'button', input: 'NUMLock' },
    { page: 0, control: 'weapon_fire_group_2', kind: 'button', input: 'GreySlash' },
    { page: 0, control: 'weapon_fire_group_3', kind: 'button', input: 'GreyStar' },
    { page: 1, control: 'throttle', kind: 'buttons', input: 'GreyPlus', input2: 'GreyMinus', reversed: true },
    { page: 1, control: 'legs_pan_delta', kind: 'buttons', input: 'GreyLeftArrow', input2: 'GreyRightArrow' },
    { page: 1, control: 'torso_pan', kind: 'buttons', input: 'End', input2: 'PageDown' },
    { page: 1, control: 'torso_tilt', kind: 'buttons', input: 'GreyUpArrow', input2: 'GreyDownArrow', reversed: true },
    { page: 1, control: 'weapon_fire', kind: 'button', input: 'KeypadEnter' },
    { page: 1, control: 'weapon_cycle', kind: 'button', input: 'Delete' },
  ],
};

/** GIDDI\MOUSE.CPC as it shipped: the mouse's up/down tilts the torso inverted (reversed), flight-stick style. */
export const MOUSE_PROFILE_SHIPPED: DeviceProfile = {
  name: 'name goes here',
  device: 'mouse',
  savedDevices: SHIPPED_DEVICES,
  spareInput2: 0,
  bindings: [
    { page: 0, control: 'torso_pan', kind: 'axis', input: 'Left/Right' },
    { page: 0, control: 'torso_tilt', kind: 'axis', input: 'Up/Down', reversed: true },
    { page: 0, control: 'weapon_fire', kind: 'button', input: 'LeftBtn' },
    { page: 0, control: 'weapon_cycle', kind: 'button', input: 'RightBtn' },
    { page: 0, control: 'target_reticle', kind: 'button', input: 'MiddleBtn' },
  ],
};

/**
 * The mouse profile the port supplies: the shipped one with torso_tilt not
 * reversed, so pushing the mouse forward tilts the torso up.
 *
 * @divergence a deliberate change of default, the user's choice (2026-09-28): the shipped MOUSE.CPC inverts the mouse's up/down; COCKPIT CONTROLS can still reverse it
 */
export const MOUSE_PROFILE: DeviceProfile = {
  ...MOUSE_PROFILE_SHIPPED,
  bindings: MOUSE_PROFILE_SHIPPED.bindings.map((b) => (b.control === 'torso_tilt' ? { ...b, reversed: false } : b)),
};

/** The profiles the port supplies, by device. */
export const DEVICE_PROFILES: readonly DeviceProfile[] = [KEYBOARD_PROFILE, MOUSE_PROFILE];

const MODIFIER = { Ctrl: 1, Alt: 2, Shift: 4 } as const;
const KIND = { axis: 0, button: 1, buttons: 2 } as const;

/**
 * The profile as a .cpc: `controls` is controlMapNames (the image's table,
 * 37 entries), `record` the device driver's record (its input names).
 * Unbound records are what controls_clear_bindings leaves.
 */
export function profileToCpc(p: DeviceProfile, controls: readonly (string | null)[], record: GiddiRecord): Uint8Array {
  const out = new Uint8Array(CPC_BYTES);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < p.name.length && i < CONFIG_NAME_BYTES - 1; i++) out[i] = p.name.charCodeAt(i);
  for (let i = 0; i < 16; i++) {
    const at = CONFIG_NAME_BYTES + i * 16;
    const name = p.savedDevices[i];
    dv.setInt32(at, name === undefined ? -1 : i, true);
    if (name !== undefined) for (let k = 0; k < name.length && k < 11; k++) out[at + 4 + k] = name.charCodeAt(k);
  }
  const device = p.savedDevices.indexOf(p.device);
  if (device < 0) throw new Error(`profile ${p.device}: not among its saved devices`);
  const base = CONFIG_NAME_BYTES + RECORDS_BYTES;
  const put = (i: number, f: keyof typeof BINDING, v: number) => dv.setInt32(base + i * BINDING_SIZE + BINDING[f], v, true);
  for (let i = 0; i < BINDING_COUNT; i++) {
    put(i, 'device', -1);
    put(i, 'kind', i % CONTROLS > 6 ? 1 : 0);
  }
  const lookup = (names: (string | null)[] | null, n: string): number => {
    const i = names ? names.indexOf(n) : -1;
    if (i < 0) throw new Error(`profile ${p.device}: no input named ${n}`);
    return i;
  };
  for (const b of p.bindings) {
    const c = controls.indexOf(b.control);
    if (c < 0) throw new Error(`profile ${p.device}: no control named ${b.control}`);
    const i = b.page * CONTROLS + c;
    const kind = KIND[b.kind];
    put(i, 'kind', kind);
    put(i, 'device', device);
    put(i, 'flags', (b.modifier ? MODIFIER[b.modifier] : 0) | (b.reversed ? 0x80000000 : 0));
    put(i, 'flags2', 0);
    put(i, 'input', lookup(kind === 0 ? record.analogNames : record.buttonNames, b.input));
    put(i, 'input2', kind === 2 ? lookup(record.buttonNames, b.input2 ?? '') : p.spareInput2);
  }
  divergence(`giddi\\${p.device}.cpc: the port's own default profile, not the install's file`);
  return out;
}
