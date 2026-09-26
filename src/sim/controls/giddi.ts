/**
 * GIDDI input device drivers: the LX modules in GIDDI\ that input_open_device
 * loads (lx_module_load(file, 5, 0)) and then calls only through the eight
 * method pointers at the start of the loaded block. They are not MW2.EXE
 * code, so they carry no @mw2 tags; each method below is a port of the
 * driver's own code, read from the module (addresses are offsets in the
 * block as lx_module_load lays it out, which for the first object are the
 * module's own).
 *
 *   +0x00 install(cal)      hook the hardware; returns a status (4 asks for calibration)
 *   +0x04 remove()
 *   +0x08 init(record)      fill the 0x34-byte device record: counts and name lists
 *   +0x0c calibrate(...)    (keyboard and mouse: return 0)
 *   +0x10 recenter(ch)      (mouse: move the pointer to the centre of an axis)
 *   +0x14 poll(analog, bits) analog: 16 ints (16.16, -1.0..+1.0), bits: 128 buttons
 *   +0x18 readKey()         the next queued keystroke word, 0 if none (keyboard)
 *   +0x1c flush()           empty the keystroke queue (keyboard)
 *
 * The device record (0x152bf8 + device * 0x34), as input_bind_channel and its
 * twin read it: +0 the number of analog channels, +4 of buttons, +0x20 the
 * analog channels' names, +0x2c the buttons' names (+0x28 the buttons' long
 * descriptions; the other words are the drivers' and not read by MW2.EXE's
 * input binding).
 *
 * The drivers' tables - scancode translation, key codes, channel names - are
 * read from the DLL at load, so what the port binds against is the shipped
 * driver's data. The hardware below the drivers (the keyboard controller's
 * scancodes, the mouse driver's position) is the host's: see
 * app/hostInput.ts.
 */
import type { LxModule } from '../../data/exe/tables/menus.ts';

export interface GiddiRecord {
  /** +0x00 */
  analogCount: number;
  /** +0x04 */
  buttonCount: number;
  /** +0x20: names input_bind_channel matches against */
  analogNames: (string | null)[] | null;
  /** +0x28 */
  buttonDescriptions: (string | null)[] | null;
  /** +0x2c: names input_bind_channel_2 matches against */
  buttonNames: (string | null)[] | null;
}

export function emptyRecord(): GiddiRecord {
  return { analogCount: 0, buttonCount: 0, analogNames: null, buttonDescriptions: null, buttonNames: null };
}

export interface GiddiDriver {
  readonly kind: 'keyboard' | 'mouse';
  install(cal: Uint8Array | null): number;
  remove(): void;
  init(record: GiddiRecord): number;
  calibrate(): number;
  recenter(channel: number): number;
  poll(analog: Int32Array | null, bits: Uint32Array | null): number;
  readKey(): number;
  flush(): void;
}

class ModuleReader {
  private readonly dv: DataView;
  constructor(readonly m: LxModule) {
    this.dv = new DataView(m.block.buffer, m.block.byteOffset, m.block.byteLength);
  }
  u8(a: number): number {
    return this.m.block[a]!;
  }
  u32(a: number): number {
    return this.dv.getUint32(a, true);
  }
  str(a: number): string {
    let s = '';
    for (let i = a; i < this.m.block.length && this.m.block[i] !== 0; i++) s += String.fromCharCode(this.m.block[i]!);
    return s;
  }
  /** `count` pointers from the table whose address is the relocated dword at `immAt` (an instruction operand) */
  names(immAt: number, count: number): (string | null)[] {
    const table = this.m.fixups.get(immAt);
    if (table === undefined) throw new Error(`GIDDI driver: no relocation at 0x${immAt.toString(16)}`);
    return Array.from({ length: count }, (_, i) => {
      const p = this.m.fixups.get(table + i * 4);
      return p === undefined ? null : this.str(p);
    });
  }
}

