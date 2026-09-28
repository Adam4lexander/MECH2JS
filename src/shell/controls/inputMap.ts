/**
 * INPUT.MAP, the file MW2.EXE's input_load_map binds its control channels
 * from, as the COCKPIT CONTROLS screen writes it
 * (decompiled/mw2shell/src/controls/controls.c): temp.map from every bound
 * record of the four pages, then input.map -> input.bak, temp.map ->
 * input.map, and config00.cpc saved.
 *
 * The file is opened "w" - a text stream, so every '\n' goes out as CRLF.
 * The format strings are the ones fprintf is handed (read from the pushes
 * before each call, which the decompile drops); their addresses are given
 * beside them.
 *
 * A binding is handed around as a pointer, and controls_write_map_entry
 * writes through it (a kind 2 is rewritten for its second half and
 * restored); the port passes a live view of its 0x18 bytes - of shell
 * memory for controlBindings, of a local array for the record
 * controls_write_temp_map builds on its stack.
 */
import { quirk, unestablished } from '../../core/provenance.ts';
import { dosFileExists, dosFileLoad, dosFileRemove, dosFileWrite } from '../../engine/dosFiles.ts';
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import type { Blocking } from '../host/blocking.ts';
import { mem } from '../memory.ts';
import { messageBox } from '../ui/messageBox.ts';
import { BINDING, BINDING_COUNT, BINDING_SIZE, bindingAt, CONTROLS, controls, controlsSaveConfigFile, deviceRecordAt } from './config.ts';
import { inputDeviceGet } from './devices.ts';

/** @portOnly a FILE opened "w": fprintf appends, fclose writes it with '\n' as CRLF */
export class TextStream {
  private text = '';
  constructor(readonly path: string) {}
  fprintf(s: string): void {
    this.text += s;
  }
  fclose(): void {
    const t = this.text.replace(/\n/g, '\r\n');
    const b = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 0xff;
    dosFileWrite(this.path, b);
  }
}

/** A ControlBinding's 0x18 bytes, live. */
export type BindingBytes = Uint8Array;

function field(b: BindingBytes, f: keyof typeof BINDING): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(BINDING[f], true);
}

function setField(b: BindingBytes, f: keyof typeof BINDING, v: number): void {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setInt32(BINDING[f], v | 0, true);
}

/** byte +0xb, whose bit 7 is flags bit 31: the axis is reversed */
const FLAGS_HIGH = BINDING.flags + 3;

function getInt(label: number): number {
  return mem().i32(label);
}

function bump(label: number): void {
  mem().setI32(label, mem().i32(label) + 1);
}

/** controlsDeviceRecords[device].name: the name a map line prints for a device */
function deviceName(device: number): string {
  return mem().cstr(deviceRecordAt(device) + 4, 16);
}

/** axisNames / buttonNames [input] of the device; printf's "(null)" for a NULL pointer */
function inputName(device: number, input: number, axis: boolean): string {
  const dev = inputDeviceGet(device);
  if (!dev) {
    unestablished('controls_write_map_entry: a binding on a device that is not loaded (the original reads through a NULL record)');
    return '(null)';
  }
  const names = axis ? dev.record.analogNames : dev.record.buttonNames;
  const n = names?.[input];
  if (n === undefined || n === null) {
    quirk('controls_write_map_entry: a NULL input name prints as (null)');
    return '(null)';
  }
  return n;
}

/**
 * (file, binding): the modifier lines of an entry, for Ctrl, Alt and Shift
 * in that order: '\t+ keyboard\t<key>' when the modifier's bit (flags 1, 2,
 * 4) is set, else '\t- keyboard\t<key>' when its exclusion bit (0x10, 0x20,
 * 0x40, set by controls_write_temp_map) is. Always the device 'keyboard',
 * whatever the binding's device.
 *
 * @mw2shell controls_write_modifier_lines 0x0001f830
 * @fidelity exact
 */
export function controlsWriteModifierLines(f: TextStream, b: BindingBytes): void {
  const flags = b[BINDING.flags]!;
  // 0x73623 / 0x73638, 0x7364d / 0x7365e, 0x7366f / 0x73682
  if (flags & 1) f.fprintf('\t+ keyboard\tControl\n');
  else if (flags & 0x10) f.fprintf('\t- keyboard\tControl\n');
  if (flags & 2) f.fprintf('\t+ keyboard\tAlt\n');
  else if (flags & 0x20) f.fprintf('\t- keyboard\tAlt\n');
  if (flags & 4) f.fprintf('\t+ keyboard\tShift\n');
  else if (flags & 0x40) f.fprintf('\t- keyboard\tShift\n');
}

