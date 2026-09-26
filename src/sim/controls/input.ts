/**
 * The game's input layer (input.c): INPUT.MAP binds the control channels of
 * playerControls to buttons and axes of GIDDI devices; GAMEKEY.MAP binds
 * keystrokes to commands. input_poll_controls runs once a frame and fills
 * playerControls from the devices.
 *
 * Three tables, sized and laid out as input_add_discrete and its helpers
 * write them:
 *
 *   analog controls  0x983f0, 0x80 bytes each, at most 50 (count 0x983d8):
 *     +0 device (-1: none), +4 the device's channel, +8 -> that channel's
 *     value in the device's analog buffer (0 with no device), +0xc the last
 *     value taken from it, +0x10 sign (+1 / -1 from the map's '+' / '-'),
 *     +0x14 -> its sink, +0x18 chord count, +0x1c up to 8 chord entries,
 *     +0x7c 'menu_' channel
 *   analog sinks     0x99cf0, 0x32 bytes each, at most 50 (count 0x983dc):
 *     one per channel slot; the normalised value (-0x10000..+0x10000) and
 *     the linear map onto the channel's range (see input_poll_controls)
 *   discrete         0x9a6b4, 0x6e bytes each, at most 100 (count 0x983e0):
 *     +0 -> the channel's byte slot, +4 edge-only, +5 the chord's state last
 *     frame, +6 chord count, +0xa 'menu_' channel, +0xe up to 8 chord entries
 *
 * A chord entry is a device button that must be down, or ('-') up: a
 * pointer to a word of the device's button bits and the bit's mask.
 */
import { divergence, unestablished } from '../../core/provenance.ts';
import { systemError } from '../../core/systemError.ts';
import { STRUCTS } from '../../generated/structs.gen.ts';
import { lxModuleLoad } from '../../data/exe/tables/menus.ts';
import { readControlChannels, inputTorsoTilt, type ControlChannel, PLAYER_CONTROLS } from '../../data/exe/tables/controlChannels.ts';
import { clock } from '../../engine/clock.ts';
import { dosFileLoad, dosFopen, type DosTextFile } from '../../engine/dosFiles.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage } from '../../engine/image.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { emptyRecord, giddiDriverFor, type GiddiDriver, type GiddiRecord } from './giddi.ts';
import { inputGlobals } from './inputGlobals.ts';

export interface ChordEntry {
  /** the device whose button word is tested */
  device: number;
  /** word index into its button bits */
  word: number;
  mask: number;
  /** 1: the button must be up ('-') */
  negate: number;
}

/** A playerControls slot: the field of ControlState a channel writes. */
export interface Slot {
  field: string;
  /** 'int' for analog channels, 'byte' for buttons */
  width: 'int' | 'byte';
}

export class AnalogSink {
  /** +0x00 the channel's slot */
  slot: Slot | null = null;
  /** +0x04 -> +0x16 (the velocity), or -> +0x1a (the value itself) for a '_delta' channel */
  velIsValue = false;
  /** +0x08 max - min */
  scale = 0;
  /** +0x0c min << 16 */
  offset = 0;
  /** +0x10 the rest value: field_0xc normalised into -0x10000..+0x10000 */
  rest = 0;
  /** +0x14 the right shift applied when writing the slot */
  shift = 0;
  /** +0x15 1 once something set the value this frame */
  moved = 0;
  /** +0x16 */
  vel = 0;
  /** +0x1a the normalised value */
  value = 0;
  /** +0x1e the acceleration shift for keyboard-driven movement (the channel's +0x18) */
  accelShift = 0;
  /** +0x22, +0x26, +0x2a, +0x2e: the <name>_plus, _minus, _reset and _set channels' slots (byte), or null */
  plus: Slot | null = null;
  minus: Slot | null = null;
  reset: Slot | null = null;
  set: Slot | null = null;

  getVel(): number {
    return this.velIsValue ? this.value : this.vel;
  }
  setVel(v: number): void {
    if (this.velIsValue) this.value = v | 0;
    else this.vel = v | 0;
  }
}