/**
 * KEYBOARD.DLL. Its interrupt 9 handler (0xd47) keeps a 128-bit key-down
 * map (0xc8d) indexed by scancode - 1, with E0-prefixed keys translated
 * through the table at 0xaf6 into indices 0x54 and up, and queues a
 * keystroke word - shift state (0xa34) << 8 | key code (table 0xa43) - in a
 * 128-word ring (0xb77..0xc77) that readKey drains. poll copies the map and
 * adds three synthetic buttons: Shift (0x76), Control (0x77) and Alt (0x78).
 */
export class KeyboardDriver implements GiddiDriver {
  readonly kind = 'keyboard';
  private readonly r: ModuleReader;
  /** 0xc8d: the key-down map */
  readonly down = new Uint32Array(4);
  /** 0xc9d: 1 after an E0 prefix, 2 after E1 */
  prefix = 0;
  /** 0xa34: shift state, from the modifier table (0xa35 scancodes, 0xa3c bits): 1 Ctrl, 2 Shift, 4 Alt */
  mods = 0;
  /** 0xc89: the last scancode (or keystroke read) */
  last = 0;
  /** 0xb77..0xc79: the keystroke ring, addressed as the driver addresses it */
  private readonly ring = new Uint8Array(0xc80 - 0xb77);
  /** 0xc7b: read pointer */
  head = 0xb77;
  /** 0xc7f: write pointer */
  tail = 0xb77;

  constructor(m: LxModule) {
    this.r = new ModuleReader(m);
  }

  private static readonly RING = 0xb77;
  /** 0xc77: the ring's end */
  private static readonly END = 0xc77;

  private putWord(a: number, v: number): void {
    this.ring[a - KeyboardDriver.RING] = v & 0xff;
    this.ring[a - KeyboardDriver.RING + 1] = (v >> 8) & 0xff;
  }
  private getWord(a: number): number {
    return this.ring[a - KeyboardDriver.RING]! | (this.ring[a - KeyboardDriver.RING + 1]! << 8);
  }
  /** 0xa43 */
  private keyCode(scan: number): number {
    return this.r.u8(0xa43 + (scan & 0xff));
  }
  /** 0xaf6: E0 scancode -> index + 1 */
  private e0(scan: number): number {
    return this.r.u8(0xaf6 + (scan & 0xff));
  }
  /** index into the modifier list (0xa35, 0xff-terminated), or -1 */
  private modIndex(scan: number): number {
    for (let i = 0; ; i++) {
      const s = this.r.u8(0xa35 + i);
      if (s === (scan & 0xff)) return i;
      if (s === 0xff) return -1;
    }
  }
  private setBit(idx: number, on: boolean): void {
    idx &= 0xff;
    const w = idx >> 5;
    if (w > 3) return; // outside the map: the driver writes past it (indices 0x7e/0x7f from 0xaf6's fillers land on 0xc99+)
    const b = (1 << (idx & 31)) >>> 0;
    if (on) this.down[w] = (this.down[w]! | b) >>> 0;
    else this.down[w] = (this.down[w]! & ~b) >>> 0;
  }

  /** The interrupt 9 handler (0xd47): one byte from the keyboard controller. */
  isr(scan: number): void {
    let al = scan & 0xff;
    if (this.prefix & 3) {
      if ((al & 0x7f) === 0x2a) {
        this.prefix = 0;
        return;
      }
      if (this.prefix & 2 && al === 0x9d) this.down[2] = (this.down[2]! & ~0x10) >>> 0;
    }
    if ((al & 0x80) === 0) {
      // make (0xdcd)
      this.last = al;
      al &= 0x7f;
      if (al !== 0) {
        if (this.prefix & 1) {
          this.prefix = 0;
          al = this.e0(al);
        }
        this.setBit((al - 1) & 0xff, true);
      }
      let code = this.keyCode(this.last & 0xff);
      if (code === 0) {
        const i = this.modIndex(this.last);
        if (i >= 0) {
          this.mods |= this.r.u8(0xa3c + i);
          return;
        }
        code = this.last & 0xff;
      }
      this.enqueue(((this.mods & 0xff) << 8) | code);
      return;
    }
    // break (0xefc)
    this.last = al;
    if ((al & 0xf0) === 0xe0) {
      this.prefix = 1 << (al & 1);
      return;
    }
    if (al !== 0) {
      al &= 0x7f;
      if (this.prefix & 1) {
        this.prefix = 0;
        al = this.e0(al);
      }
      this.setBit((al - 1) & 0xff, false);
    }
    if (this.keyCode(this.last & 0x7f) !== 0) return;
    const i = this.modIndex(this.last & 0x7f);
    if (i >= 0) this.mods &= ~this.r.u8(0xa3c + i) & 0xff;
  }

