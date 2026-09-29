// The mission-stream cluster (src/mission/vm/streams.ts, projectWalk.ts,
// src/mission/tables/*, src/mission/objectives.ts) run against MW2.PRJ and
// the loose .BWD files a mission's disk has.
//
// What each check would catch:
//   - by-name opening: a TABL 14 lookup that returned a neighbour's id (each
//     stream's name must come back as ITS resource, same bytes);
//   - INCL / GPS: an include that opened the wrong stream - the stream each
//     opens must carry the name the reference spells, byte for byte the
//     resource or loose file that name belongs to;
//   - arena budgets: a walk that mis-summed, double-counted or failed to
//     dedupe - compared per mission, all ten budgets on one line, against an
//     independent re-walk written here from the C;
//   - target marking: masks compared per (mission, stream) with masks
//     computed from the decoded records.
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile, resourceIdByName } from '../../src/data/prj/ProjectFile.ts';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { type Chunk, type ProjectItem, walkStream } from '../../src/data/bwd/stream.ts';
import { decodeMtbl, MTBL_RECORDS_AT } from '../../src/data/bwd/payloads/mtbl.ts';
import { setSystemErrorHandler } from '../../src/core/systemError.ts';
import { setLogSink } from '../../src/core/log.ts';
import { globalGroups } from '../../src/engine/globals.ts';
import { setBootImage } from '../../src/engine/image.ts';
import { setMainProject } from '../../src/engine/resources/cache.ts';
import { projectGpspecApply, projectItemApply, projectOpenStream, setLooseFiles, SHIPPED_LOOSE_STREAMS, streams } from '../../src/mission/vm/streams.ts';
import { ARENA_BUDGET_COUNT, arenaBudgetBytes, projectLoadByName, projectWalk, tagDword } from '../../src/mission/vm/projectWalk.ts';
import { missionMarkByName, missionTableLoad, missionTables } from '../../src/mission/tables/missionTables.ts';
import { objectiveStartLinks, objectiveTableStart, objectives } from '../../src/mission/objectives.ts';
import { missionClock } from '../../src/mission/missionClock.ts';
import { clock } from '../../src/engine/clock.ts';
import { trackedGlobals } from '../../src/sim/ai/tracked.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';
import { expectSameLines } from '../support/listing.ts';
import { namedStreams, type NamedStream } from '../support/bwdHelpers.ts';

const RESET = ['streams', 'scenario', 'missionTables', 'objectives', 'projectWalk', 'missionClock', 'mechs', 'tracked', 'clock'];
function resetMissionState(): void {
  for (const g of globalGroups()) if (RESET.includes(g.name)) g.reset();
}

/** system_error calls made while fn runs, as 'code: detail'. */
function capturingErrors<T>(fn: () => T): { result: T; errors: string[] } {
  const errors: string[] = [];
  setSystemErrorHandler((code, detail) => errors.push(`0x${code.toString(16)}${detail ? ': ' + detail : ''}`));
  try {
    return { result: fn(), errors };
  } finally {
    setSystemErrorHandler(() => {});
  }
}