/** One discrete entry: '%s {' (0x736a9), '\t+ %s\t%s' (0x736af), the modifier lines, '}' (0x736b9). */
function writeDiscrete(f: TextStream, name: string, b: BindingBytes): void {
  bump(SHELL_LABEL.mapDiscreteCount);
  const device = field(b, 'device');
  f.fprintf(`${name} {\n`);
  f.fprintf(`\t+ ${deviceName(device)}\t${inputName(device, field(b, 'input'), false)}\n`);
  controlsWriteModifierLines(f, b);
  f.fprintf('}\n');
}

/** strncmp(name, "jumpjet_fire_", 13) == 0 (0x736bc) */
function isJumpjetFire(name: string): boolean {
  return name.slice(0, 13) === 'jumpjet_fire_';
}

/**
 * (file, name, binding): the binding's discrete entry under `name`, and,
 * while the name is a jumpjet_fire_* one, again as 'jumpjet_enabled'
 * (0x736ca). Nothing when input < 0. controls_write_map_entry calls it with
 * 'jumpjet_enabled' after a jumpjet_fire_* entry - so every jump-jet fire
 * key also enables the jets.
 *
 * @mw2shell controls_write_jumpjet_enable 0x0001f930
 * @fidelity exact
 */
export function controlsWriteJumpjetEnable(f: TextStream, name: string, b: BindingBytes): void {
  for (;;) {
    if (field(b, 'input') < 0) return;
    writeDiscrete(f, name, b);
    if (!isJumpjetFire(name)) return;
    name = 'jumpjet_enabled';
  }
}

/** a discrete entry, and a jumpjet_fire_* one again as jumpjet_enabled */
function writeButton(f: TextStream, name: string, b: BindingBytes): void {
  if (field(b, 'input') < 0) return;
  writeDiscrete(f, name, b);
  if (isJumpjetFire(name)) controlsWriteJumpjetEnable(f, 'jumpjet_enabled', b);
}

/**
 * (file, name, binding): one entry of temp.map; nothing when input < 0.
 * Kind 0 (an axis, analog count + 1): '%s {' / '\t%c %s\t%s' - '+', or '-'
 * when reversed (flags bit 31), the device's name and axisNames[input] /
 * the modifier lines / '}'. Kind 1 (a button, discrete count + 1): the same
 * with '\t+ %s\t%s' and buttonNames[input], and a jumpjet_fire_* entry is
 * written again as jumpjet_enabled. Kind 2 (an axis on two buttons): '_delta'
 * is cut from the name and two discrete entries are written, <name>_minus on
 * input and <name>_plus on input2 with flags2 - the suffixes swapped when
 * reversed - after which the binding is restored. Then, by recursion with
 * the same binding, the controls the sim also wants: pilot_tilt as
 * track_height_delta, pilot_pan as eyepoint_pan_delta, zoom_factor as
 * track_distance_delta with the direction flipped, torso_tilt_reset as
 * pilot_tilt_reset, torso_pan_reset and pilot_pan_reset, glance_up / down as
 * track_height_minus / plus, glance_right / left as eyepoint_pan_plus /
 * minus.
 *
 * @mw2shell controls_write_map_entry 0x0001fc40
 * @fidelity exact
 */
export function controlsWriteMapEntry(f: TextStream, name: string, b: BindingBytes): void {
  if (field(b, 'input') < 0) return;
  const kind = field(b, 'kind');
  if (kind === 0) {
    const device = field(b, 'device');
    const input = field(b, 'input');
    if (input > -1) {
      bump(SHELL_LABEL.mapAnalogCount);
      // 0x73695 '%s {', 0x7369b '\t%c %s\t%s', 0x736a6 '}'
      f.fprintf(`${name} {\n`);
      const sign = b[FLAGS_HIGH]! & 0x80 ? '-' : '+';
      f.fprintf(`\t${sign} ${deviceName(device)}\t${inputName(device, input, true)}\n`);
      controlsWriteModifierLines(f, b);
      f.fprintf('}\n');
    }
  } else if (kind === 1) {
    writeButton(f, name, b);
  } else if (kind === 2) {
    const saved = b.slice();
    // strstr(name, "_delta") (0x736da) cut off
    const at = name.indexOf('_delta');
    const base = at < 0 ? name : name.slice(0, at);
    const reversed = (b[FLAGS_HIGH]! & 0x80) !== 0;
    // not reversed: 0x736ee '_minus' / 0x736f5 '_plus'; reversed: 0x736e8 '_plus' / 0x736e1 '_minus'
    writeButton(f, base + (reversed ? '_plus' : '_minus'), b);
    setField(b, 'input', field(b, 'input2'));
    setField(b, 'flags', field(b, 'flags2'));
    writeButton(f, base + (reversed ? '_minus' : '_plus'), b);
    b.set(saved);
  }
  // 0x736fb.. 0x737ff: the names the sim also wants
  switch (name) {
    case 'pilot_tilt':
      controlsWriteMapEntry(f, 'track_height_delta', b);
      return;
    case 'pilot_pan':
      controlsWriteMapEntry(f, 'eyepoint_pan_delta', b);
      return;
    case 'zoom_factor':
      b[FLAGS_HIGH] = b[FLAGS_HIGH]! ^ 0x80;
      controlsWriteMapEntry(f, 'track_distance_delta', b);
      b[FLAGS_HIGH] = b[FLAGS_HIGH]! ^ 0x80;
      return;
    case 'torso_tilt_reset':
      controlsWriteMapEntry(f, 'pilot_tilt_reset', b);
      controlsWriteMapEntry(f, 'torso_pan_reset', b);
      controlsWriteMapEntry(f, 'pilot_pan_reset', b);
      return;
    case 'glance_up':
      controlsWriteMapEntry(f, 'track_height_minus', b);
      return;
    case 'glance_down':
      controlsWriteMapEntry(f, 'track_height_plus', b);
      return;
    case 'glance_right':
      controlsWriteMapEntry(f, 'eyepoint_pan_plus', b);
      return;
    case 'glance_left':
      controlsWriteMapEntry(f, 'eyepoint_pan_minus', b);
      return;
  }
}

