/**
 * XMIDI (Miles' Extended MIDI): the front end's music, DATABASE.MW2 items
 * 34..73 (five arrangements of eight songs; decompiled/mw2shell/README.md
 * "Screen music").
 *
 * Read the way Miles 3 (linked into MW2SHELL.EXE) reads it:
 *
 *   miles_drivers_sub_05d9f0 (0x5d9f0) finds sequence n: top-level chunks
 *       must be FORM or CAT and are stepped by their big-endian size + 8 (no
 *       IFF pad byte) until one whose type is 'XMID'. A FORM XMID is the only
 *       sequence; a CAT XMID holds FORM XMIDs from +12 and the n-th is taken.
 *       FORM XDIR (INFO: uint16 sequence count) comes first and is skipped.
 *   miles_parse_xmidi (0x5f890) walks the FORM XMID's chunks from +12 (size
 *       + 8 again) keeping TIMB, RBRN and EVNT; without EVNT the sequence is
 *       invalid. Playback starts at EVNT + 8.
 *   TIMB: uint16 count, count x {patch, bank}.
 *   RBRN: int16 count, count x {uint16 id, uint32 offset into the EVNT data}
 *       (miles_drivers_sub_060230, AIL_branch_index's worker).
 *   EVNT, as the serve loop (0x5e740) interprets it:
 *       a byte < 0x80 is an interval. Miles stores it and counts it down one
 *       service tick (1/120 s) at a time, testing after the decrement - so
 *       consecutive interval bytes add up, and a 0 byte still costs a tick
 *       (MW2's songs have none; the stamps below follow Miles).
 *       0x9n key velocity, then a variable-length duration (at most 4 bytes,
 *       0x5d980): XMIDI has no note-offs, Miles queues them.
 *       0x8n 0xAn 0xBn 0xEn carry two data bytes, 0xCn 0xDn one.
 *       0xF0 / 0xF7: variable-length size, then the bytes.
 *       0xFF: type, variable-length size, data; 0x2F ends the sequence.
 *       There is no running status.
 *
 * Pure data: the playback (loops, branches, note-off queue) is
 * engine/miles/xmidiSequencer.ts, which walks the same EVNT bytes with
 * xmidiReadAt so that jumps land on byte offsets exactly as Miles' do.
 *
 * @portOnly the reader of Miles' XMIDI format (library code, see above); the port reads it into a typed list
 */

export interface XmidiTimbre {
  patch: number;
  bank: number;
}

export interface XmidiBranch {
  /** the marker id (controller 120's value in the source MIDI) */
  id: number;
  /** a byte offset into the EVNT data */
  offset: number;
}

/** What an event is, without where it plays. */
export type XmidiEventBody =
  | { kind: 'note'; ch: number; key: number; vel: number; dur: number }
  | { kind: 'noteOff'; ch: number; key: number; vel: number }
  | { kind: 'polyPressure'; ch: number; key: number; value: number }
  | { kind: 'control'; ch: number; cc: number; value: number }
  | { kind: 'program'; ch: number; program: number }
  | { kind: 'channelPressure'; ch: number; value: number }
  /** value is 14-bit: lsb | msb << 7 (0x2000 centre) */
  | { kind: 'pitchBend'; ch: number; value: number }
  | { kind: 'sysex'; status: 0xf0 | 0xf7; data: Uint8Array }
  | { kind: 'meta'; type: number; data: Uint8Array };

export type XmidiEvent = XmidiEventBody & {
  /** the 120 Hz tick it plays at */
  tick: number;
  /** its status byte's offset in the EVNT data */
  offset: number;
};

export interface XmidiSequence {
  timbres: XmidiTimbre[];
  branches: XmidiBranch[];
  /** the EVNT chunk's data (what the sequencer plays) */
  evnt: Uint8Array;
  events: XmidiEvent[];
  /** the tick of the end-of-sequence event (or of the last event when there is none) */
  ticks: number;
  /** bytes after the end-of-sequence event (a pad byte in some of MW2's songs) */
  trailing: number;
}

export interface XmidiFile {
  /** FORM XDIR's INFO count, or null when there is no XDIR */
  infoCount: number | null;
  sequences: XmidiSequence[];
}

/** XMIDI's fixed sequencer rate: every tick stamp and duration is in these. */
export const XMIDI_TICK_HZ = 120;
export const META_END_OF_TRACK = 0x2f;
export const META_TEMPO = 0x51;
export const META_TIME_SIGNATURE = 0x58;

