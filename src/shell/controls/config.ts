/**
 * The cockpit controls configuration (decompiled/mw2shell/src/controls/
 * controls.c): 4 pages x 37 ControlBindings (controlBindings, 0x8b438), the
 * configuration's name (controlsConfigName, 0x40 bytes) and 16 device
 * records (controlsDeviceRecords: {number, name[12]}) - and the files they
 * are kept in, giddi\config%02d.cpc (config00 the active configuration,
 * 01..04 Custom 1..4) and each device's own defaults, giddi\<device>.cpc.
 * A .cpc is the three blocks back to back: name, records, bindings.
 *
 * All of it lives in shell memory at its own address, residue and all, so
 * the .cpc files come out byte for byte (a record's name is strncpy'd over
 * a longer one; controls_renumber_devices blanks only a missing device's
 * first name byte).
 */
import { quirk } from '../../core/provenance.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import type { Blocking } from '../host/blocking.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { messageBox } from '../ui/messageBox.ts';
import { WIDGET } from '../ui/widgets.ts';
import { inputDeviceGet, inputDevicesLoad } from './devices.ts';

/** The ControlBinding fields, as byte offsets. */
export const BINDING = {
  kind: fieldOffset('ControlBinding', 'kind'),
  device: fieldOffset('ControlBinding', 'device'),
  flags: fieldOffset('ControlBinding', 'flags'),
  flags2: fieldOffset('ControlBinding', 'flags2'),
  input: fieldOffset('ControlBinding', 'input'),
  input2: fieldOffset('ControlBinding', 'input2'),
} as const;
export const BINDING_SIZE = structSize('ControlBinding');
/** controls per page (controlNames, controlMapNames) */
export const CONTROLS = 37;
/** 4 pages */
export const BINDING_COUNT = 4 * CONTROLS;
/** 0xde0: the bindings block of a .cpc */
export const BINDINGS_BYTES = BINDING_COUNT * BINDING_SIZE;
/** 0x40: the name block */
export const CONFIG_NAME_BYTES = 0x40;
const RECORD_SIZE = structSize('DeviceRecord');
const RECORD = { number: fieldOffset('DeviceRecord', 'number'), name: fieldOffset('DeviceRecord', 'name') };
/** 0x100: 16 device records */
export const RECORDS_BYTES = 16 * RECORD_SIZE;
/** a whole .cpc */
export const CPC_BYTES = CONFIG_NAME_BYTES + RECORDS_BYTES + BINDINGS_BYTES;

const BINDINGS = SHELL_LABEL.controlBindings;
const SCRATCH = SHELL_LABEL.controlDefaultsScratch;
const RECORDS = SHELL_LABEL.controlsDeviceRecords;
const CHOSEN = SHELL_LABEL.controlsDeviceChosen;
const NAME = SHELL_LABEL.controlsConfigName;

/** @portOnly the address of binding i (0..147) of a bindings block */
export function bindingAt(block: number, i: number): number {
  return block + i * BINDING_SIZE;
}

/** @portOnly a binding's field */
export function bindingField(b: number, f: keyof typeof BINDING): number {
  return mem().i32(b + BINDING[f]);
}

/** @portOnly sets a binding's field */
export function setBindingField(b: number, f: keyof typeof BINDING, v: number): void {
  mem().setI32(b + BINDING[f], v);
}

/** @portOnly controlsBindings[i]: control i of the page shown (controlsBindings points at its first binding) */
export function currentBinding(i: number): number {
  return bindingAt(mem().u32(SHELL_LABEL.controlsBindings), i);
}

/** @portOnly controlsKeyboardDevice (0x7a958): the keyboard's device number, -1 before controls_screen finds it */
export function controlsKeyboardDevice(): number {
  return mem().i32(SHELL_LABEL.controlsKeyboardDevice);
}

/** @portOnly device record i's address */
export function deviceRecordAt(i: number): number {
  return RECORDS + i * RECORD_SIZE;
}

/** @portOnly device record i: {number, name} */
export function deviceRecord(i: number): { number: number; name: string } {
  const a = deviceRecordAt(i);
  return { number: mem().i32(a + RECORD.number), name: mem().cstr(a + RECORD.name) };
}

