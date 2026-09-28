// The XMIDI reader and the Miles-style sequencer on synthetic songs: what
// plays when, loops (FOR/NEXT and the sequence loop count), stop/resume and
// the volume ramp.
import { describe, expect, it } from 'vitest';
import { xmidiParse, type XmidiSequence } from '../../src/data/formats/xmidi.ts';
import { SEQ_DONE, SEQ_PLAYING, SEQ_STOPPED, ServiceClock, XmidiSequencer, type MidiOut } from '../../src/engine/miles/xmidiSequencer.ts';

// ---- building XMIDI ----

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const chunk = (id: string, body: number[]) => [...ascii(id), ...be32(body.length), ...body];
function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n >>>= 7; n > 0; n >>>= 7) out.unshift(0x80 | (n & 0x7f));
  return out;
}

const note = (ch: number, key: number, vel: number, dur: number) => [0x90 | ch, key, vel, ...vlq(dur)];
const cc = (ch: number, c: number, v: number) => [0xb0 | ch, c, v];
const prog = (ch: number, p: number) => [0xc0 | ch, p];
const bend = (ch: number, v: number) => [0xe0 | ch, v & 0x7f, v >> 7];
const EOT = [0xff, 0x2f, 0x00];
function wait(n: number): number[] {
  const out: number[] = [];
  for (; n > 0x7f; n -= 0x7f) out.push(0x7f);
  if (n > 0) out.push(n);
  return out;
}

/** FORM XDIR + CAT XMID of one FORM XMID {TIMB, [RBRN], EVNT}. */
function xmi(evnt: number[], branches: [number, number][] = []): Uint8Array {
  const timb = chunk('TIMB', [...le16(1), 0, 0]);
  const rbrn = branches.length ? chunk('RBRN', [...le16(branches.length), ...branches.flatMap(([id, off]) => [...le16(id), off & 255, (off >> 8) & 255, (off >> 16) & 255, off >>> 24])]) : [];
  const form = chunk('FORM', [...ascii('XMID'), ...timb, ...rbrn, ...chunk('EVNT', evnt)]);
  const cat = chunk('CAT ', [...ascii('XMID'), ...form]);
  const xdir = chunk('FORM', [...ascii('XDIR'), ...chunk('INFO', le16(1))]);
  return new Uint8Array([...xdir, ...cat]);
}

function seqOf(evnt: number[], branches: [number, number][] = []): XmidiSequence {
  const f = xmidiParse(xmi(evnt, branches));
  expect(f).not.toBeNull();
  return f!.sequences[0]!;
}

// ---- a recording device ----

class Recorder implements MidiOut {
  t = 0;
  log: string[] = [];
  noteOn(ch: number, key: number, vel: number) {
    this.log.push(`${this.t} on ${ch} ${key} ${vel}`);
  }
  noteOff(ch: number, key: number) {
    this.log.push(`${this.t} off ${ch} ${key}`);
  }
  controlChange(ch: number, c: number, v: number) {
    this.log.push(`${this.t} cc ${ch} ${c} ${v}`);
  }
  programChange(ch: number, p: number) {
    this.log.push(`${this.t} prog ${ch} ${p}`);
  }
  pitchBend(ch: number, v: number) {
    this.log.push(`${this.t} bend ${ch} ${v}`);
  }
  allNotesOff() {
    this.log.push(`${this.t} allNotesOff`);
  }
  of(kind: string): string[] {
    return this.log.filter((l) => l.split(' ')[1] === kind);
  }
}

/** Plays n services, stamping each message with the service it came in (0-based). */
function run(s: XmidiSequencer, r: Recorder, n: number): void {
  for (let i = 0; i < n; i++) {
    s.serviceTicks(1);
    r.t++;
  }
}

function player(seq: XmidiSequence): { s: XmidiSequencer; r: Recorder } {
  const r = new Recorder();
  const s = new XmidiSequencer(r);
  expect(s.init(seq)).toBe(true);
  s.start();
  return { s, r };
}