const tag = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const be32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);

/**
 * The FORM XMID offsets of every sequence, in the order
 * miles_drivers_sub_05d9f0 numbers them; [] when the data is not XMIDI.
 */
export function xmidiSequenceOffsets(b: Uint8Array): number[] {
  let p = 0;
  for (;;) {
    if (p + 12 > b.length) return [];
    const id = tag(b, p);
    if (id !== 'FORM' && id !== 'CAT ') return [];
    if (tag(b, p + 8) === 'XMID') break;
    p += be32(b, p + 4) + 8;
  }
  if (tag(b, p) === 'FORM') return [p];
  const size = be32(b, p + 4);
  const out: number[] = [];
  const end = Math.min(b.length, p + size + 8);
  for (let q = p + 12; q + 12 <= end; q += be32(b, q + 4) + 8) {
    if (tag(b, q + 8) === 'XMID') out.push(q);
  }
  return out;
}

function infoCount(b: Uint8Array): number | null {
  if (b.length < 12 || tag(b, 0) !== 'FORM' || tag(b, 8) !== 'XDIR') return null;
  const end = Math.min(b.length, 8 + be32(b, 4));
  for (let p = 12; p + 8 <= end; p += be32(b, p + 4) + 8) {
    if (tag(b, p) === 'INFO') return le16(b, p + 8);
  }
  return null;
}