export class AnalogControl {
  device = -1;
  channel = 0;
  /** +0x08: whether the device's analog buffer entry is bound */
  hasValue = false;
  /** +0x0c */
  last = 0;
  /** +0x10 */
  sign = 0;
  sink: AnalogSink | null = null;
  chord: ChordEntry[] = [];
  isMenu = 0;
}

export class DiscreteControl {
  slot: Slot | null = null;
  /** +0x04: 1 for action channels (kind 2), which only see a chord's first frame */
  edge = 0;
  /** +0x05 */
  prev = 0;
  chord: ChordEntry[] = [];
  /** +0x0a */
  isMenu = 0;
}

export interface InputDevice {
  /** 0x1529a0 + i * 0x28 */
  name: string;
  /** 0x152cfc[i] */
  driver: GiddiDriver;
  /** 0x152bf8 + i * 0x34 */
  record: GiddiRecord;
  /** 0x152a68 + i * 0x50: 16 analog values */
  analog: Int32Array;
  /** 0x152aa8 + i * 0x50: 128 button bits */
  bits: Uint32Array;
}

export const input = registerGlobals(
  'inputTables',
  {
    /** 0x9d1ac count, and the devices */
    devices: [] as InputDevice[],
    /** 0x983e8: the device index of 'keyboard', whose readKey feeds controlKey */
    keyboardDevice: 0,
    /** 0x983d8 count */
    analogControls: [] as AnalogControl[],
    /** 0x983dc count */
    sinks: [] as AnalogSink[],
    /** 0x983e0 count */
    discrete: [] as DiscreteControl[],
    /** 0x983e4: 1 while the game's own controls are live (input_sub_048c50 / _048c60 clear and set it around a menu); 'menu_' channels are read either way */
    gameControlsLive: 1,
    /** 0x983ec: the line number the map parsers report errors against */
    mapLine: 0,
    /** 0x9dfa1: keystroke word -> command id, 0x800 entries (GAMEKEY.MAP) */
    keyCommands: new Uint8Array(0x800),
    /** the control channel table (0x9d1c4), read from the image once per load */
    channels: [] as ControlChannel[],
  },
  () => {
    const t = input;
    t.devices = [];
    t.keyboardDevice = 0;
    t.analogControls = [];
    t.sinks = [];
    t.discrete = [];
    t.gameControlsLive = 1;
    t.mapLine = 0;
    t.keyCommands = new Uint8Array(0x800);
    t.channels = [];
  },
);

const slotFields = new Map<number, string>(STRUCTS.ControlState.fields.filter((f) => f.kind !== 'pad').map((f) => [f.offset, f.name]));

function slotOf(ch: ControlChannel | null): Slot | null {
  if (!ch) return null;
  const field = slotFields.get(ch.slot - PLAYER_CONTROLS);
  if (!field) throw new Error(`control channel ${ch.name}: slot 0x${ch.slot.toString(16)} is not a ControlState field`);
  return { field, width: ch.kind === 0 ? 'int' : 'byte' };
}

function slotGet(s: Slot): number {
  return (mechs.playerControls as unknown as Record<string, number>)[s.field]!;
}

function slotSet(s: Slot, v: number): void {
  (mechs.playerControls as unknown as Record<string, number>)[s.field] = s.width === 'byte' ? v & 0xff : v | 0;
}

function channel(name: string): ControlChannel | null {
  if (input.channels.length === 0) {
    const exe = bootImage();
    if (!exe) return null;
    input.channels = readControlChannels(exe);
  }
  return inputTorsoTilt(input.channels, name);
}

/** Watcom stricmp */
function stricmp(a: string, b: string): number {
  for (let i = 0; ; i++) {
    let x = i < a.length ? a.charCodeAt(i) : 0;
    let y = i < b.length ? b.charCodeAt(i) : 0;
    if (x >= 0x41 && x <= 0x5a) x += 0x20;
    if (y >= 0x41 && y <= 0x5a) y += 0x20;
    if (x !== y || x === 0) return x - y;
  }
}

/** Watcom's ctype bits (0x952c8): 2 space, 0x20 digit */
const isSpace = (c: number) => c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x20;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/** atoi (clib_sub_0628fa) */
function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? parseInt(m[1]!, 10) | 0 : 0;
}