function chosen(i: number): number {
  return mem().i32(CHOSEN + i * 4);
}

function setChosen(i: number, v: number): void {
  mem().setI32(CHOSEN + i * 4, v);
}

/** @portOnly controlsDeviceChosen[i] */
export function controlsDeviceChosen(i: number): boolean {
  return chosen(i) !== 0;
}

/** @portOnly controlsConfigName */
export function controlsConfigName(): string {
  return mem().cstr(NAME, CONFIG_NAME_BYTES);
}

/** The shell's int globals this module reads and writes. */
function getInt(label: number): number {
  return mem().i32(label);
}
function setInt(label: number, v: number): void {
  mem().setI32(label, v);
}

/** fread(buf, size, n, f) of a whole file read into memory: as many bytes as the file still has */
function freadInto(file: Uint8Array, pos: number, dst: number, n: number): number {
  const take = Math.max(0, Math.min(n, file.length - pos));
  if (take > 0) mem().view(dst, take).set(file.subarray(pos, pos + take));
  return pos + take;
}

/**
 * Every binding of the four pages unbound: device -1, flags, flags2 and
 * both inputs 0, kind 0 (an axis) for controls 0..6 and 1 (a button) for
 * the rest; back to the first page (controlsPage 0, controlsBindings at
 * its start) and the Default slot (controlsConfigSlot 0).
 *
 * @mw2shell controls_clear_bindings 0x00020730
 * @fidelity exact
 */
export function controlsClearBindings(): void {
  for (let page = 0; page < 4; page++) {
    for (let c = 0; c < CONTROLS; c++) {
      const b = bindingAt(BINDINGS, page * CONTROLS + c);
      setBindingField(b, 'device', -1);
      setBindingField(b, 'flags', 0);
      setBindingField(b, 'flags2', 0);
      setBindingField(b, 'input', 0);
      setBindingField(b, 'input2', 0);
      setBindingField(b, 'kind', c > 6 ? 1 : 0);
    }
  }
  setInt(SHELL_LABEL.controlsPage, 0);
  setInt(SHELL_LABEL.controlsBindings, BINDINGS);
  setInt(SHELL_LABEL.controlsConfigSlot, 0);
}

/**
 * (bindings): a saved binding's device is a position in the saving
 * machine's giddi list. Each device record's saved name is matched
 * (stricmp) against the devices loaded now, every binding's device is
 * renumbered through its record (-1 when the device is not here), and the
 * records are refilled from the current list. A missing device's record
 * keeps its old name after a NUL in the first byte; a present one gets the
 * name strncpy'd in 16 bytes, which runs 4 bytes past the 12-byte field
 * into the next record's number (rewritten on the next pass) and, for
 * record 15, into controlsDeviceChosen[0] (controls_choose_bound_devices
 * recomputes it).
 *
 * @mw2shell controls_renumber_devices 0x00020620
 * @fidelity exact
 */
export function controlsRenumberDevices(bindings: number): void {
  const m = mem();
  for (let j = 0; j < 16; j++) m.setI32(deviceRecordAt(j) + RECORD.number, -1);
  for (let i = 0; i < 16; i++) {
    const dev = inputDeviceGet(i);
    if (!dev) break;
    for (let j = 0; j < 16; j++) {
      if (dev.name.length === 0) break;
      if (stricmp(m.cstr(deviceRecordAt(j) + RECORD.name), dev.name) === 0) m.setI32(deviceRecordAt(j) + RECORD.number, i);
    }
  }
  for (let k = 0; k < BINDING_COUNT; k++) {
    const b = bindingAt(bindings, k);
    const d = bindingField(b, 'device');
    if (d > -1) setBindingField(b, 'device', m.i32(deviceRecordAt(d) + RECORD.number));
  }
  for (let i = 0; i < 16; i++) {
    const dev = inputDeviceGet(i);
    const a = deviceRecordAt(i);
    if (!dev) {
      m.setI32(a + RECORD.number, -1);
      m.setU8(a + RECORD.name, 0);
    } else {
      m.setI32(a + RECORD.number, i);
      if (i === 15) quirk('controls_renumber_devices: strncpy of 16 bytes into record 15\'s 12-byte name overwrites controlsDeviceChosen[0]');
      m.strncpy(a + RECORD.name, dev.name, 0x10);
    }
  }
}

