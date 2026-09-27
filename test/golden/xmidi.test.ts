// The front end's XMIDI music as the port parses it, printed in
// decompiled/tools/dump_xmidi.py's exact format and compared line by line
// with listing/xmidi.txt. The per-sequence CRC covers every event (tick,
// kind, channel, data, duration), so a parse that keeps the counts but
// misplaces one event still fails.
import { describe, expect, it } from 'vitest';
import { mpackDbGetItemUnpacked, mpackDbOpen } from '../../src/data/formats/mpack.ts';
import { xmidiParse, type XmidiEvent, type XmidiSequence } from '../../src/data/formats/xmidi.ts';
import { SEQ_DONE, SEQ_PLAYING, XmidiSequencer, type MidiOut } from '../../src/engine/miles/xmidiSequencer.ts';
import { crc32, hex8 } from '../support/crc32.ts';
import { expectSameLines, lines } from '../support/listing.ts';
import { gameSource, hasShellData, hasShellDecompiled, readShellListing } from '../support/env.ts';

const FIRST_SONG = 34;
const LAST_SONG = 73;
const KINDS = ['note', 'noteoff', 'polypress', 'control', 'program', 'chanpress', 'pitch', 'sysex', 'meta'] as const;
const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hexBytes = (b: Uint8Array) => Array.from(b, hex2).join(' ');

/** dump_xmidi.py's canonical event line. */
function canon(e: XmidiEvent): string {
  switch (e.kind) {
    case 'note':
      return `${e.tick} n ${e.ch} ${e.key} ${e.vel} ${e.dur}`;
    case 'noteOff':
      return `${e.tick} ${hex2(0x80 | e.ch)} ${hex2(e.key)} ${hex2(e.vel)}`;
    case 'polyPressure':
      return `${e.tick} ${hex2(0xa0 | e.ch)} ${hex2(e.key)} ${hex2(e.value)}`;
    case 'control':
      return `${e.tick} ${hex2(0xb0 | e.ch)} ${hex2(e.cc)} ${hex2(e.value)}`;
    case 'program':
      return `${e.tick} ${hex2(0xc0 | e.ch)} ${hex2(e.program)}`;
    case 'channelPressure':
      return `${e.tick} ${hex2(0xd0 | e.ch)} ${hex2(e.value)}`;
    case 'pitchBend':
      return `${e.tick} ${hex2(0xe0 | e.ch)} ${hex2(e.value & 0x7f)} ${hex2(e.value >> 7)}`;
    case 'sysex':
      return `${e.tick} ${hex2(e.status)} ${e.data.length} ${hexBytes(e.data)}`;
    case 'meta':
      return `${e.tick} ff ${hex2(e.type)} ${e.data.length} ${hexBytes(e.data)}`;
  }
}

function kindOf(e: XmidiEvent): (typeof KINDS)[number] {
  const m = { note: 'note', noteOff: 'noteoff', polyPressure: 'polypress', control: 'control', program: 'program', channelPressure: 'chanpress', pitchBend: 'pitch', sysex: 'sysex', meta: 'meta' } as const;
  return m[e.kind];
}