/** sscanf's %s: skip white space, take a run of non-space */
function scanToken(s: string, at: number): [string, number] | null {
  while (at < s.length && isSpace(s.charCodeAt(at))) at++;
  let e = at;
  while (e < s.length && !isSpace(s.charCodeAt(e))) e++;
  return e > at ? [s.slice(at, e), e] : null;
}

/** sscanf(line, " %1[+-] %s %s") -> the conversions made */
function scanBinding(line: string): [string, string, string] | null {
  let at = 0;
  while (at < line.length && isSpace(line.charCodeAt(at))) at++;
  const c = line[at];
  if (c !== '+' && c !== '-') return null;
  const a = scanToken(line, at + 1);
  if (!a) return null;
  const b = scanToken(line, a[1]);
  if (!b) return null;
  return [c, a[0], b[0]];
}

/**
 * The next line with something on it, cut at '\n' or '#'; null at end of
 * file. Counts lines into mapLine.
 *
 * @mw2 input_sub_047a00 0x00047a00
 * @fidelity exact
 */
export function inputSub047a00(f: DosTextFile, n: number): string | null {
  for (;;) {
    let line = f.fgets(n);
    if (line === null) return null;
    input.mapLine = (input.mapLine + 1) | 0;
    let any = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 0x0a || c === 0x23) {
        line = line.slice(0, i);
        break;
      }
      if (!isSpace(c)) any = true;
    }
    if (any) return line;
  }
}

/**
 * The device with this name, opening it (GIDDI\<name>.DLL) the first time.
 * Returns its index, or -1.
 *
 * @mw2 input_open_device 0x000476a0
 * @fidelity exact
 * @divergence the driver's methods are the port's implementations of the shipped DLL (sim/controls/giddi.ts), bound to the loaded module; a device without one fails as a module that will not load
 */
export function inputOpenDevice(name: string): number {
  const t = input;
  for (let i = 0; i < t.devices.length; i++) if (stricmp(t.devices[i]!.name, name) === 0) return i;
  if (4 < t.devices.length) {
    systemError(0x11, 'Too many input devices specified');
    return -1;
  }
  const file = dosFileLoad(`giddi\\${name}.dll`);
  if (!file) {
    systemError(0x11, `Can't find input device "${name}"`);
    return -1;
  }
  const idx = t.devices.length;
  const m = lxModuleLoad(file);
  const driver = m ? giddiDriverFor(name, m) : null;
  if (!driver) {
    systemError(0x11, `Can't load input device "${name}"`);
    return -1;
  }
  const dev: InputDevice = { name: name.slice(0, 0x27), driver, record: emptyRecord(), analog: new Int32Array(16), bits: new Uint32Array(4) };
  t.devices.push(dev);
  driver.init(dev.record);
  if (stricmp(name, 'keyboard') === 0) t.keyboardDevice = idx;
  return idx;
}

/**
 * The index of an analog channel on a device, by name (or a number).
 *
 * @mw2 input_bind_channel 0x000478a0
 * @fidelity exact
 */
export function inputBindChannel(device: number, name: string): number {
  return bindIn(device, name, (r) => [r.analogNames, r.analogCount]);
}

/**
 * The index of a button on a device, by name (or a number).
 *
 * @mw2 input_bind_channel_2 0x00047950
 * @fidelity exact
 */
export function inputBindChannel2(device: number, name: string): number {
  return bindIn(device, name, (r) => [r.buttonNames, r.buttonCount]);
}

function bindIn(device: number, name: string, pick: (r: GiddiRecord) => [(string | null)[] | null, number]): number {
  if (isDigit(name.charCodeAt(0))) return atoi(name);
  const dev = input.devices[device];
  const [names, count] = dev ? pick(dev.record) : [null, 0];
  if (names) {
    for (let i = 0; i < count; i++) {
      const n = names[i];
      if (n && stricmp(n, name) === 0) return i;
    }
  }
  systemError(0x11, `No input channel "${name}". Line ${input.mapLine}`);
  return 0;
}

/**
 * Reads a binding's chord - the lines up to '}' - into `out`.
 *
 * @mw2 input_parse_chord 0x00047ed0
 * @fidelity exact
 */