/**
 * Re-derives the device panel's choice from the bindings: the keyboard,
 * plus every device a binding of the four pages uses (controlsDevice
 * becomes the last such), then only the first four of those that exist
 * stay chosen (controlsDeviceCount).
 *
 * @mw2shell controls_choose_bound_devices 0x00020540
 * @fidelity exact
 */
export function controlsChooseBoundDevices(): void {
  for (let i = 0; i < 16; i++) {
    const dev = inputDeviceGet(i);
    // 0x738d8 'keyboard'
    setChosen(i, dev && dev.name === 'keyboard' ? 1 : 0);
  }
  for (let k = 0; k < BINDING_COUNT; k++) {
    const d = bindingField(bindingAt(BINDINGS, k), 'device');
    if (d > -1) {
      setInt(SHELL_LABEL.controlsDevice, d);
      mem().setI32(CHOSEN + d * 4, 1);
    }
  }
  setInt(SHELL_LABEL.controlsDeviceCount, 0);
  for (let i = 0; i < 16; i++) {
    const count = getInt(SHELL_LABEL.controlsDeviceCount);
    if (!inputDeviceGet(i) || chosen(i) === 0 || count > 3) setChosen(i, 0);
    else setInt(SHELL_LABEL.controlsDeviceCount, count + 1);
  }
}

/** The file index and the slot a Load / Save Custom row asks for (row 0: config00, keeping the slot). */
function configSlotOf(row: number): { file: number; slot: number } {
  const current = getInt(SHELL_LABEL.controlsConfigSlot);
  if (row === 0) return { file: 0, slot: current };
  const extra = mem().i32(row + WIDGET.extra);
  return extra < 0 ? { file: current, slot: current } : { file: extra, slot: extra };
}

/** sprintf("giddi\\config%02d.cpc", n) (0x738f1 / 0x73909) */
export function configFileName(n: number): string {
  return `giddi\\config${String(n).padStart(2, '0')}.cpc`;
}

/**
 * A Load Custom row's click (row.extra = 1..4; a negative extra reloads the
 * current slot), or row 0 for config00 keeping the slot: reads
 * giddi\config%02d.cpc - the name, the 16 device records and the bindings -
 * then renumbers the bindings' devices onto the current list and re-derives
 * the chosen devices; back to the first page. A file that does not open
 * changes nothing but controlsConfigSlot.
 *
 * @mw2shell controls_load_config 0x00020a40
 * @fidelity exact
 */
export function controlsLoadConfig(row: number): void {
  const { file, slot } = configSlotOf(row);
  setInt(SHELL_LABEL.controlsConfigSlot, slot);
  // 0x73906 'rb'
  const f = dosFileLoad(configFileName(file));
  if (!f) return;
  let pos = freadInto(f, 0, NAME, CONFIG_NAME_BYTES);
  pos = freadInto(f, pos, RECORDS, RECORDS_BYTES);
  freadInto(f, pos, BINDINGS, BINDINGS_BYTES);
  controlsRenumberDevices(BINDINGS);
  controlsChooseBoundDevices();
  setInt(SHELL_LABEL.controlsPage, 0);
  setInt(SHELL_LABEL.controlsBindings, BINDINGS);
}

/**
 * controls_save_config's file part: sets controlsConfigSlot, renames a
 * 'Default Config' or 'Custom Config #...' configuration 'Custom Config #n'
 * when saving to a Custom slot n, and writes giddi\config%02d.cpc in
 * controls_load_config's layout. Returns the file index (0: config00).
 *
 * @portOnly controls_save_config (0x20b00) up to its message box, for callers that cannot block
 */