  /** 0xe6f: queue a keystroke; a full ring drops it */
  private enqueue(word: number): void {
    const K = KeyboardDriver;
    if (this.tail < K.END) {
      const t = this.tail + 2;
      if (t === this.head) return;
      this.putWord(t - 2, word);
      this.tail = t;
    } else {
      if (this.head === K.RING) return;
      // QUIRK (0xeb7): the word goes into the ring's first slot but the write
      // pointer is left there too, so the next keystroke overwrites it
      this.putWord(K.RING, word);
      this.tail = K.RING;
    }
  }

  /** +0x00 (0x890 -> 0xfe6): clears the key map and hooks interrupt 9 */
  install(): number {
    this.down.fill(0);
    return 0;
  }
  /** +0x04 (0x8b0 -> 0x104e): unhooks it */
  remove(): void {}
  /** +0x08 (0x8d0) */
  init(rec: GiddiRecord): number {
    rec.analogCount = 0;
    rec.buttonCount = 0x79;
    rec.buttonDescriptions = this.r.names(0x914, 0x79);
    rec.buttonNames = this.r.names(0x91b, 0x79);
    return 0;
  }
  /** +0x0c (0x930) */
  calibrate(): number {
    return 0;
  }
  /** +0x10 (0x940) */
  recenter(): number {
    return 0;
  }
  /** +0x14 (0x950 -> 0xd1e) */
  poll(_analog: Int32Array | null, bits: Uint32Array | null): number {
    if (!bits) return 0;
    bits.set(this.down);
    const byte = (i: number) => (bits[i >> 2]! >>> ((i & 3) * 8)) & 0xff;
    const shift = byte(5) & 2 || byte(6) & 0x20 ? 1 : 0;
    const ctrl = byte(3) & 0x10 || byte(0xd) & 0x80 ? 1 : 0;
    const alt = byte(6) & 0x80 || byte(0xe) & 1 ? 1 : 0;
    bits[3] = (bits[3]! | (shift << 22) | (ctrl << 23) | (alt << 24)) >>> 0;
    return 0;
  }
  /** +0x18 (0xa00 -> 0xcb5) */
  readKey(): number {
    const K = KeyboardDriver;
    if (this.head === this.tail) return 0;
    this.last = this.getWord(this.head);
    const h = this.head + 2;
    if (h === this.tail) {
      this.head = K.RING;
      this.tail = K.RING;
    } else if (h === K.END) this.head = K.RING;
    else this.head = h;
    return this.last;
  }
  /** +0x1c (0xa20 -> 0xca1) */
  flush(): void {
    this.head = KeyboardDriver.RING;
    this.tail = KeyboardDriver.RING;
  }
}

/**
 * MOUSE.DLL. The mouse driver's event handler leaves the buttons (0x4f0) and
 * the position (0x4f2, 0x4f4, each shifted right by 3) for poll, which turns
 * the position into two absolute axes: Up/Down = ((2y - H) << 16) / H and
 * Left/Right = ((2x - W) << 16) / W, W = H = 0x400 (0x64, 0x68) - the mouse
 * is read like a centring joystick, not as motion.
 */