export function inputParseChord(f: DosTextFile, out: ChordEntry[]): number {
  out.length = 0;
  for (;;) {
    const line = inputSub047a00(f, 0xff);
    if (line === null || line[0] === '}') return 1;
    const b = scanBinding(line);
    if (!b) {
      systemError(0x11, `input mapping error: line ${input.mapLine}, reading chord`);
      return 0;
    }
    if (7 < out.length) {
      systemError(0x11, `input mapping error: line ${input.mapLine}, chord too big`);
      return 0;
    }
    const dev = inputOpenDevice(b[1]);
    const idx = inputBindChannel2(dev, b[2]);
    out.push({ device: dev, word: idx >> 5, mask: (1 << (idx & 31)) >>> 0, negate: b[0] === '-' ? 1 : 0 });
  }
}

/**
 * The sink for a channel's slot, made on first use. Its range comes from the
 * channel record; its plus, minus, set and reset channels are found by name.
 *
 * @mw2 input_add_analog_sink 0x00047a80
 * @fidelity exact
 */
export function inputAddAnalogSink(ch: ControlChannel): AnalogSink | null {
  const t = input;
  for (const s of t.sinks) if (s.slot && ch.slot - PLAYER_CONTROLS === slotOffset(s.slot)) return s;
  if (0x32 < t.sinks.length + 1) {
    systemError(0x11, `Too many analog sinks: line ${t.mapLine}`);
    return null;
  }
  const s = new AnalogSink();
  t.sinks.push(s);
  s.velIsValue = ch.name.includes('_delta');
  s.slot = slotOf(ch);
  s.scale = (ch.max - ch.min) | 0;
  s.offset = (ch.min << 16) | 0;
  s.shift = ch.shift & 0xff;
  // idiv: the quotient truncates before the 0x10000 comes off
  s.rest = (Math.trunc(((((ch.field_0xc << 16) - s.offset) | 0) * 2) / s.scale) - 0x10000) | 0;
  s.accelShift = ch.field_0x18 & 0xff;
  s.value = s.rest;
  const base = ch.name.includes('_delta') ? ch.name.slice(0, ch.name.indexOf('_delta')) : ch.name;
  const sub = (suffix: string) => {
    const c = channel(base + suffix);
    return c ? slotOf({ ...c, kind: 1 }) : null;
  };
  s.plus = sub('_plus');
  s.minus = sub('_minus');
  s.set = sub('_set');
  s.reset = sub('_reset');
  return s;
}

function slotOffset(s: Slot): number {
  return STRUCTS.ControlState.fields.find((f) => f.name === s.field)!.offset;
}

/**
 * The analog control for a channel on a device (or on none), made or
 * extended. Returns its index, or -1.
 *
 * @mw2 input_add_analog_control 0x00047d80
 * @fidelity exact
 */
export function inputAddAnalogControl(ch: ControlChannel, device: string | null, devChannel: number): number {
  const t = input;
  const off = ch.slot - PLAYER_CONTROLS;
  for (let i = 0; i < t.analogControls.length; i++) {
    const c = t.analogControls[i]!;
    if (c.sink && c.sink.slot && slotOffset(c.sink.slot) === off) {
      if (device === null) return i;
      if (!c.hasValue) {
        c.device = inputOpenDevice(device);
        c.channel = devChannel;
        c.hasValue = true;
        return i;
      }
    }
  }
  if (!(t.analogControls.length + 1 < 0x33)) {
    systemError(0x11, `Too many analog controls: line ${t.mapLine}`);
    return -1;
  }
  const c = new AnalogControl();
  const i = t.analogControls.length;
  t.analogControls.push(c);
  c.device = device === null ? -1 : inputOpenDevice(device);
  c.channel = devChannel;
  c.sink = inputAddAnalogSink(ch);
  c.hasValue = c.device >= 0;
  c.isMenu = ch.name.slice(0, 5).toLowerCase() === 'menu_' ? 1 : 0;
  return i;
}

/**
 * Reads a map file: each "<channel> {" block binds the channel to a device
 * button chord, or (an analog channel) to a device axis and a chord that
 * gates it.
 *
 * @mw2 input_add_discrete 0x00048090
 * @fidelity exact
 */