export function controlsSaveConfigFile(row: number): number {
  const { file, slot } = configSlotOf(row);
  setInt(SHELL_LABEL.controlsConfigSlot, slot);
  const m = mem();
  // the path is sprintf'd into controlsSaveText, which the message reuses
  m.strcpy(SHELL_LABEL.controlsSaveText, configFileName(file));
  if (file !== 0) {
    const name = m.cstr(NAME, CONFIG_NAME_BYTES);
    // 0x7391e 'Default Config'; 0x7393f 'Custom Config #' (strncmp, 15); 0x7392d / 0x7394f 'Custom Config #%d'
    if (name === 'Default Config' || name.startsWith('Custom Config #')) m.strcpy(NAME, `Custom Config #${file}`);
  }
  // 0x73961 'wb'
  const out = new Uint8Array(CPC_BYTES);
  out.set(m.view(NAME, CONFIG_NAME_BYTES), 0);
  out.set(m.view(RECORDS, RECORDS_BYTES), CONFIG_NAME_BYTES);
  out.set(m.view(BINDINGS, BINDINGS_BYTES), CONFIG_NAME_BYTES + RECORDS_BYTES);
  dosFileWrite(configFileName(file), out);
  quirk('controls_save_config: fclose is called a second time on the closed file');
  return file;
}

/**
 * A Save Custom row's click (row.extra = 1..4), or row 0 for config00 (what
 * ACCEPT CONFIG AND EXIT saves): the file (controlsSaveConfigFile), then -
 * not for config00 - "Configuration %d Saved." (0x73964).
 *
 * @mw2shell controls_save_config 0x00020b00
 * @fidelity exact
 * @divergence returns nothing: the original returns the message box's answer or the second fclose's result, and every caller discards it
 */
export function* controlsSaveConfig(row: number): Blocking<void> {
  const file = controlsSaveConfigFile(row);
  if (file !== 0) {
    // sprintf(controlsSaveText, 0x73964 'Configuration %d Saved.#Ok', n)
    const m = mem();
    m.strcpy(SHELL_LABEL.controlsSaveText, m.cstr(0x73964).replace('%d', String(file)));
    yield* messageBox(m.cstr(SHELL_LABEL.controlsSaveText), 0);
  }
}

/**
 * RESET DEFAULTS (and the device panel's ACCEPT and CUSTOM CONFIGURATION):
 * clears the bindings, then for each chosen device in list order reads its
 * own giddi\<device>.cpc - name, records, and bindings into
 * controlDefaultsScratch - renumbers those onto the current devices, and
 * copies each of that device's bindings to the first page, from the one it
 * was saved on, where the control is unbound; a page already holding the
 * identical binding stops the search. The name becomes 'Default Config'
 * (strcpy'd over the .cpc's own); controlsDevice is kept.
 *
 * @mw2shell controls_reset_defaults 0x00020c10
 * @fidelity exact
 */
export function controlsResetDefaults(): void {
  const m = mem();
  const keep = getInt(SHELL_LABEL.controlsDevice);
  controlsClearBindings();
  for (let dev = 0; dev < 16; dev++) {
    setInt(SHELL_LABEL.controlsDevice, dev);
    if (chosen(dev) === 0) continue;
    const d = inputDeviceGet(dev);
    // 0x738e1 'giddi\%s.cpc', 0x738ee 'rb'
    const f = dosFileLoad(`giddi\\${d ? d.name : ''}.cpc`);
    if (!f) continue;
    let pos = freadInto(f, 0, NAME, CONFIG_NAME_BYTES);
    pos = freadInto(f, pos, RECORDS, RECORDS_BYTES);
    freadInto(f, pos, SCRATCH, BINDINGS_BYTES);
    controlsRenumberDevices(SCRATCH);
    for (let page = 0; page < 4; page++) {
      for (let c = 0; c < CONTROLS; c++) {
        const src = bindingAt(SCRATCH, page * CONTROLS + c);
        if (bindingField(src, 'device') !== dev) continue;
        // from page 0 of the same control, one page (0x378 bytes) at a time, while below 0xde0 + the control's offset: all four pages
        const limit = c * BINDING_SIZE + BINDINGS_BYTES;
        for (let off = c * BINDING_SIZE; off < limit; off += CONTROLS * BINDING_SIZE) {
          const dst = BINDINGS + off;
          if (sameBinding(dst, src)) break;
          if (bindingField(dst, 'device') > -1) continue;
          m.copy(dst, src, BINDING_SIZE);
          break;
        }
      }
    }
    setInt(SHELL_LABEL.controlsPage, 0);
    setInt(SHELL_LABEL.controlsBindings, BINDINGS);
  }
  // 0x7397f 'Default Config'
  m.strcpy(NAME, 'Default Config');
  setInt(SHELL_LABEL.controlsDevice, keep);
}

