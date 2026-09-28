// NetMech end to end: two MW2.EXE stations, each in its own process
// (test/sim/netStation.ts - the port's state is module globals, one program
// per process), joined by this test acting as the network. Every packet a
// station sends is carried to the other before the other's next step, and
// the two are stepped in a fixed order with a fixed number of timer ticks,
// so a run is deterministic. The mission is NETDEMO's first, BRO2SCN1,
// launched with NETDEMO's command line (-n -g=NETWAIT).
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PORT_DIR } from '../../tools/paths.ts';
import { hasGameData } from '../support/env.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** timer ticks fed before each step: about 26 passes a second, the original's pace */
const TICKS = 7;

interface Sent {
  to: number;
  bytes: number[];
}
interface MechState {
  index: number;
  flags: number;
  pos: number[];
  angles: number[];
  status: number;
  ramps: number[][];
  sections: number[][];
}
interface StationState {
  station: number;
  simTick: number;
  simClockLast: number;
  simClockMode: number;
  netRole: number;
  netSessionState: number;
  netMasterStation: number;
  netMyStation: number;
  netActiveStations: number;
  netStationFlags: number[];
  netOpponentAnnounced: number[];
  playerMechIndex: number;
  mechs: MechState[];
  messages: string[];
  videoText: string | null;
  thingsDestroyed: number[];
  running: boolean;
}
interface Reply {
  id: number;
  error?: string;
  done?: boolean;
  ok?: boolean | null;
  outbox?: Sent[];
  received?: { from: number; bytes: number[] }[];
  state?: StationState;
  before?: StationState;
  bytes?: number[];
}

class Station {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, (r: Reply) => void>();
  private nextId = 1;
  private stderr = '';
  readonly ready: Promise<void>;