export function inputAddDiscrete(f: DosTextFile): number {
  const t = input;
  for (;;) {
    const line = inputSub047a00(f, 0xff);
    if (line === null) return 1;
    const tok = scanToken(line, 0);
    if (!tok) {
      systemError(0x11, `input mapping error: line ${t.mapLine}, reading control`);
      return 0;
    }
    let name = tok[0];
    let ch = channel(name);
    if (!ch) {
      systemError(0x11, `input mapping error: line ${t.mapLine}, bad control "${name}"`);
      return 0;
    }
    const isMenu = name.slice(0, 5).toLowerCase() === 'menu_' ? 1 : 0;
    if (ch.kind === 0) {
      const l2 = inputSub047a00(f, 0xff);
      if (l2 === null) {
        systemError(0x11, `input mapping error: line ${t.mapLine}, unexpected end of file`);
        return 0;
      }
      const b = scanBinding(l2);
      if (!b) {
        systemError(0x11, `input mapping error: line ${t.mapLine}, reading analog "${name}"`);
        return 0;
      }
      const dev = inputOpenDevice(b[1]);
      const idx = inputBindChannel(dev, b[2]);
      const ci = inputAddAnalogControl(ch, b[1], idx);
      if (ci < 0) return 0;
      const c = t.analogControls[ci]!;
      c.sign = b[0] === '-' ? -1 : 1;
      if (!inputParseChord(f, c.chord)) return 0;
      continue;
    }
    const d = new DiscreteControl();
    d.slot = slotOf(ch);
    if (ch.kind !== 1) {
      t.discrete.push(d);
      d.edge = 1;
      d.isMenu = isMenu;
      if (!inputParseChord(f, d.chord)) return 0;
      continue;
    }
    if (100 < t.discrete.length + 1) {
      systemError(0x11, `Too many discrete controls: line ${t.mapLine}`);
      return 0;
    }
    t.discrete.push(d);
    d.edge = 0;
    if (!inputParseChord(f, d.chord)) return 0;
    d.isMenu = isMenu;
    let at = name.indexOf('_plus');
    if (at < 0) at = name.indexOf('_minus');
    if (at >= 0) {
      name = name.slice(0, at);
      ch = channel(name);
      if (!ch) ch = channel(name + '_delta');
      if (ch && inputAddAnalogControl(ch, null, 0) < 0) return 0;
    }
  }
}

/**
 * INPUT.MAP, then each opened device's own GIDDI\<device>.STD.
 *
 * @mw2 input_load_map 0x000483b0
 * @fidelity exact
 */
export function inputLoadMap(): number {
  const f = dosFopen('input.map');
  if (!f) {
    systemError(0x11, "Can't open input mapping file");
    return 0;
  }
  inputAddDiscrete(f);
  for (let i = 0; i < input.devices.length; i++) {
    const std = dosFopen(`giddi\\${input.devices[i]!.name}.std`);
    if (std) inputAddDiscrete(std);
  }
  return 1;
}

/** 0x9e7a4: the 22 key names GAMEKEY.MAP may use, and their keystroke values */
function keyNames(): [string, number][] {
  const exe = bootImage();
  if (!exe) return [];
  return Array.from({ length: 0x16 }, (_, i) => [exe.strPtr(0x9e7a4 + i * 6) ?? '', exe.i16(0x9e7a8 + i * 6)]);
}

/** commandNames (0x9dca4): 0x99 records of a name pointer and a command id byte */
function commandNames(): [string, number][] {
  const exe = bootImage();
  if (!exe) return [];
  return Array.from({ length: 0x99 }, (_, i) => [exe.strPtr(0x9dca4 + i * 5) ?? '', exe.u8(0x9dca8 + i * 5)]);
}

/**
 * GAMEKEY.MAP: "<COMMAND> <key>" lines, the key a '+'-joined sum of named
 * keys (ALT, CTRL, SHIFT, F1..F12, ...) and single characters, each
 * lower-cased. The first binding of a keystroke wins; a later one is a
 * warning.
 *
 * @mw2 input_load_gamekeys 0x000484e0
 * @fidelity exact
 */