describe('xmidi reader', () => {
  it('reads the container, timbres, branches and stamps events at 120 Hz ticks', () => {
    const evnt = [...prog(0, 48), ...note(0, 60, 100, 10), ...wait(200), ...bend(1, 0x2345), ...cc(2, 7, 90), ...wait(5), ...EOT, 0];
    const f = xmidiParse(xmi(evnt, [[3, 7]]))!;
    expect(f.infoCount).toBe(1);
    expect(f.sequences).toHaveLength(1);
    const s = f.sequences[0]!;
    expect(s.timbres).toEqual([{ patch: 0, bank: 0 }]);
    expect(s.branches).toEqual([{ id: 3, offset: 7 }]);
    expect(s.trailing).toBe(1);
    expect(s.ticks).toBe(205);
    expect(s.events.map((e) => [e.tick, e.kind])).toEqual([
      [0, 'program'],
      [0, 'note'],
      [200, 'pitchBend'],
      [200, 'control'],
      [205, 'meta'],
    ]);
    const n = s.events[1]!;
    expect(n.kind === 'note' && [n.key, n.vel, n.dur]).toEqual([60, 100, 10]);
    const b = s.events[2]!;
    expect(b.kind === 'pitchBend' && b.value).toBe(0x2345);
    expect(s.events[1]!.offset).toBe(2);
  });

  it('a long duration is a variable-length number', () => {
    const s = seqOf([...note(9, 36, 127, 1000), ...EOT]);
    const n = s.events[0]!;
    expect(n.kind === 'note' && n.dur).toBe(1000);
  });

  it('rejects data that is not XMIDI', () => {
    expect(xmidiParse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });
});

describe('xmidi sequencer', () => {
  it('turns each note off after its duration, before the events of that tick', () => {
    const { s, r: r2 } = player(seqOf([...note(0, 60, 100, 10), ...wait(10), ...note(0, 60, 90, 3), ...note(1, 64, 80, 0), ...wait(20), ...EOT]));
    run(s, r2, 40);
    expect(r2.log.filter((l) => / (on|off) /.test(l))).toEqual([
      '0 on 0 60 100',
      '10 off 0 60', // the first note's off comes before the re-strike at the same tick
      '10 on 0 60 90',
      '10 on 1 64 80',
      '11 off 1 64', // a duration of 0 still lasts a tick
      '13 off 0 60',
    ]);
    expect(s.status).toBe(SEQ_DONE);
  });

  it('plays once by default, ends DONE and calls the end-of-sequence callback', () => {
    const { s, r } = player(seqOf([...note(0, 60, 100, 5), ...wait(20), ...EOT]));
    let eos = 0;
    s.onEos = () => eos++;
    run(s, r, 100);
    expect(r.of('on')).toEqual(['0 on 0 60 100']);
    expect(eos).toBe(1);
    expect(s.status).toBe(SEQ_DONE);
  });

  it('loop count: 0 plays for ever, n plays n times, restarting a tick after the end', () => {
    const song = seqOf([...note(0, 60, 100, 5), ...wait(20), ...EOT]);
    const a = player(song);
    a.s.setLoopCount(3);
    run(a.s, a.r, 200);
    expect(a.r.of('on')).toEqual(['0 on 0 60 100', '21 on 0 60 100', '42 on 0 60 100']);
    expect(a.s.status).toBe(SEQ_DONE);

    const b = player(song);
    b.s.setLoopCount(0);
    run(b.s, b.r, 21 * 10);
    expect(b.r.of('on')).toHaveLength(10);
    expect(b.s.status).toBe(SEQ_PLAYING);
  });

  it('start resets the loop count to 1 (the shell sets it again after starting)', () => {
    const r = new Recorder();
    const s = new XmidiSequencer(r);
    s.init(seqOf([...note(0, 60, 100, 5), ...wait(20), ...EOT]));
    s.setLoopCount(0);
    s.start();
    expect(s.loopCount).toBe(1);
    run(s, r, 100);
    expect(r.of('on')).toHaveLength(1);
  });

  it('FOR n / NEXT plays the body n times, resuming just after the FOR', () => {
    const evnt = [...note(0, 50, 100, 2), ...wait(4), ...cc(0, 116, 3), ...note(0, 60, 100, 2), ...wait(10), ...cc(0, 117, 127), ...note(0, 70, 100, 2), ...wait(4), ...EOT];
    const { s, r } = player(seqOf(evnt));
    run(s, r, 200);
    expect(r.of('on')).toEqual(['0 on 0 50 100', '4 on 0 60 100', '14 on 0 60 100', '24 on 0 60 100', '34 on 0 70 100']);
    // FOR and NEXT are the sequencer's; they never reach the device
    expect(r.of('cc')).toEqual([]);
    expect(s.status).toBe(SEQ_DONE);
  });

  it('FOR 0 loops for ever; a NEXT below 64 (break) and a NEXT with no FOR are ignored', () => {
    const forever = [...cc(0, 116, 0), ...note(0, 60, 100, 2), ...wait(10), ...cc(0, 117, 64), ...EOT];
    const a = player(seqOf(forever));
    run(a.s, a.r, 1000);
    expect(a.r.of('on')).toHaveLength(100);
    expect(a.s.status).toBe(SEQ_PLAYING);

    const brk = [...cc(0, 116, 0), ...note(0, 60, 100, 2), ...wait(10), ...cc(0, 117, 10), ...cc(0, 117, 20), ...EOT];
    const b = player(seqOf(brk));
    run(b.s, b.r, 1000);
    expect(b.r.of('on')).toEqual(['0 on 0 60 100']);
    expect(b.s.status).toBe(SEQ_DONE);

    const orphan = [...note(0, 60, 100, 2), ...wait(10), ...cc(0, 117, 127), ...EOT];
    const c = player(seqOf(orphan));
    run(c.s, c.r, 100);
    expect(c.r.of('on')).toHaveLength(1);
    expect(c.s.status).toBe(SEQ_DONE);
  });

  it('nested FOR loops', () => {
    const evnt = [...cc(0, 116, 2), ...cc(0, 116, 3), ...note(0, 60, 100, 1), ...wait(2), ...cc(0, 117, 127), ...note(0, 72, 100, 1), ...wait(2), ...cc(0, 117, 127), ...EOT];
    const { s, r } = player(seqOf(evnt));
    run(s, r, 200);
    const keys = r.of('on').map((l) => l.split(' ')[3]);
    expect(keys).toEqual(['60', '60', '60', '72', '60', '60', '60', '72']);
  });

  it('stop releases every sounding note and a held sustain; resume restores the channel and carries on', () => {
    const evnt = [...prog(3, 19), ...cc(3, 7, 100), ...cc(3, 64, 127), ...note(3, 40, 90, 50), ...note(3, 47, 90, 50), ...wait(20), ...note(3, 52, 90, 5), ...wait(10), ...EOT];
    const { s, r } = player(seqOf(evnt));
    run(s, r, 5);
    s.stop();
    expect(s.status).toBe(SEQ_STOPPED);
    expect(r.log.slice(-3)).toEqual(['5 off 3 40', '5 off 3 47', '5 cc 3 64 0']);
    expect(s.activeNotes).toBe(0);
    run(s, r, 50);
    expect(r.log.filter((l) => +l.split(' ')[0]! > 5)).toEqual([]);
    const before = r.log.length;
    s.resume();
    expect(r.log.slice(before)).toEqual(['55 prog 3 19', '55 cc 3 7 100', '55 cc 3 64 127']);
    run(s, r, 30);
    // the rest of the wait was kept across the pause: 20 - 5 ticks
    expect(r.of('on').slice(-1)).toEqual(['70 on 3 52 90']);
  });

  it('end stops without the end-of-sequence callback', () => {
    const { s, r } = player(seqOf([...note(0, 60, 100, 50), ...wait(60), ...EOT]));
    let eos = 0;
    s.onEos = () => eos++;
    run(s, r, 3);
    s.end();
    expect(s.status).toBe(SEQ_DONE);
    expect(r.of('off')).toEqual(['3 off 0 60']);
    expect(eos).toBe(0);
  });

  it('cc 7 is scaled by the sequence volume and clamped; setting the volume re-sends it', () => {
    const { s, r } = player(seqOf([...cc(0, 7, 100), ...cc(1, 7, 127), ...wait(400), ...EOT]));
    s.setVolume(250);
    run(s, r, 1);
    expect(r.of('cc')).toEqual(['0 cc 0 7 127', '0 cc 1 7 127']);
    r.log.length = 0;
    s.setVolume(64);
    expect(r.of('cc')).toEqual([`1 cc 0 7 ${Math.trunc((64 * 100) / 127)}`, '1 cc 1 7 64']);
  });

  it('a volume ramp steps once per ms*1000/|delta| microseconds and re-sends every 8th service', () => {
    const { s, r } = player(seqOf([...cc(0, 7, 127), ...wait(1000), ...EOT]));
    run(s, r, 1);
    r.log.length = 0;
    s.setVolume(0, 1000); // 127 steps over a second
    expect(r.of('cc')).toEqual(['1 cc 0 7 127']); // at the current volume
    r.log.length = 0;
    run(s, r, 60);
    // half a second in: half way down
    expect(s.volume).toBeGreaterThan(60);
    expect(s.volume).toBeLessThan(67);
    const sent = r.of('cc');
    // sends only on services whose count is a multiple of 8 (the start was count 1)
    expect(sent.length).toBe(7);
    const vals = sent.map((l) => +l.split(' ')[4]!);
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeLessThan(vals[i - 1]!);
    run(s, r, 80);
    expect(s.volume).toBe(0);
  });

  it('tempo 200 % plays two ticks a service', () => {
    const { s, r } = player(seqOf([...note(0, 60, 100, 1), ...wait(40), ...note(0, 62, 100, 1), ...wait(10), ...EOT]));
    s.setTempo(200);
    run(s, r, 40);
    expect(r.of('on')).toEqual(['0 on 0 60 100', '20 on 0 62 100']);
  });

  it('AIL_branch_index jumps to an RBRN offset', () => {
    // offset 8 is the note-on of key 62
    const evnt = [...cc(0, 7, 100), ...note(0, 61, 100, 1), ...wait(5), ...note(0, 62, 100, 1), ...wait(5), ...EOT];
    const seq = seqOf(evnt, [[1, 8]]);
    const { s, r } = player(seq);
    run(s, r, 3);
    s.branchIndex(1);
    run(s, r, 20);
    expect(r.of('on')).toEqual(['0 on 0 61 100', '3 on 0 62 100']);
  });

  it('a cc 109 in the stream branches and steps over the event the branch lands on', () => {
    // 0: cc 109 = 1; 3: note 61; 7: wait; 8: cc 7 (the RBRN target); 11: note 62
    const evnt = [...cc(0, 109, 1), ...note(0, 61, 100, 1), ...wait(5), ...cc(0, 7, 90), ...note(0, 62, 100, 1), ...wait(5), ...EOT];
    const { s, r } = player(seqOf(evnt, [[1, 8]]));
    run(s, r, 20);
    expect(r.log).toEqual(['0 on 0 62 100', '1 off 0 62']);
  });

  it('pitch bend is 14-bit to the device', () => {
    const { s, r } = player(seqOf([...bend(5, 0x1fff), ...wait(2), ...EOT]));
    run(s, r, 1);
    expect(r.of('bend')).toEqual(['0 bend 5 8191']);
  });

  it('ServiceClock turns milliseconds into 120 Hz services', () => {
    const c = new ServiceClock();
    let n = 0;
    for (let i = 0; i < 60; i++) n += c.take(1000 / 60);
    expect(n).toBe(120);
    expect(c.take(10_000)).toBe(120);
  });
});