describe.runIf(hasGameData)('mission streams and tables', () => {
  let prj: ProjectFile;
  let streamsInPrj: NamedStream[];
  let loose: Map<string, Uint8Array>;

  beforeAll(async () => {
    const src = gameSource();
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    setMainProject(prj);
    setBootImage(ExeImage.fromExe(await src.read('MW2.EXE')));
    setLogSink(() => {});
    // the loose streams as a mission's disk has them: the player's star and the (empty) enemy
    // stars the shell writes before a mission, and INSTMAP1.BWD (test/support/env.ts)
    const disk = installFiles();
    loose = new Map(SHIPPED_LOOSE_STREAMS.map((n) => [n, disk.get(n)!]));
    setLooseFiles(loose);
    resetMissionState();
    streamsInPrj = namedStreams(prj);
  });

  it("the loose-stream list is exactly the id -2 INCL names in MW2.PRJ, and a mission's disk has each", () => {
    const used = new Set<string>();
    for (const s of streamsInPrj)
      for (const c of s.chunks) if (c.tag === 'INCL' && c.i16(8) === -2) used.add(`${c.str(0xa, 12).toUpperCase()}.BWD`);
    expect([...used].sort()).toEqual([...SHIPPED_LOOSE_STREAMS].sort());
    for (const n of SHIPPED_LOOSE_STREAMS) expect(loose.get(n), n).toBeDefined();
  });

  it('MW2.PRJ has no STBL chunk and no by-name (-1) or ^ reference: the scenario substitution is never exercised', () => {
    const odd: string[] = [];
    for (const s of streamsInPrj)
      for (const c of s.chunks) {
        if (c.tag === 'STBL') odd.push(`${s.name} STBL at ${c.offset}`);
        if (c.tag === 'INCL' && (c.i16(8) === -1 || c.str(0xa, 12).startsWith('^'))) odd.push(`${s.name} INCL ${c.i16(8)} ${c.str(0xa, 12)}`);
        if (c.tag === 'GPS' && c.i16(0xa) === -1) odd.push(`${s.name} GPS -1 ${c.str(0x24, 12)}`);
      }
    expect(odd).toEqual([]);
  });

  it('every named BWD stream (the 59 SCN missions among them) opens by name through TABL 14 as itself', () => {
    const want: string[] = [];
    const got: string[] = [];
    let scn = 0;
    for (const s of streamsInPrj) {
      if (/SCN\d$/i.test(s.name)) scn++;
      want.push(`${s.name} -> BWD ${s.rid} cached=1 name=${s.name.slice(0, 8)} same-bytes errors=`);
      const { result: item, errors } = capturingErrors(() => projectOpenStream({ id: -1, name: s.name }));
      got.push(
        item
          ? `${s.name} -> BWD ${item.resourceId} cached=${item.cached} name=${item.name} ${item.base === prj.readResource('BWD', s.rid) || sameBytes(item.base, s.bytes) ? 'same-bytes' : 'OTHER-bytes'} errors=${errors.join('; ')}`
          : `${s.name} -> null errors=${errors.join('; ')}`,
      );
    }
    expect(scn).toBe(59);
    expectSameLines('open by name', want, got);
  });

  it('every INCL and GPS in every stream opens the stream its reference names', () => {
    const want: string[] = [];
    const got: string[] = [];
    let incl = 0;
    let gps = 0;
    for (const s of streamsInPrj) {
      for (const c of s.chunks) {
        if (c.tag !== 'INCL' && c.tag !== 'GPS') continue;
        const id = c.tag === 'INCL' ? c.i16(8) : c.i16(0xa);
        const name = c.tag === 'INCL' ? c.str(0xa, 12) : c.str(0x24, 12);
        if (c.tag === 'INCL') incl++;
        else gps++;
        const where = `${s.name}+${c.offset} ${c.tag} (${id}, ${name})`;
        // expected: a numeric id is the resource whose record header carries that name;
        // -2 is the loose file NAME.BWD on the mission's disk
        if (id >= 0) want.push(`${where} -> BWD ${id} ${name.toLowerCase()} same-bytes`);
        else want.push(`${where} -> loose ${name.toUpperCase()}.BWD same-bytes`);
        let opened: ProjectItem | null = null;
        const handler = (it: ProjectItem) => {
          opened = it;
          return 1;
        };
        const { result, errors } = capturingErrors(() => (c.tag === 'INCL' ? projectItemApply(c, handler) : projectGpspecApply(c, handler)));
        const it = opened as ProjectItem | null;
        if (!it || result !== 1 || errors.length) {
          got.push(`${where} -> FAILED result=${result} errors=${errors.join('; ')}`);
          continue;
        }
        if (it.cached === 1) {
          const rn = prj.resourceName('BWD', it.resourceId).toLowerCase();
          got.push(`${where} -> BWD ${it.resourceId} ${rn} ${sameBytes(it.base, prj.readResource('BWD', it.resourceId)) ? 'same-bytes' : 'OTHER-bytes'}`);
        } else {
          const file = `${name.toUpperCase()}.BWD`;
          const onDisk = loose.get(file);
          got.push(`${where} -> loose ${file} ${onDisk && sameBytes(it.base, onDisk) ? 'same-bytes' : 'OTHER-bytes'}`);
        }
      }
    }
    expect(incl).toBeGreaterThan(0);
    expect(gps).toBeGreaterThan(0);
    expectSameLines('INCL/GPS resolution', want, got);
  });

  it('every stream starts REV (not older than 1.22) then DTBL, and every SCN mission measures without an error', () => {
    const bad: string[] = [];
    for (const s of streamsInPrj) {
      if (s.chunks[0]?.tag !== 'REV' || s.chunks[1]?.tag !== 'DTBL') bad.push(`${s.name}: ${s.chunks.slice(0, 2).map((c) => c.tag)}`);
      else if (s.chunks[0].str(8, 8) < '1.22') bad.push(`${s.name}: REV ${s.chunks[0].str(8, 8)}`);
    }
    expect(bad).toEqual([]);
    for (const s of streamsInPrj.filter((x) => /SCN\d$/i.test(x.name))) {
      resetMissionState();
      const { result, errors } = capturingErrors(() => projectLoadByName(s.name));
      expect(result, s.name).not.toBeNull();
      expect(errors, s.name).toEqual([]);
      // project_load_by_name leaves the seen list empty and the mission tables freed
      expect(streams.streamSeen).toEqual([]);
      expect(missionTables.missionTables.every((t) => t === null)).toBe(true);
    }
  });

  it('arena budgets for every SCN mission match an independent re-walk of the include tree', () => {
    const want: string[] = [];
    const got: string[] = [];
    for (const s of streamsInPrj.filter((x) => /SCN\d$/i.test(x.name))) {
      resetMissionState();
      projectLoadByName(s.name);
      got.push(`${s.name} ${budgetLine((i) => arenaBudgetBytes(i), (i) => projectWalk.arenaBudget[i]!.tag)} sums ${sumsLine(projectWalk)}`);
      const e = independentBudget(prj, loose, s.rid);
      want.push(`${s.name} ${budgetLine((i) => e.budget[i]!, (i) => tagDword(TAGS[i]!))} sums ${sumsLine(e.sums)}`);
    }
    expect(arenaBudgetBytes(-1)).toBe(0);
    expect(arenaBudgetBytes(10)).toBe(0);
    expectSameLines('arena budgets', want, got);
    // A few absolute values, printed for the record.
    for (const n of ['AMY_SCN1', 'AQUASCN1']) {
      const line = got.find((l) => l.startsWith(n + ' '));
      if (line) console.info(line);
    }
  });

  it("objective_table_start places the group at objective 0's tracked-object target and stamps the start times", () => {
    resetMissionState();
    const s = streamsInPrj.find((x) => x.name === 'AMY_SCN1')!;
    for (const c of s.chunks) if (c.tag === 'MTBL') missionTableLoad(c);
    const calls: number[][] = [];
    const saved = objectiveStartLinks.starPlaceFormation;
    objectiveStartLinks.starPlaceFormation = (...a: number[]) => {
      calls.push(a);
      return 1;
    };
    try {
      clock.simTick = 182 * 37 + 5;
      const tr = trackedGlobals.trackedObjects[3]!;
      tr.x = 1000;
      tr.y = -20;
      tr.z = 30000;
      tr.heading = 0x5a0000;
      trackedGlobals.trackedObjectCount = 4;
      // table 0: a tracked-object target (index 3, kind 1); table 1: the installer's dead 0x800 entry
      const o = objectives.objectiveTables[0]!.objectives[0]!;
      o.targetCount = 1;
      o.targets[0]!.index = 3;
      o.targets[0]!.kind = 1;
      expect(objectiveTableStart(0)).toBe(1);
      expect(objectiveTableStart(1)).toBe(0);
      // index past trackedObjectCount: origin
      o.targets[0]!.index = 4;
      expect(objectiveTableStart(0)).toBe(0);
    } finally {
      objectiveStartLinks.starPlaceFormation = saved;
    }
    expect(calls).toEqual([
      [0, 1000, -20, 30000, 0x5a0000],
      [1, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(missionClock.missionSeconds).toBe(37);
    expect(objectives.objectiveTables[1]!.startTime).toBe(37);
    expect(objectives.objectiveTables[1]!.objectives[0]!.startedAt).toBe(37);
    expect(objectives.objectiveTables[1]!.objectives[1]!.startedAt).toBe(-1);
  });

  it('mission_mark_by_name marks, per mission, exactly the objectives whose target stream has the name', () => {
    const want: string[] = [];
    const got: string[] = [];
    for (const s of streamsInPrj.filter((x) => x.chunks.some((c) => c.tag === 'MTBL'))) {
      resetMissionState();
      const decoded = new Map<number, ReturnType<typeof decodeMtbl>>();
      for (const c of s.chunks)
        if (c.tag === 'MTBL' && c.size >= MTBL_RECORDS_AT) {
          missionTableLoad(c);
          decoded.set(c.i32(8), decodeMtbl(c));
        }
      const targetNames = new Set<string>();
      for (const t of decoded.values()) for (const r of t.records) if (r.targetStreamName) targetNames.add(r.targetStreamName.toUpperCase());
      for (const n of [...targetNames].sort()) {
        let mask = 0;
        const hits: string[] = [];
        for (const [g, t] of [...decoded].sort((a, b) => a[0] - b[0]))
          t.records.forEach((r, i) => {
            if (r.targetStreamName.toUpperCase() === n) {
              mask = (mask | (1 << (i & 31)) | ((1 << g) << 16)) >>> 0;
              hits.push(`${g}.${i}`);
            }
          });
        want.push(`${s.name} ${n} mask=${mask.toString(16)} marked=${hits.join(',')}`);
        // mark a fresh copy of the states each time: clear 7s left by the previous name
        for (const t of objectives.objectiveTables) for (const o of t.objectives) if (o.state === 7) o.state = 0;
        const m = missionMarkByName(n.toLowerCase());
        const marked: string[] = [];
        objectives.objectiveTables.forEach((t, g) =>
          t.objectives.forEach((o, i) => {
            if (o.state === 7) marked.push(`${g}.${i}`);
          }),
        );
        got.push(`${s.name} ${n} mask=${m.toString(16)} marked=${marked.join(',')}`);
      }
    }
    expect(missionMarkByName('')).toBe(0);
    expectSameLines('mission_mark_by_name', want, got);
  });
});

// ---------------------------------------------------------------- helpers

const TAGS = ['AGP', 'MGP', 'SEG', 'TLIS', 'ADAT', 'ANTK', 'ANFL', 'OBJI', 'CID', 'CINS'];

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function budgetLine(bytes: (i: number) => number, tag: (i: number) => number): string {
  const parts: string[] = [];
  for (let i = 0; i < ARENA_BUDGET_COUNT; i++) {
    const t = tag(i);
    const name = String.fromCharCode(t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff).replace(/\0+$/, '');
    parts.push(`${name}=${bytes(i)}`);
  }
  return parts.join(' ');
}

interface Sums {
  dtblCountAGP: number;
  dtblCount1534ba: number;
  dtblCountSEG: number;
  dtblCountOBJI: number;
  dtblCount1534c0: number;
  dtblCount1534c2: number;
  dtblCountTLIS: number;
  dtblCountANTK: number;
  dtblBytesANFL: number;
}
function sumsLine(s: Sums): string {
  return [s.dtblCountAGP, s.dtblCount1534ba, s.dtblCountSEG, s.dtblCountOBJI, s.dtblCount1534c0, s.dtblCount1534c2, s.dtblCountTLIS, s.dtblCountANTK, s.dtblBytesANFL].join(',');
}

/**
 * The budget computed a second way: recursion over walkStream, the include
 * references resolved directly (a numeric id is that BWD resource, -2 the
 * loose file), shorts wrapped with DataView, and the ANTK/ANFL dedupe keyed
 * as stream_seen_find keys it - a resource by id, a loose file by its
 * 8-character name, case-sensitively.
 */
function independentBudget(prj: ProjectFile, loose: Map<string, Uint8Array>, rootRid: number): { budget: number[]; sums: Sums } {
  const w = new DataView(new ArrayBuffer(32));
  // shorts at 0,2,4,6,8,10,12,14 (AGP, ba, SEG, OBJI, c0, c2, TLIS, ANTK); int at 16 (ANFL)
  const seen = new Set<string>();
  const visit = (bytes: Uint8Array, key: string) => {
    const chunks: Chunk[] = [...walkStream(bytes)];
    const dtbl = chunks[1]!;
    const first = !seen.has(key);
    seen.add(key);
    for (let k = 0; k < 7; k++) w.setInt16(k * 2, w.getInt16(k * 2, true) + dtbl.i16(8 + k * 2), true);
    if (first) {
      w.setInt16(14, w.getInt16(14, true) + dtbl.i16(0x16), true);
      w.setInt32(16, w.getInt32(16, true) + dtbl.i32(0x18), true);
    }
    for (const c of chunks.slice(1)) {
      if (c.tag !== 'INCL' && c.tag !== 'GPS') continue;
      const id = c.tag === 'INCL' ? c.i16(8) : c.i16(0xa);
      const name = c.tag === 'INCL' ? c.str(0xa, 12) : c.str(0x24, 12);
      if (id === -2) visit(loose.get(`${name.toUpperCase()}.BWD`)!, `n:${name.slice(0, 8)}`);
      else if (id === -1) {
        const rid = resourceIdByName(prj, 14, name);
        visit(prj.readResource('BWD', rid)!, `i:${rid}`);
      } else visit(prj.readResource('BWD', id)!, `i:${id}`);
    }
  };
  visit(prj.readResource('BWD', rootRid)!, `i:${rootRid}`);
  const sums: Sums = {
    dtblCountAGP: w.getInt16(0, true),
    dtblCount1534ba: w.getInt16(2, true),
    dtblCountSEG: w.getInt16(4, true),
    dtblCountOBJI: w.getInt16(6, true),
    dtblCount1534c0: w.getInt16(8, true),
    dtblCount1534c2: w.getInt16(10, true),
    dtblCountTLIS: w.getInt16(12, true),
    dtblCountANTK: w.getInt16(14, true),
    dtblBytesANFL: w.getInt32(16, true),
  };
  const budget = [
    sums.dtblCountAGP * 0x1ec,
    sums.dtblCountAGP * 0x852,
    sums.dtblCountSEG * 0x7c,
    sums.dtblCountTLIS * 0x18,
    sums.dtblCountTLIS * 0x28,
    sums.dtblCountANTK * 0x14,
    sums.dtblBytesANFL,
    sums.dtblCountOBJI * 8,
    sums.dtblCountOBJI * 4,
    sums.dtblCountOBJI * 4,
  ];
  return { budget, sums };
}