/** A variable-length number: 7 bits a byte, high bit = more, at most 4 bytes (0x5d980). */
export function xmidiReadVlq(b: Uint8Array, at: number): { value: number; next: number } {
  let v = 0;
  let p = at;
  for (let n = 0; n < 4; n++) {
    const c = b[p++];
    if (c === undefined) throw new RangeError('XMIDI: a variable-length number runs off the end');
    v = (v << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return { value: v >>> 0, next: p };
}

/** What one step of the EVNT stream is: an interval byte or an event. */
export type XmidiStep =
  | { step: 'interval'; interval: number; next: number }
  | { step: 'event'; event: XmidiEventBody & { offset: number }; next: number };

/**
 * Decodes the step at `at` in EVNT data - the unit the serve loop reads.
 * Throws RangeError on data that runs off the end, and on a status Miles
 * cannot step over (0xF1..0xF6, 0xF8..0xFE: its serve loop would take them
 * as a 0-byte channel message and never advance).
 */
export function xmidiReadAt(e: Uint8Array, at: number): XmidiStep {
  const s = e[at];
  if (s === undefined) throw new RangeError('XMIDI: EVNT data ends without an end-of-sequence event');
  if (s < 0x80) return { step: 'interval', interval: s, next: at + 1 };
  const need = (n: number) => {
    if (at + n >= e.length) throw new RangeError('XMIDI: an event runs off the end of EVNT');
  };
  const ch = s & 15;
  switch (s & 0xf0) {
    case 0x90: {
      need(2);
      const d = xmidiReadVlq(e, at + 3);
      return { step: 'event', event: { offset: at, kind: 'note', ch, key: e[at + 1]!, vel: e[at + 2]!, dur: d.value }, next: d.next };
    }
    case 0x80:
      need(2);
      return { step: 'event', event: { offset: at, kind: 'noteOff', ch, key: e[at + 1]!, vel: e[at + 2]! }, next: at + 3 };
    case 0xa0:
      need(2);
      return { step: 'event', event: { offset: at, kind: 'polyPressure', ch, key: e[at + 1]!, value: e[at + 2]! }, next: at + 3 };
    case 0xb0:
      need(2);
      return { step: 'event', event: { offset: at, kind: 'control', ch, cc: e[at + 1]!, value: e[at + 2]! }, next: at + 3 };
    case 0xe0:
      need(2);
      return { step: 'event', event: { offset: at, kind: 'pitchBend', ch, value: e[at + 1]! | (e[at + 2]! << 7) }, next: at + 3 };
    case 0xc0:
      need(1);
      return { step: 'event', event: { offset: at, kind: 'program', ch, program: e[at + 1]! }, next: at + 2 };
    case 0xd0:
      need(1);
      return { step: 'event', event: { offset: at, kind: 'channelPressure', ch, value: e[at + 1]! }, next: at + 2 };
  }
  if (s === 0xf0 || s === 0xf7) {
    const n = xmidiReadVlq(e, at + 1);
    if (n.next + n.value > e.length) throw new RangeError('XMIDI: sysex runs off the end of EVNT');
    return { step: 'event', event: { offset: at, kind: 'sysex', status: s, data: e.slice(n.next, n.next + n.value) }, next: n.next + n.value };
  }
  if (s === 0xff) {
    need(1);
    const n = xmidiReadVlq(e, at + 2);
    if (n.next + n.value > e.length) throw new RangeError('XMIDI: meta event runs off the end of EVNT');
    return { step: 'event', event: { offset: at, kind: 'meta', type: e[at + 1]!, data: e.slice(n.next, n.next + n.value) }, next: n.next + n.value };
  }
  throw new RangeError(`XMIDI: status 0x${s.toString(16)} at ${at} (Miles would not advance past it)`);
}

/** Every event of one EVNT body, stamped with the tick Miles plays it at. */
export function xmidiDecodeEvents(evnt: Uint8Array): { events: XmidiEvent[]; ticks: number; trailing: number } {
  const events: XmidiEvent[] = [];
  let tick = 0;
  let p = 0;
  while (p < evnt.length) {
    const st = xmidiReadAt(evnt, p);
    p = st.next;
    if (st.step === 'interval') {
      tick += Math.max(1, st.interval);
      continue;
    }
    events.push({ ...st.event, tick });
    if (st.event.kind === 'meta' && st.event.type === META_END_OF_TRACK) break;
  }
  const last = events[events.length - 1];
  return { events, ticks: last ? last.tick : tick, trailing: evnt.length - p };
}

/** The FORM XMID at `at`: its TIMB, RBRN and EVNT (miles_parse_xmidi), or null without EVNT. */
export function xmidiParseSequence(b: Uint8Array, at: number): XmidiSequence | null {
  const end = Math.min(b.length, at + 8 + be32(b, at + 4));
  let timb = -1;
  let rbrn = -1;
  let evnt = -1;
  let evntSize = 0;
  for (let p = at + 12; p + 8 <= end; p += be32(b, p + 4) + 8) {
    const id = tag(b, p);
    if (id === 'TIMB') timb = p;
    else if (id === 'RBRN') rbrn = p;
    else if (id === 'EVNT') {
      evnt = p;
      evntSize = be32(b, p + 4);
    }
  }
  if (evnt < 0) return null;
  const timbres: XmidiTimbre[] = [];
  if (timb >= 0) {
    const n = le16(b, timb + 8);
    for (let i = 0; i < n; i++) timbres.push({ patch: b[timb + 10 + i * 2]!, bank: b[timb + 11 + i * 2]! });
  }
  const branches: XmidiBranch[] = [];
  if (rbrn >= 0) {
    const n = (le16(b, rbrn + 8) << 16) >> 16;
    for (let i = 0; i < n; i++) {
      const q = rbrn + 10 + i * 6;
      branches.push({ id: le16(b, q), offset: (b[q + 2]! | (b[q + 3]! << 8) | (b[q + 4]! << 16) | (b[q + 5]! << 24)) >>> 0 });
    }
  }
  const data = b.subarray(evnt + 8, Math.min(b.length, evnt + 8 + evntSize));
  const d = xmidiDecodeEvents(data);
  return { timbres, branches, evnt: data, events: d.events, ticks: d.ticks, trailing: d.trailing };
}

/**
 * Every sequence of an XMIDI image, or null when it is not XMIDI or a
 * sequence has no EVNT (Miles' "Invalid XMIDI sequence").
 */
export function xmidiParse(bytes: Uint8Array): XmidiFile | null {
  const offs = xmidiSequenceOffsets(bytes);
  if (offs.length === 0) return null;
  const sequences: XmidiSequence[] = [];
  for (const at of offs) {
    const s = xmidiParseSequence(bytes, at);
    if (!s) return null;
    sequences.push(s);
  }
  return { infoCount: infoCount(bytes), sequences };
}

/** A tempo meta event's microseconds per quarter note (informational: XMIDI's ticks are fixed). */
export function xmidiTempo(ev: XmidiEvent): number | null {
  if (ev.kind !== 'meta' || ev.type !== META_TEMPO || ev.data.length < 3) return null;
  return (ev.data[0]! << 16) | (ev.data[1]! << 8) | ev.data[2]!;
}