export function inputLoadGamekeys(): number {
  const t = input;
  t.mapLine = 0;
  const f = dosFopen('gamekey.map');
  if (!f) {
    systemError(0x11, "Can't open gamekey mapping file");
    return 0;
  }
  const keys = keyNames();
  const commands = commandNames();
  for (;;) {
    const line = inputSub047a00(f, 0xff);
    if (line === null) break;
    const a = scanToken(line, 0);
    const b = a && scanToken(line, a[1]);
    if (!a || !b) {
      systemError(0x11, `gamekey mapping error: line ${t.mapLine}, reading line`);
      return 0;
    }
    const tokens = b[0].split('+').filter((s) => s.length > 0);
    if (tokens.length === 0) {
      systemError(0x11, `gamekey mapping error: line ${t.mapLine}, bad key`);
      return 0;
    }
    let sum = 0;
    let esi = 0;
    for (const tk of tokens) {
      let v = 0;
      for (esi = 0; esi < 0x16; esi++) {
        if (stricmp(keys[esi]![0], tk) === 0) {
          v = keys[esi]![1];
          break;
        }
      }
      if (v === 0) {
        const c = tk.charCodeAt(0);
        v = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
      }
      sum += v;
    }
    const key = (sum << 16) >> 16;
    if (t.keyCommands[key & 0x7ff] === 0) {
      for (esi = 0; esi < 0x99; esi++) {
        if (stricmp(commands[esi]![0], a[0]) === 0) {
          t.keyCommands[key & 0x7ff] = commands[esi]![1];
          break;
        }
      }
    } else {
      systemError(1, `gamekey mapping warning: line ${t.mapLine}, key already mapped: ${line}`);
    }
    if (0x98 < esi) {
      systemError(0x11, `gamekey mapping error: line ${t.mapLine}, no such command "${a[0]}"`);
      return 0;
    }
  }
  return 1;
}

/**
 * Brings up the input system: the two maps, then each device's driver is
 * installed with its calibration file (<device>.CAL, if any).
 *
 * @mw2 input_init 0x00048870
 * @fidelity partial
 * @divergence a driver asking for calibration (install returns 4) would open the calibration screen (project_tables_sub_018f90), which is not ported
 */
export function inputInit(): number {
  inputLoadMap();
  inputLoadGamekeys();
  const status: number[] = [];
  for (let i = 0; i < input.devices.length; i++) {
    const d = input.devices[i]!;
    status[i] = d.driver.install(dosFileLoad(`${d.name}.cal`));
  }
  for (let i = 0; i < input.devices.length; i++) {
    if (status[i] === 4) unestablished(`input device ${input.devices[i]!.name} asks for calibration; the calibration screen is not ported`, 'input_init');
  }
  return 0;
}

/**
 * All chord entries hold: each '+' button down, each '-' button up. An
 * empty chord holds.
 *
 * @mw2 input_sub_048030 0x00048030
 * @fidelity exact
 */
export function inputSub048030(chord: readonly ChordEntry[]): number {
  for (const e of chord) {
    const w = input.devices[e.device]?.bits[e.word] ?? 0;
    if (e.negate === 1) {
      if ((w & e.mask) !== 0) return 0;
    } else if ((w & e.mask) === 0) return 0;
  }
  return 1;
}

/**
 * Steps one analog control's sink for the frame: its _reset or _set
 * channel, or else its _plus / _minus keys accelerating the value by
 * 3 * tickDelta << accelShift per frame (the velocity capped at 0x8000, the
 * value at +/-0x10000). A sink shared by several controls is stepped once.
 * Returns whether anything moved it.
 *
 * QUIRK: for a '_delta' channel the velocity IS the value (+4 points at
 * +0x1a), so a held key adds the step and then doubles the value.
 *
 * @mw2 input_step_analog 0x000486e0
 * @fidelity exact
 */
