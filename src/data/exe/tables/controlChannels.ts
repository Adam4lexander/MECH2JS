/**
 * The control channel table: the names INPUT.MAP binds ("throttle",
 * "jumpjet_fire_left") and the ControlState slot each drives - 0x57 records
 * of 32 bytes at 0x9d1c4. The count is the bound of both its readers:
 * input_torso_tilt (0x47650, the by-name lookup - named for its first
 * string, it is not torso code) and input_poll_controls' clearing loop
 * (0x48970). ControlState's field names come from this table (the
 * decompilation's build/control_fields.csv is extracted from it).
 *
 *   +0x00 char *name
 *   +0x04 slot      address of the byte or int in playerControls (0x98344)
 *   +0x08 kind      0 analog (an int slot), 1 button, 2 latched action.
 *                   input_poll_controls zeroes every slot whose kind is non-zero
 *                   each frame; input_add_discrete refuses to bind kind 0.
 *   +0x10 min, +0x14 max, +0x1c shift (a byte) - input_add_analog_sink's
 *                   scale = max - min, offset = min << 16, and the right shift
 *                   input_poll_controls applies: 0 stores 16.16, 16 an integer.
 *   +0x0c, +0x18    read by input_add_analog_sink (+0x0c is normalised against
 *                   min..max into the sink's value; +0x18 is copied into the
 *                   sink at +0x1e); what they mean is NOT established. The
 *                   extraction tool calls +0x0c 'unused' and +0x18 'group'.
 */
import type { ExeImage } from '../ExeImage.ts';

export const CONTROL_CHANNELS = 0x9d1c4;
export const CONTROL_CHANNEL_COUNT = 0x57;
export const CONTROL_CHANNEL_STRIDE = 0x20;
/** playerControls, the player's ControlState (mw2_types.h extern) */
export const PLAYER_CONTROLS = 0x98344;

/** ControlChannel.kind */
export const CONTROL_ANALOG = 0;
export const CONTROL_BUTTON = 1;
export const CONTROL_ACTION = 2;

export interface ControlChannel {
  /** the record's address */
  address: number;
  name: string;
  /** absolute address of the slot */
  slot: number;
  /** CONTROL_ANALOG, CONTROL_BUTTON or CONTROL_ACTION */
  kind: number;
  field_0xc: number;
  min: number;
  max: number;
  field_0x18: number;
  shift: number;
}

/**
 * @mw2data controlChannels 0x0009d1c4
 * @fidelity exact
 */
export function readControlChannels(exe: ExeImage): ControlChannel[] {
  const out: ControlChannel[] = [];
  for (let i = 0; i < CONTROL_CHANNEL_COUNT; i++) {
    const a = CONTROL_CHANNELS + i * CONTROL_CHANNEL_STRIDE;
    out.push({
      address: a,
      name: exe.strPtr(a) ?? '',
      slot: exe.u32(a + 4),
      kind: exe.i32(a + 8),
      field_0xc: exe.i32(a + 0xc),
      min: exe.i32(a + 0x10),
      max: exe.i32(a + 0x14),
      field_0x18: exe.i32(a + 0x18),
      shift: exe.u8(a + 0x1c),
    });
  }
  return out;
}

/** The slot's offset in ControlState. @portOnly */
export function channelOffset(c: ControlChannel): number {
  return c.slot - PLAYER_CONTROLS;
}

/** Watcom stricmp: case folded through tolower ('A'..'Z' only). */
function stricmp(a: string, b: string): number {
  for (let i = 0; ; i++) {
    let x = i < a.length ? a.charCodeAt(i) : 0;
    let y = i < b.length ? b.charCodeAt(i) : 0;
    if (x >= 0x41 && x <= 0x5a) x += 0x20;
    if (y >= 0x41 && y <= 0x5a) y += 0x20;
    if (x !== y || x === 0) return x - y;
  }
}

/**
 * The channel with this name (case-insensitive), or null - how INPUT.MAP's
 * parsers (input_add_analog_sink, input_add_discrete) resolve a name.
 *
 * @mw2 input_torso_tilt 0x00047650
 * @fidelity exact
 * @divergence returns the record instead of its address
 */
export function inputTorsoTilt(channels: readonly ControlChannel[], name: string): ControlChannel | null {
  for (let i = 0; i < CONTROL_CHANNEL_COUNT && i < channels.length; i++) {
    if (stricmp(channels[i]!.name, name) === 0) return channels[i]!;
  }
  return null;
}