function describeSeq(s: XmidiSequence): string[] {
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<(typeof KINDS)[number], number>;
  const ccs = new Map<number, number>();
  const metas = new Map<number, number>();
  const pts: [number, number][] = [];
  let lastEnd = 0;
  for (const e of s.events) {
    counts[kindOf(e)]++;
    if (e.kind === 'note') {
      lastEnd = Math.max(lastEnd, e.tick + e.dur);
      pts.push([e.tick, 1], [e.tick + e.dur, 0]);
    } else if (e.kind === 'control') ccs.set(e.cc, (ccs.get(e.cc) ?? 0) + 1);
    else if (e.kind === 'meta') metas.set(e.type, (metas.get(e.type) ?? 0) + 1);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let most = 0;
  let cur = 0;
  for (const [, d] of pts) {
    cur += d ? 1 : -1;
    most = Math.max(most, cur);
  }
  const sorted = (m: Map<number, number>) => [...m.keys()].sort((a, b) => a - b);
  const crc = crc32(new TextEncoder().encode(s.events.map(canon).join('\n')));
  return [
    `  timbres ${s.timbres.length}: ${s.timbres.map((t) => `${t.patch}/${t.bank}`).join(' ')}`,
    `  branches ${s.branches.length}  evnt ${s.evnt.length} bytes  events ${s.events.length}  trailing ${s.trailing}`,
    '  ' + KINDS.map((k) => `${k} ${counts[k]}`).join('  '),
    '  controllers: ' + sorted(ccs).map((k) => `${k}:${ccs.get(k)}`).join(' '),
    '  meta: ' + sorted(metas).map((k) => `${hex2(k)}:${metas.get(k)}`).join(' '),
    `  ticks ${s.ticks}  last note end ${lastEnd}  most pending ${most}  crc ${hex8(crc)}`,
  ];
}

describe.runIf(hasShellData && hasShellDecompiled)('XMIDI music (DATABASE.MW2 items 34..73)', () => {
  it('matches listing/xmidi.txt', async () => {
    const db = mpackDbOpen('DATABASE.MW2', await gameSource().read('DATABASE.MW2'));
    const got = [
      `# DATABASE.MW2 XMIDI items ${FIRST_SONG}..${LAST_SONG} (tools/dump_xmidi.py)`,
      '# timbres are patch/bank; ticks are 1/120 s; crc is over the canonical event list (see the tool)',
    ];
    for (let id = FIRST_SONG; id <= LAST_SONG; id++) {
      const x = xmidiParse(mpackDbGetItemUnpacked(db, id)!);
      expect(x, `item ${id}`).not.toBeNull();
      got.push(`item ${id}: ${x!.sequences.length} sequence(s), XDIR INFO ${x!.infoCount ?? '-'}`);
      x!.sequences.forEach((s, n) => {
        got.push(` seq ${n}`);
        got.push(...describeSeq(s));
      });
    }
    const want = lines(readShellListing('xmidi.txt'));
    expect(want.length).toBeGreaterThan(40);
    expectSameLines('xmidi.txt', want, got);
  });

  // The General MIDI set (README "Screen music": base 34..41 + 32). Played
  // through the sequencer, every note must sound at the tick the parser
  // stamped it with, on its channel, key and velocity, and be released.
  it('the General MIDI set plays every note at its tick through the sequencer', async () => {
    const db = mpackDbOpen('DATABASE.MW2', await gameSource().read('DATABASE.MW2'));
    for (let id = 66; id <= 73; id++) {
      const seq = xmidiParse(mpackDbGetItemUnpacked(db, id)!)!.sequences[0]!;
      let t = 0;
      const on: string[] = [];
      let offs = 0;
      const out: MidiOut = {
        noteOn: (ch, key, vel) => on.push(`${t} ${ch} ${key} ${vel}`),
        noteOff: () => offs++,
        controlChange: () => {},
        programChange: () => {},
        pitchBend: () => {},
        allNotesOff: () => {},
      };
      const s = new XmidiSequencer(out);
      s.init(seq);
      s.start();
      s.setLoopCount(1);
      for (; t < seq.ticks; t++) s.serviceTicks(1);
      const want = seq.events.flatMap((e) => (e.kind === 'note' && e.tick < seq.ticks ? [`${e.tick} ${e.ch} ${e.key} ${e.vel}`] : []));
      expectSameLines(`item ${id} note-ons`, want, on);
      const loops = seq.events.some((e) => e.kind === 'control' && e.cc === 116);
      for (let i = 0; i < 2 * seq.ticks; i++, t++) s.serviceTicks(1);
      // songs with a FOR 0 loop never reach their end; the rest end after one play
      expect(s.status, `item ${id}`).toBe(loops ? SEQ_PLAYING : SEQ_DONE);
      s.stop();
      expect(offs, `item ${id} note-offs`).toBe(on.length);
    }
  });
});