/** controlMapNames[i] (0x7a8bc): the sim's name for control i, read from the image; null for the six unused slots */
export function controlMapName(i: number): string | null {
  return mem().ptrStr(SHELL_LABEL.controlMapNames + i * 4);
}

/**
 * Writes temp.map. First the modifier exclusions: kind 2's flags2 is set
 * (the second button's modifiers - the first's, or the first's as
 * exclusions when both buttons are one key), and for every bound record
 * with a modifier, each other bound record on the same input number gets
 * that modifier's exclusion bit (flags bits 4..6) - axes among axes,
 * buttons among buttons, both halves of a kind 2 - so plain X does not also
 * fire when Ctrl+X is bound. The device is not compared. Then one entry per
 * bound record of all four pages, keyed by controlMapNames[i mod 37], each
 * record's flags2 and exclusion bits cleared after it; then the fixed
 * legs_pan_minus / legs_pan_plus lines on the keyboard's inputs 0x66 and
 * 100 (GreyDelete, GreyPageDown), each also as jumpjet_enabled, and the two
 * counts. Returns 1 while there are fewer than 41 analog and 91 discrete
 * entries, else 0 (the file is written either way).
 *
 * @mw2shell controls_write_temp_map 0x000201a0
 * @fidelity exact
 * @divergence the port's disk cannot fail to open a file, so 'Error: Could not write map file.' (0x738b4) is never shown
 */