/** the six fields compared in the order the original does (device, kind, flags, input, input2, flags2) */
function sameBinding(a: number, b: number): boolean {
  const m = mem();
  for (let o = 0; o < BINDING_SIZE; o += 4) if (m.i32(a + o) !== m.i32(b + o)) return false;
  return true;
}

/** Watcom's stricmp: compares tolower'd characters up to the first difference or NUL; <0 / 0 / >0 */
function stricmp(a: string, b: string): number {
  const lower = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
  for (let i = 0; ; i++) {
    const x = lower(i < a.length ? a.charCodeAt(i) : 0);
    const y = lower(i < b.length ? b.charCodeAt(i) : 0);
    if (x !== y) return x - y;
    if (x === 0) return 0;
  }
}

/**
 * controls_screen's start, up to its panels, which is all of it that
 * touches the configuration: controlsConfigSlot 0; the devices loaded
 * (input_devices_load; none: the screen does nothing); the 16 device
 * records filled from the list (a missing device: number -1 and an empty
 * name), the keyboard the only device chosen and the one shown
 * (controlsDevice), its number kept in controlsKeyboardDevice for
 * controls_write_temp_map's fixed lines. With no keyboard it stops there
 * (the screen says "Error: keyboard.dll not found."). Then the name
 * 'NO CONFIG', the bindings cleared, config00 loaded and the chosen devices
 * re-derived from it; the Buttons list at the top, the first page and no
 * cell selected (controlsSelectedControl -1, the EDX the original loads
 * before controls_clear_bindings and every call up to its store preserves).
 *
 * Returns controlsKeyboardDevice: the keyboard's device number, or -1
 * (inputDeviceCount() tells no devices from no keyboard).
 *
 * @portOnly controls_screen (0x21020) up to its panels: the screen runs it, and so does the first-run seed, which has no screen
 */
export function controlsScreenSetup(): number {
  setInt(SHELL_LABEL.controlsConfigSlot, 0);
  if (inputDevicesLoad() === 0) return -1;
  const m = mem();
  setInt(SHELL_LABEL.controlsKeyboardDevice, -1);
  for (let i = 0; i < 16; i++) {
    const dev = inputDeviceGet(i);
    const a = deviceRecordAt(i);
    if (!dev) {
      m.setI32(a + RECORD.number, -1);
      // 0x73a59 ''
      m.strcpy(a + RECORD.name, m.cstr(0x73a59));
      setChosen(i, 0);
    } else {
      m.setI32(a + RECORD.number, i);
      m.strcpy(a + RECORD.name, dev.name);
      // strcmp(name, 0x73a50 'keyboard')
      if (dev.name === m.cstr(0x73a50)) {
        setInt(SHELL_LABEL.controlsKeyboardDevice, i);
        setInt(SHELL_LABEL.controlsDevice, i);
        setChosen(i, 1);
      } else setChosen(i, 0);
    }
  }
  if (controlsKeyboardDevice() < 0) return -1;
  // 0x73a7c 'NO CONFIG'
  m.strcpy(NAME, m.cstr(0x73a7c));
  controlsClearBindings();
  controlsLoadConfig(0);
  controlsChooseBoundDevices();
  setInt(SHELL_LABEL.controlsButtonScroll, 0);
  setInt(SHELL_LABEL.controlsSelectedColumn, 0);
  setInt(SHELL_LABEL.controlsPage, 0);
  setInt(SHELL_LABEL.controlsBindings, BINDINGS);
  setInt(SHELL_LABEL.controlsSelectedControl, -1);
  return controlsKeyboardDevice();
}

/** @portOnly controlsDeviceChosen[i] = v */
export function setControlsDeviceChosen(i: number, v: number): void {
  setChosen(i, v);
}