  constructor(
    readonly station: number,
    count: number,
    mission: string,
  ) {
    this.child = fork(path.join(HERE, 'netStation.ts'), [String(station), String(count), mission], {
      cwd: PORT_DIR,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.stderr!.on('data', (d: Buffer) => (this.stderr += d.toString()));
    this.ready = new Promise((resolve, reject) => {
      this.child.once('exit', (code) => reject(new Error(`station ${station} exited (${code}): ${this.stderr}`)));
      this.waiting.set(0, () => resolve());
    });
    this.child.on('message', (m: Reply) => {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      w?.(m);
    });
  }

  async call(cmd: Record<string, unknown>): Promise<Reply> {
    const id = this.nextId++;
    const r = await new Promise<Reply>((resolve) => {
      this.waiting.set(id, resolve);
      this.child.send({ id, ...cmd });
    });
    if (r.error) throw new Error(`station ${this.station}: ${r.error}`);
    return r;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.removeAllListeners('exit');
    await this.call({ cmd: 'exit' }).catch(() => {});
  }
}

/** The network: carries each packet a station sent to its destination. */
async function relay(from: number, sent: Sent[] | undefined, stations: Station[]): Promise<void> {
  for (const p of sent ?? []) await stations[p.to]!.call({ cmd: 'deliver', from, bytes: p.bytes });
}

/** A packet's messages, split at the 'EOP\xff' terminators. */
function messagesOf(bytes: number[]): number[][] {
  const out: number[][] = [];
  let start = 0;
  for (let i = 3; i < bytes.length; i++) {
    if (bytes[i - 3] === 0x45 && bytes[i - 2] === 0x4f && bytes[i - 1] === 0x50 && bytes[i] === 0xff) {
      out.push(bytes.slice(start, i - 3));
      start = i + 1;
    }
  }
  return out;
}
const tag = (m: number[]) => String.fromCharCode(m[0]!, m[1]!);
const i32 = (m: number[], at: number) => (m[at]! | (m[at + 1]! << 8) | (m[at + 2]! << 16) | (m[at + 3]! << 24)) | 0;

/** Both stations' join, a pass each in turn, until both are through it. */
async function join(stations: Station[]): Promise<Reply[]> {
  const last: Reply[] = [];
  const done = stations.map(() => false);
  for (let pass = 0; pass < 200 && done.includes(false); pass++) {
    for (const s of stations) {
      if (done[s.station]) continue;
      const r = await s.call({ cmd: 'join', ticks: TICKS });
      await relay(s.station, r.outbox, stations);
      last[s.station] = r;
      done[s.station] = r.done === true;
    }
  }
  return last;
}

/** One frame of each station, in station order, each one's packets delivered before the next steps. */
async function frames(stations: Station[]): Promise<Reply[]> {
  const out: Reply[] = [];
  for (const s of stations) {
    const r = await s.call({ cmd: 'frame', ticks: TICKS });
    await relay(s.station, r.outbox, stations);
    out.push(r);
  }
  return out;
}

/** A station's frame: the DAs it took from station `from`, in order. */
const dasFrom = (r: Reply, from: number) =>
  (r.received ?? [])
    .filter((p) => p.from === from)
    .flatMap((p) => messagesOf(p.bytes))
    .filter((m) => tag(m) === 'DA');

describe.runIf(hasGameData)('netplay: two stations', () => {
  let stations: Station[] = [];
  let joined: Reply[] = [];

  beforeAll(async () => {
    stations = [new Station(0, 2, 'BRO2SCN1'), new Station(1, 2, 'BRO2SCN1')];
    await Promise.all(stations.map((s) => s.ready));
    joined = await join(stations);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(stations.map((s) => s.stop()));
  });

  it("joins: station 0 the master, station 1 a client on the master's clock", () => {
    const [a, b] = joined.map((r) => r.state!);
    expect(joined.map((r) => r.ok)).toEqual([true, true]);
    for (const s of [a!, b!]) {
      expect(s.netSessionState).toBe(1);
      expect(s.netActiveStations).toBe(2);
      expect(s.netMasterStation).toBe(0);
      // station n drives mechTable[n]
      expect(s.playerMechIndex).toBe(s.station);
      // stations past the count are gone
      expect(s.netStationFlags.slice(2)).toEqual([0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f]);
      expect(s.videoText).toMatch(/^Link established/);
    }
    expect([a!.netRole, a!.simClockMode]).toEqual([1, 0]);
    expect([b!.netRole, b!.simClockMode]).toEqual([2, 2]);
  });

  it('DA packets round-trip byte for byte', async () => {
    const [A, B] = stations as [Station, Station];
    let checked = 0;
    for (let f = 0; f < 60 && checked < 4; f++) {
      const ra = await A.call({ cmd: 'frame', ticks: TICKS });
      const sent = (ra.outbox ?? []).filter((p) => p.to === 1);
      await relay(0, ra.outbox, stations);
      const da = sent.flatMap((p) => messagesOf(p.bytes)).find((m) => tag(m) === 'DA');
      if (!da) {
        await relay(1, (await B.call({ cmd: 'frame', ticks: TICKS })).outbox, stations);
        continue;
      }
      // station 1 runs main's first call alone - netplay_frame_exchange - so its replica is as the packet left it
      const rb = await B.call({ cmd: 'exchange' });
      await relay(1, rb.outbox, stations);
      // the driver carried the packet unchanged
      expect(rb.received!.filter((p) => p.from === 0).map((p) => p.bytes)).toEqual(sent.map((p) => p.bytes));
      expect(da.length).toBe(0x48);
      // the packet is station 0's mech, and the master's clock
      const owner = ra.before!.mechs[0]!;
      expect(da[2]).toBe(0);
      expect([i32(da, 0x1c), i32(da, 0x20), i32(da, 0x24)]).toEqual(owner.pos);
      expect([i32(da, 0x28), i32(da, 0x2c), i32(da, 0x30)]).toEqual(owner.angles);
      expect(i32(da, 0x18)).toBe(ra.before!.simTick);
      // station 1's replica put back through the same encoder is the packet again, but for the
      // simTick, which only the master writes
      const again = (await B.call({ cmd: 'reencode', mech: 0 })).bytes!;
      expect(again).toEqual([...da.slice(0, 0x18), 0, 0, 0, 0, ...da.slice(0x1c)]);
      checked++;
    }
    expect(checked).toBe(4);
  }, 60_000);

  it("the master's clock drives the client", async () => {
    let adopted = 0;
    let worst = 0;
    for (let f = 0; f < 60; f++) {
      const [ra, rb] = (await frames(stations)) as [Reply, Reply];
      expect(rb.state!.simClockMode).toBe(2);
      expect(ra.state!.simClockMode).toBe(0);
      const das = dasFrom(rb, 0);
      if (das.length > 0) {
        // the client takes the master's simTick from its DA; sim_clock_step then holds it at simClockLast if that is not ahead
        const s = i32(das[das.length - 1]!, 0x18);
        expect(s).toBeGreaterThan(0);
        expect(rb.state!.simTick).toBe(s - rb.before!.simTick >= 1 ? s : rb.before!.simTick);
        adopted++;
      }
      worst = Math.max(worst, Math.abs(ra.state!.simTick - rb.state!.simTick));
    }
    // ten DAs a second (every 0x12 ticks): one about every third frame at 7 ticks a frame
    expect(adopted).toBeGreaterThanOrEqual(20);
    expect(worst).toBeLessThanOrEqual(0x12 + 2 * TICKS);
  }, 60_000);

  it('a mech destroyed on the master shows destroyed on the client within the exchange period', async () => {
    const [A, B] = stations as [Station, Station];
    const hit = (await A.call({ cmd: 'destroySection', location: 3 })).state!;
    expect([4, 5]).toContain(hit.mechs[0]!.status);
    const start = hit.simTick;
    let seenAt: StationState | null = null;
    let ticks = 0;
    for (let f = 0; f < 10 && !seenAt; f++) {
      const [ra, rb] = (await frames([A, B])) as [Reply, Reply];
      ticks = ra.state!.simTick - start;
      const replica = rb.state!.mechs[0]!;
      if (replica.status === 4 || replica.status === 5) seenAt = rb.state!;
    }
    expect(seenAt).not.toBeNull();
    // the next DA goes within 0x12 ticks of the destruction, and the client applies it on its next frame
    expect(ticks).toBeLessThanOrEqual(0x12 + TICKS);
    const replica = seenAt!.mechs[0]!;
    // the centre torso's internal structure is gone on the replica too, and the section destroyed (flags 0x2000)
    expect(replica.sections[2]![2]).toBe(0);
    expect(replica.sections[2]![3]! & 0x2000).toBe(0x2000);
    expect(seenAt!.netOpponentAnnounced[0]).toBe(1);
    expect(seenAt!.messages).toContain('Opponent mech 0 destroyed.');
  }, 60_000);

  it('a station that leaves signs off, and the last one ends the session', async () => {
    const [A, B] = stations as [Station, Station];
    const ra = await A.call({ cmd: 'quit', ticks: TICKS });
    expect(ra.state!.running).toBe(false);
    expect(ra.state!.netSessionState).toBe(2);
    expect(ra.state!.netRole).toBe(0);
    const ss = (ra.outbox ?? []).filter((p) => p.to === 1).flatMap((p) => messagesOf(p.bytes));
    expect(ss.map(tag)).toEqual(['SS']);
    await relay(0, ra.outbox, stations);
    const rb = await B.call({ cmd: 'frame', ticks: TICKS });
    // station 1 answers SS, marks station 0 gone and removes its mech; one station left ends the session
    expect((rb.outbox ?? []).flatMap((p) => messagesOf(p.bytes)).map(tag)[0]).toBe('SS');
    const b = rb.state!;
    expect(b.netStationFlags[0]).toBe(0x1f);
    expect(b.mechs[0]!.status).toBe(4);
    expect(b.netActiveStations).toBe(1);
    expect(b.netMasterStation).toBe(1);
    expect([b.netSessionState, b.netRole, b.simClockMode]).toEqual([2, 0, 0]);
    expect(b.messages).toContain('Opponent 0 exited the game.');
  }, 60_000);
});

describe.runIf(hasGameData)('netplay: destroyed gamethings (SN)', () => {
  let stations: Station[] = [];

  beforeAll(async () => {
    // AMY_SCN1 has 26 gamethings, so the misread lands on real ones
    stations = [new Station(0, 2, 'AMY_SCN1'), new Station(1, 2, 'AMY_SCN1')];
    await Promise.all(stations.map((s) => s.ready));
    await join(stations);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(stations.map((s) => s.stop()));
  });

  it('is read one byte behind: gamething i >= 8 arrives as i + 8, one below 8 as both i and i + 8', async () => {
    const [A, B] = stations as [Station, Station];
    await A.call({ cmd: 'destroyThing', thing: 2 });
    const a = (await A.call({ cmd: 'destroyThing', thing: 9 })).state!;
    expect(a.thingsDestroyed).toEqual(expect.arrayContaining([2, 9]));
    const before = (await B.call({ cmd: 'state' })).state!.thingsDestroyed;
    for (let f = 0; f < 6; f++) {
      const [, rb] = (await frames([A, B])) as [Reply, Reply];
      const sn = (rb.received ?? [])
        .filter((p) => p.from === 0)
        .flatMap((p) => messagesOf(p.bytes))
        .find((m) => tag(m) === 'SN');
      if (!sn) continue;
      // byte 0 carries 0..7 (bit 2 set), byte 1 carries 8..15 (bit 9 set)
      expect(sn.slice(2, 4)).toEqual([0x20, 0x40]);
      const now = rb.state!.thingsDestroyed.filter((i) => !before.includes(i));
      expect(now).toEqual(expect.arrayContaining([2, 10, 17]));
      expect(now).not.toContain(9);
      return;
    }
    throw new Error('no SN arrived');
  }, 60_000);
});