export function controlsWriteTempMap(): number {
  const m = mem();
  const recs = Array.from({ length: BINDING_COUNT }, (_, i) => m.view(bindingAt(SHELL_LABEL.controlBindings, i), BINDING_SIZE));
  const get = (i: number, f: keyof typeof BINDING) => field(recs[i]!, f);
  const set = (i: number, f: keyof typeof BINDING, v: number) => setField(recs[i]!, f, v);
  for (let i = 0; i < BINDING_COUNT; i++) {
    const kind = get(i, 'kind') >>> 0;
    if (kind < 2) set(i, 'flags2', 0);
    else if (kind === 2) set(i, 'flags2', get(i, 'input2') === get(i, 'input') ? (get(i, 'flags') & 7) << 4 : get(i, 'flags'));
  }
  for (let i = 0; i < BINDING_COUNT; i++) {
    const mod = get(i, 'flags') & 7;
    if (get(i, 'device') < 0 || mod === 0) continue;
    const excl = mod << 4;
    const kind = get(i, 'kind') >>> 0;
    if (kind === 0) {
      for (let j = 0; j < BINDING_COUNT; j++) {
        if (i !== j && get(j, 'device') > -1 && get(j, 'kind') === 0 && get(j, 'input') === get(i, 'input')) set(j, 'flags', get(j, 'flags') | excl);
      }
    } else if (kind < 3) {
      for (let j = 0; j < BINDING_COUNT; j++) {
        if (i === j || get(j, 'device') < 0 || get(j, 'kind') === 0) continue;
        if (get(j, 'input') === get(i, 'input')) set(j, 'flags', get(j, 'flags') | excl);
        if (get(j, 'kind') === 2 && get(j, 'input2') === get(i, 'input')) set(j, 'flags2', get(j, 'flags2') | excl);
        if (get(j, 'kind') === 2 && get(j, 'input') === get(i, 'input2')) set(j, 'flags', get(j, 'flags') | ((get(i, 'flags2') & 7) << 4));
        if (get(j, 'kind') === 2 && get(j, 'input2') === get(i, 'input2')) set(j, 'flags2', get(j, 'flags2') | ((get(i, 'flags2') & 7) << 4));
      }
    }
  }
  // 0x73814 'temp.map', 0x73812 'w'
  const f = new TextStream('temp.map');
  m.setI32(SHELL_LABEL.mapAnalogCount, 0);
  m.setI32(SHELL_LABEL.mapDiscreteCount, 0);
  // 0x7381d
  f.fprintf('# mw2shell CockPit Config generated map file\n');
  for (let i = 0; i < BINDING_COUNT; i++) {
    if (get(i, 'device') < 0) continue;
    const name = controlMapName(i % CONTROLS);
    if (name === null) unestablished('controls_write_temp_map: a bound record of an unused control slot (controlMapNames is NULL there)');
    controlsWriteMapEntry(f, name ?? '(null)', recs[i]!);
    set(i, 'flags2', 0);
    set(i, 'flags', get(i, 'flags') & 0x80000007);
  }
  // a binding on the stack: kind 1 on the keyboard, flags 0, flags2 -1, input2 -1
  const fixed = new Uint8Array(BINDING_SIZE);
  setField(fixed, 'kind', 1);
  setField(fixed, 'device', controls.keyboardDevice);
  setField(fixed, 'flags', 0);
  setField(fixed, 'flags2', -1);
  setField(fixed, 'input', 0x66);
  setField(fixed, 'input2', -1);
  // 0x7384b, 0x7385a
  controlsWriteMapEntry(f, 'legs_pan_minus', fixed);
  controlsWriteMapEntry(f, 'jumpjet_enabled', fixed);
  setField(fixed, 'input', 100);
  // 0x7386a, 0x73878
  controlsWriteMapEntry(f, 'legs_pan_plus', fixed);
  controlsWriteMapEntry(f, 'jumpjet_enabled', fixed);
  // 0x73888, 0x7389d
  f.fprintf(`# analog count = ${getInt(SHELL_LABEL.mapAnalogCount)}\n`);
  f.fprintf(`# discrete count = ${getInt(SHELL_LABEL.mapDiscreteCount)}\n`);
  f.fclose();
  return getInt(SHELL_LABEL.mapAnalogCount) < 0x29 && getInt(SHELL_LABEL.mapDiscreteCount) < 0x5b ? 1 : 0;
}

/** DOS rename(old, new): fails (-1) when old is missing or new exists. @portOnly the C runtime's rename, on the port's disk */
export function dosRename(from: string, to: string): number {
  const b = dosFileLoad(from);
  if (!b || dosFileExists(to)) return -1;
  dosFileWrite(to, b);
  dosFileRemove(from);
  return 0;
}

/**
 * ACCEPT CONFIG AND EXIT without its message boxes: temp.map written
 * (controls_write_temp_map); when that says too many controls, false and
 * nothing else. Otherwise input.bak removed, input.map renamed input.bak,
 * temp.map renamed input.map, and config00.cpc saved (controls_save_config(0),
 * which shows no message); true.
 *
 * @portOnly controls_accept_config (0x20e60) less its two message boxes and controlsExit, for callers that cannot block (the port's first-run seed)
 */
export function controlsAcceptConfigFiles(): boolean {
  if (controlsWriteTempMap() === 0) return false;
  // 0x739bf 'input.bak'; 0x739d3 'input.map' -> 0x739c9 'input.bak'; 0x739e7 'temp.map' -> 0x739dd 'input.map'
  dosFileRemove('input.bak');
  dosRename('input.map', 'input.bak');
  dosRename('temp.map', 'input.map');
  controlsSaveConfigFile(0);
  return true;
}

/**
 * ACCEPT CONFIG AND EXIT: controls_write_temp_map, or "Error: Sim can not
 * handle that many controls." and back to the panel; else input.map becomes
 * input.bak and temp.map input.map, config00.cpc is saved, "Cockpit Control
 * Configured." and the screen ends (controlsExit = 1).
 *
 * @mw2shell controls_accept_config 0x00020e60
 * @fidelity exact
 */
export function* controlsAcceptConfig(): Blocking<void> {
  if (!controlsAcceptConfigFiles()) {
    // 0x7398e
    yield* messageBox('Error: Sim can not|handle that many controls.#Ok', 0);
    return;
  }
  // 0x739f0
  yield* messageBox('Cockpit Control Configured.#Ok', 0);
  mem().setI32(SHELL_LABEL.controlsExit, 1);
}
