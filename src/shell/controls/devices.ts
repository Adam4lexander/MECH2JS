/**
 * The input devices the COCKPIT CONTROLS screen lists: every GIDDI driver
 * in giddi\ (decompiled/mw2shell/src/input/shell_input.c, 0x19950..0x1a9e0).
 * Each is loaded and asked for its record (the driver's init, method +8),
 * which gives the shell an InputDevice (0x41 bytes, byte-packed): the
 * driver's file name, its axis and button counts, a display name, and per
 * axis and button a title (what the lists show) and a name (what a binding
 * cell and input.map show).
 *
 * The array is a heap block (malloc'd 50 records at a time) and stays a JS
 * array here; its count, inputDeviceCount (0x7a164), is the shell's static
 * int in shell memory.
 */
import { divergence } from '../../core/provenance.ts';
import { dosFileLoad, dosFindFiles } from '../../engine/dosFiles.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { lxModuleLoad } from '../../data/exe/tables/menus.ts';
import { emptyRecord, giddiDriverFor, type GiddiDriver, type GiddiRecord } from '../../sim/controls/giddi.ts';
import { mem } from '../memory.ts';

/**
 * An InputDevice. `record` is the part the driver's init fills, from +0xd:
 * axisCount (+0xd), buttonCount (+0x11), displayName (+0x19), axisTitles
 * (+0x29), axisNames (+0x2d), buttonTitles (+0x35), buttonNames (+0x39).
 */
export interface ShellInputDevice {
  /** +0x00 char[9]: the DLL's file name without '.dll', lower case ('keyboard') */
  name: string;
  /** +0x09: the loaded driver; null in a record nothing has filled */
  driver: GiddiDriver | null;
  /** +0x0d.. */
  record: GiddiRecord;
}

function emptyDevice(): ShellInputDevice {
  return { name: '', driver: null, record: emptyRecord() };
}

export const shellInput = registerGlobals(
  'shellInput',
  {
    /** inputDevices (0x7a16c): the heap array, or null (NULL) before input_devices_load */
    devices: null as ShellInputDevice[] | null,
    /** 0x7a168: how many records the array has room for (grown 50 at a time) */
    capacity: 0,
  },
  () => {
    shellInput.devices = null;
    shellInput.capacity = 0;
  },
  'mw2shell',
);

/** @portOnly inputDeviceCount (0x7a164) */
export function inputDeviceCount(): number {
  return mem().i32(SHELL_LABEL.inputDeviceCount);
}

function setInputDeviceCount(n: number): void {
  mem().setI32(SHELL_LABEL.inputDeviceCount, n);
}

/**
 * (index): the device record, or null outside 0..inputDeviceCount-1.
 *
 * @mw2shell input_device_get 0x0001a690
 * @fidelity exact
 */
export function inputDeviceGet(index: number): ShellInputDevice | null {
  if (index > -1 && index < inputDeviceCount() && shellInput.devices) return shellInput.devices[index] ?? null;
  return null;
}

/**
 * Grows the device array by 50 zeroed records (malloc the first time,
 * realloc after). Returns the new capacity; 0 when the allocation fails,
 * which in the port it does not.
 *
 * @mw2shell input_devices_grow 0x0001a8e0
 * @fidelity exact
 */
export function inputDevicesGrow(): number {
  const d = (shellInput.devices ??= []);
  for (let i = 0; i < 50; i++) d[shellInput.capacity + i] = emptyDevice();
  shellInput.capacity += 50;
  return shellInput.capacity;
}

/**
 * Lists giddi\ and loads every '.dll' there as an input device, unless the
 * array is already built. A file whose name contains '.dll' (after
 * lower-casing) takes the next slot: the file is read whole
 * ('giddi\' + its name, file_load), loaded as an LX module (flags 5: from
 * memory, into a new block), its name up to '.dll' kept (9 bytes) and the
 * driver's init called on the record. A file that will not read or load
 * gives its slot back. Returns inputDeviceCount; 0 when giddi\ cannot be
 * listed or the array cannot grow.
 *
 * @mw2shell input_devices_load 0x0001a530
 * @fidelity partial
 * @divergence the directory is listed in name order (dosFindFiles), where DOS's readdir gives the FAT directory's order; the install's giddi\ lists alphabetically (its .cpc device records say so), so the two agree there
 * @divergence the loaded module's methods are the port's implementations of the shipped drivers (sim/controls/giddi.ts, giddiDriverFor); a driver the port has none for - the joysticks, FLTSTCK, MSJSTICK, TMASTER, VIO1/2 - is dropped the way the original drops a DLL that fails to load, so the port lists only KEYBOARD and MOUSE
 */
export function inputDevicesLoad(): number {
  if (shellInput.devices !== null) return inputDeviceCount();
  // opendir("giddi") / readdir: every file in the directory
  const files = dosFindFiles('giddi\\*');
  for (const entry of files) {
    // strlwr, then strstr(name, ".dll")
    const lower = entry.toLowerCase();
    const at = lower.indexOf('.dll');
    if (at < 0) continue;
    const slot = inputDeviceCount();
    setInputDeviceCount(slot + 1);
    if (shellInput.capacity < slot + 1 && inputDevicesGrow() === 0) return 0;
    // "giddi\" + the file name; file_load (0x1a360) returns NULL for a file it cannot read
    const file = dosFileLoad('giddi\\' + lower);
    if (!file) {
      setInputDeviceCount(inputDeviceCount() - 1);
      continue;
    }
    const name = lower.slice(0, at).slice(0, 9);
    // lx_module_load (0x19d50) with flags 5
    const module = lxModuleLoad(file);
    const driver = module ? giddiDriverFor(name, module) : null;
    if (!driver) {
      if (module) divergence(`input_devices_load: no port driver for giddi\\${lower}; dropped as a DLL that will not load`);
      setInputDeviceCount(inputDeviceCount() - 1);
      continue;
    }
    // strncpy(name, 9); driver; (*driver[+8])(&axisCount)
    const dev = shellInput.devices![slot]!;
    dev.name = name;
    dev.driver = driver;
    driver.init(dev.record);
  }
  // closedir
  return inputDeviceCount();
}

/**
 * Frees every device's driver and the array: inputDevices = NULL, count and
 * capacity 0. controls_screen's last act.
 *
 * @mw2shell input_devices_free 0x0001a6c0
 * @fidelity exact
 */
export function inputDevicesFree(): void {
  shellInput.devices = null;
  setInputDeviceCount(0);
  shellInput.capacity = 0;
}