export function inputStepAnalog(c: AnalogControl): number {
  const s = c.sink!;
  let moved = s.moved;
  if (s.reset && slotGet(s.reset) !== 0) {
    if (c.hasValue) input.devices[c.device]?.driver.recenter(c.channel);
    s.setVel(0);
    s.value = s.rest;
    moved = 1;
  } else if (s.set && slotGet(s.set) !== 0) {
    s.value = setValue(s);
    s.setVel(0);
    moved = 1;
  }
  if (s.moved === 0) {
    const step = ((clock.tickDelta * 3) << (s.accelShift & 0x1f)) | 0;
    if (s.plus && slotGet(s.plus) !== 0) {
      if (s.getVel() < 0) s.setVel(0);
      s.setVel(s.getVel() + step);
      if (0x8000 < s.getVel()) s.setVel(0x8000);
      s.value = (s.value + s.getVel()) | 0;
      if (0x10000 < s.value) s.value = 0x10000;
      moved = 1;
    }
    if (s.minus && slotGet(s.minus) !== 0) {
      if (0 < s.getVel()) s.setVel(0);
      s.setVel(s.getVel() - step);
      if (s.getVel() < -0x8000) s.setVel(-0x8000);
      s.value = (s.value + s.getVel()) | 0;
      if (s.value < -0x10000) s.value = -0x10000;
      moved = 1;
    }
    if (moved === 0) s.setVel(0);
  }
  s.moved = moved;
  return moved;
}

/** The _set channel's value: the slot's current value mapped back to -1..+1, (v << shift - offset) * 2 / scale - 65536, truncated. */
function setValue(s: AnalogSink): number {
  const v = (slotGet(s.slot!) << (s.shift & 0x1f)) | 0;
  return Math.trunc(((v - s.offset) * 2.0) / s.scale + -65536.0) | 0;
}

/**
 * The per-frame control poll.
 *
 * @mw2 input_poll_controls 0x00048970
 * @fidelity exact
 */
export function inputPollControls(): void {
  const t = input;
  for (const c of t.analogControls) {
    const s = c.sink!;
    if (s.reset && slotGet(s.reset) !== 0) {
      if (c.hasValue) t.devices[c.device]?.driver.recenter(c.channel);
      s.value = s.rest;
      s.setVel(0);
      c.last = 0;
    } else if (s.set && slotGet(s.set) !== 0) {
      s.value = setValue(s);
      s.setVel(0);
    }
    s.moved = 0;
  }
  for (const ch of channelsOrEmpty()) {
    if (ch.kind !== 0) {
      const sl = slotOf(ch);
      if (sl) slotSet(sl, 0);
    }
  }
  for (const d of t.devices) d.driver.poll(d.analog, d.bits);
  for (const d of t.discrete) {
    if (t.gameControlsLive === 0 && d.isMenu === 0) continue;
    const r = inputSub048030(d.chord);
    if (d.edge === 0 || d.prev === 0) slotSet(d.slot!, slotGet(d.slot!) | r);
    d.prev = r;
  }
  for (const c of t.analogControls) {
    if (t.gameControlsLive === 0 && c.isMenu === 0) continue;
    const s = c.sink!;
    if (inputStepAnalog(c) === 0 && c.hasValue && inputSub048030(c.chord) !== 0) {
      const v = Math.imul(t.devices[c.device]!.analog[c.channel & 15]!, c.sign);
      if (v !== c.last || s.velIsValue) s.value = v;
      c.last = v;
    }
    let v = s.value;
    if (0x10000 < v) v = 0x10000;
    if (v < -0x10000) v = -0x10000;
    const p = Math.imul(v + 0x10000, s.scale);
    slotSet(s.slot!, (((p - (p >> 31)) >> 1) + s.offset) >> (s.shift & 0x1f));
  }
  const kb = t.devices[t.keyboardDevice];
  inputGlobals.controlKey = kb ? kb.driver.readKey() & 0xffff : 0;
  if (!kb) divergence('no keyboard device is open, so no keystroke is read', 'input_poll_controls');
}

function channelsOrEmpty(): ControlChannel[] {
  if (input.channels.length === 0) channel('');
  return input.channels;
}

/**
 * The command a keystroke is bound to (GAMEKEY.MAP), or 0.
 *
 * @mw2 input_sub_048ca0 0x00048ca0
 * @fidelity exact
 */
export function inputSub048ca0(key: number): number {
  return input.keyCommands[((key << 16) >> 16) & 0x7ff]!;
}

/**
 * @mw2 input_sub_048c50 0x00048c50
 * @fidelity exact
 */
export function inputSub048c50(): void {
  input.gameControlsLive = 0;
}

/**
 * @mw2 input_sub_048c60 0x00048c60
 * @fidelity exact
 */
export function inputSub048c60(): void {
  input.gameControlsLive = 1;
}
