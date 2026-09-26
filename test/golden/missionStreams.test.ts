// The mission-stream cluster (src/mission/vm/streams.ts, projectWalk.ts,
// src/mission/tables/*, src/mission/objectives.ts) run against MW2.PRJ, the
// loose .BWD files beside it and the decompilation's objectives listing.
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
//   - MTBL install: fields attached to the wrong objective or table - the
//     runtime ObjectiveTables are printed in objectives.txt's exact format
//     and compared line for line with the listing dump_objectives.py wrote
//     from the static records;
//   - target marking: masks compared per (mission, stream) with masks
//     computed from the decoded records.
import fs from 'node:fs';
import path from 'node:path';
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
import {
  preloadLooseFiles,
  projectGpspecApply,
  projectItemApply,
  projectOpenStream,
  setLooseFiles,
  SHIPPED_LOOSE_STREAMS,
  streams,
} from '../../src/mission/vm/streams.ts';
import { ARENA_BUDGET_COUNT, arenaBudgetBytes, projectLoadByName, projectWalk, tagDword } from '../../src/mission/vm/projectWalk.ts';
import { missionMarkByName, missionRecordTargetName, missionTableLoad, missionTables } from '../../src/mission/tables/missionTables.ts';
import { objectiveStartLinks, objectiveTableStart, objectives } from '../../src/mission/objectives.ts';
import { missionClock } from '../../src/mission/missionClock.ts';
import { clock } from '../../src/engine/clock.ts';
import { trackedGlobals } from '../../src/sim/ai/tracked.ts';
import { gameSource, hasDecompiled, hasGameData, MW2_ROOT, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';
import { namedStreams, type NamedStream } from '../support/bwdHelpers.ts';

// dump_objectives.TYPES / CATEGORY (as test/golden/bwdPayloads.test.ts)
const TYPES = new Map<number, string>([
  [0x0, 'timer'], [0x1, 'destroy'], [0x2, 'destroy'], [0x4, 'protect'],
  [0x8, 'identify'], [0x10, 'start'], [0x20, 'identify+req'],
  [0x100, 'reach'], [0x200, 'timer:follow'], [0x400, 'timer:rest'], [0x800, 'timer:shutdown'],
  [0x1000, 'immediate'], [0x2000, 'avoid'],
  [0x10000, 'WIN mission'], [0x20000, 'LOSE mission'],
  [0x40000, 'toggle listed'], [0x80000, 'force fail'],
  [0x100000, 'force succeed'],
]);
const CATEGORY = new Map<number, string>([[1, 'Primary'], [2, 'Secondary'], [8, 'Return']]);
/** the installer's condition codes back to the data's letters */
const CONDITION = new Map<number, string>([[1, 'C'], [2, 'S'], [3, 'F']]);

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

describe.runIf(hasGameData && hasDecompiled)('mission streams and tables', () => {
  let prj: ProjectFile;
  let streamsInPrj: NamedStream[];
  let loose: Map<string, Uint8Array>;
  const looseOnDisk = new Set<string>();

  beforeAll(async () => {
    const src = gameSource();
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    setMainProject(prj);
    setBootImage(ExeImage.fromExe(await src.read('MW2.EXE')));
    setLogSink(() => {});
    for (const f of fs.readdirSync(MW2_ROOT)) if (f.toUpperCase().endsWith('.BWD')) looseOnDisk.add(f.toUpperCase());
    loose = await preloadLooseFiles(src);
    setLooseFiles(loose);
    resetMissionState();
    streamsInPrj = namedStreams(prj);
  });

  it('the shipped loose-stream list is exactly the id -2 INCL names in MW2.PRJ, and each is beside MW2.PRJ', () => {
    const used = new Set<string>();
    for (const s of streamsInPrj)
      for (const c of s.chunks) if (c.tag === 'INCL' && c.i16(8) === -2) used.add(`${c.str(0xa, 12).toUpperCase()}.BWD`);
    expect([...used].sort()).toEqual([...SHIPPED_LOOSE_STREAMS].sort());
    for (const n of SHIPPED_LOOSE_STREAMS) expect(looseOnDisk.has(n), n).toBe(true);
    expect([...loose.keys()].sort()).toEqual([...SHIPPED_LOOSE_STREAMS].sort());
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
        // -2 is the loose file NAME.BWD beside MW2.PRJ
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
          const disk = fs.readFileSync(path.join(MW2_ROOT, [...looseOnDisk].find((f) => f === file) ?? file));
          got.push(`${where} -> loose ${file} ${sameBytes(it.base, new Uint8Array(disk)) ? 'same-bytes' : 'OTHER-bytes'}`);
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

  it('MTBL tables install for every stream, and the runtime objective tables correspond line for line to objectives.txt', () => {
    const out: string[] = ['MW2 mission objectives - MW2.PRJ', ''];
    let tables = 0;
    let records = 0;
    const names = new Set(streamsInPrj.map((s) => s.name.toLowerCase()));
    const looseNames = new Set([...looseOnDisk].map((f) => f.slice(0, -4).toLowerCase()));
    let named = 0;
    let inPrj = 0;
    let inFile = 0;
    let none = 0;
    const errorsSeen: string[] = [];
    const unresolvedSounds = new Set<string>();
    for (const s of streamsInPrj) {
      resetMissionState();
      for (const c of s.chunks) {
        if (c.tag !== 'MTBL' || c.size < MTBL_RECORDS_AT) continue;
        const { result, errors } = capturingErrors(() => missionTableLoad(c));
        if (result !== 1 || errors.length) errorsSeen.push(`${s.name}+${c.offset}: result=${result} ${errors.join('; ')}`);
        const g = c.i32(8);
        const t = objectives.objectiveTables[g]!;
        const copy = missionTables.missionTables[g]!;
        tables++;
        records += t.count;
        if (missionTables.missionTableCount < g + 1) errorsSeen.push(`${s.name}: missionTableCount ${missionTables.missionTableCount} below table ${g}`);
        for (const [nm, id] of [[t.successSoundName, t.successSound], [t.failureSoundName, t.failureSound]] as const)
          if (nm && id === -1) unresolvedSounds.add(nm);
        out.push(
          `${s.name} (BWD ${s.rid})  table ${g >>> 0}  limit ${t.timeLimit > 0 ? `${t.timeLimit}s` : 'none'}  mission ok=${t.successSoundName} fail=${t.failureSoundName}  ${t.count} objectives`,
        );
        for (let i = 0; i < t.count; i++) {
          const o = t.objectives[i]!;
          if (o.state !== 0 || o.targetCount !== 0 || o.targets[0]!.index !== 0 || o.targets[0]!.kind !== 8 || o.startedAt !== -1 || o.changedAt !== -1)
            errorsSeen.push(`${s.name} table ${g} objective ${i}: not reset as the installer resets it`);
          for (const [nm, id] of [[o.successSoundName, o.successSound], [o.failureSoundName, o.failureSound]] as const)
            if (nm && id === -1) unresolvedSounds.add(nm);
          const pre: string[] = [];
          for (const p of o.prerequisites) {
            const code = CONDITION.get(p.condition);
            if (!code) break;
            pre.push(`${code}(${p.objective},${p.table})`);
          }
          const preText = pre.length ? `${o.prereqAll ? 'all' : 'any'}:${pre.join(',')}` : '';
          // stream= is the static record's targetStreamName, read from the installed copy
          let stream = missionRecordTargetName(copy, i);
          const sl = stream.toLowerCase();
          if (sl) {
            named++;
            if (sl === 'null') none++;
            else if (names.has(sl)) inPrj++;
            else if (looseNames.has(sl)) {
              inFile++;
              stream += '@';
            } else stream += '?';
          }
          const typ = o.type >>> 0;
          const type = `${padR('0x' + typ.toString(16), 7)} ${padR(TYPES.get(typ) ?? '?', 13)}`;
          out.push(
            `  ${padL(i, 2)} ${type} limit=${padR(o.timeLimit, 4)} ${o.listed ? 'Y' : '-'}${o.isPrerequisite ? 'M' : '-'} cat=${padR(`${o.category} ${CATEGORY.get(o.category) ?? 'Tertiary'}`, 9)}` +
              ` quota=${padR(o.membersPerTarget || 'all', 3)} restraint=${o.restraint} stream=${padR(stream, 10)} ${padR(preText, 18)} ok=${padR(o.successSoundName, 9)} fail=${padR(o.failureSoundName, 9)} ${o.text}`,
          );
        }
        out.push('');
      }
    }
    out.splice(
      1,
      0,
      `${tables} objective tables, ${records} objectives. stream= names: ${named} in all - ${inPrj} a BWD stream in this file, ${inFile} a loose .BWD beside it (marked @), ${none} NULL, ${named - inPrj - inFile - none} unknown (marked ?)`,
    );
    expect(errorsSeen).toEqual([]);
    // Not an error: most announcement names are not in SNDTABLE (mission_result_format loads them by name through dev_dir_load_sfl).
    if (unresolvedSounds.size) console.info(`${unresolvedSounds.size} announcement names SNDTABLE does not resolve (id -1), e.g. ${[...unresolvedSounds].sort().slice(0, 8).join(' ')}`);
    expectSameLines('objectives.txt (from the installed tables)', lines(readListing('objectives.txt')), out);
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