export class MouseDriver implements GiddiDriver {
  readonly kind = 'mouse';
  private readonly r: ModuleReader;
  /** 0x4f0 */
  buttons = 0;
  /** 0x4f2, 0x4f4: the mouse driver's position (virtual coordinates, 8 per unit poll sees) */
  rawX = 0;
  rawY = 0;
  /** 0x64, 0x68 */
  readonly width: number;
  readonly height: number;

  constructor(m: LxModule) {
    this.r = new ModuleReader(m);
    this.width = this.r.u32(0x64);
    this.height = this.r.u32(0x68);
  }

  /** 0x7b0: position and buttons as poll reads them */
  private read(): { x: number; y: number; left: number; right: number; middle: number } {
    return {
      x: (this.rawX & 0xffff) >> 3,
      y: (this.rawY & 0xffff) >> 3,
      left: this.buttons & 1 ? 1 : 0,
      right: this.buttons & 2 ? 1 : 0,
      middle: this.buttons & 4 ? 1 : 0,
    };
  }
  /** 0x870: int 33h function 4, set position */
  private setPosition(x: number, y: number): void {
    this.rawX = (x * 8) & 0xffff;
    this.rawY = (y * 8) & 0xffff;
  }

  /**
   * +0x00 (0x110): sets the driver's range and handler (0xaa0). Where the
   * pointer starts is the mouse driver's business (a reset centres it); the
   * port starts it centred.
   */
  install(): number {
    this.setPosition(this.width >> 1, this.height >> 1);
    return 0;
  }
  remove(): void {}
  /** +0x08 (0x2e0) */
  init(rec: GiddiRecord): number {
    rec.analogCount = 2;
    rec.buttonCount = 3;
    rec.analogNames = this.r.names(0x324, 2);
    rec.buttonDescriptions = this.r.names(0x32b, 3);
    rec.buttonNames = this.r.names(0x332, 3);
    return 0;
  }
  /** +0x0c (0x250) */
  calibrate(): number {
    return 0;
  }
  /** +0x10 (0x260): channel 0 recentres y, channel 1 x */
  recenter(channel: number): number {
    const p = this.read();
    let x = p.x;
    let y = p.y;
    if (channel === 0) y = (this.height / 2) | 0;
    else if (channel === 1) x = (this.width / 2) | 0;
    this.setPosition(x, y);
    return 0;
  }
  /** +0x14 (0x350) */
  poll(analog: Int32Array | null, bits: Uint32Array | null): number {
    const p = this.read();
    if (bits) bits[0] = ((p.right << 2) | (p.middle << 1) | p.left) >>> 0;
    if (analog) {
      analog[0] = (((p.y * 2 - this.height) << 16) / this.height) | 0;
      analog[1] = (((p.x * 2 - this.width) << 16) / this.width) | 0;
    }
    return 0;
  }
  /** +0x18 (0x3e0) */
  readKey(): number {
    return 0;
  }
  /** +0x1c (0x3f0) */
  flush(): void {}

  /** @portOnly the host moves the pointer (int 33h's own state), clamped to the driver's range */
  hostMove(dx: number, dy: number): void {
    const maxX = this.width * 8 - 1;
    const maxY = this.height * 8 - 1;
    this.rawX = Math.max(0, Math.min(maxX, this.rawX + dx));
    this.rawY = Math.max(0, Math.min(maxY, this.rawY + dy));
  }
}

/**
 * @portOnly the port's implementation of the driver input_open_device loaded
 * for this device name ('keyboard' from GIDDI\KEYBOARD.DLL, ...); null for a
 * device the port has no driver for (the joysticks, VIO)
 */
export function giddiDriverFor(device: string, m: LxModule): GiddiDriver | null {
  switch (device.toLowerCase()) {
    case 'keyboard':
      return new KeyboardDriver(m);
    case 'mouse':
      return new MouseDriver(m);
    default:
      return null;
  }
}
