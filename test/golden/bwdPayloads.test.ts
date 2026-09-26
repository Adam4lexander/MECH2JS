// The BWD payload decoders (src/data/bwd/payloads), run over every named BWD
// stream in MW2.PRJ as project_next_chunk walks it, printed in each dump
// tool's exact format and compared line by line with its listing.
//
// Each listing is reproduced by re-running its tool's own bookkeeping (the
// replay, the cross-references, the Counter orderings) over the DECODED
// chunks, so a decoder that read a field from the wrong offset, or attached
// one record's field to its neighbour, changes a line.
//
// The dump tools walk streams with dump_objectives.chunks(), which stops on
// a chunk under 8 bytes or one running past the payload and ignores the BWD
// header's streamLength and maxChunkSize; the port walks them with
// projectNextChunk. The first test checks that the two give the same chunks
// for every stream, so the comparison below is of the payload reads alone.
import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectFile, readNameTable } from '../../src/data/prj/ProjectFile.ts';
import { tagOf } from '../../src/data/bwd/stream.ts';
import { cstr } from '../../src/core/binary/ByteReader.ts';
import { i16 } from '../../src/core/int/cint.ts';
import { widenObjectiveMask as widen } from '../../src/data/bwd/payloads/objectiveMask.ts';
import { decodeGps } from '../../src/data/bwd/payloads/gps.ts';
import { decodeNavo, decodeNavp } from '../../src/data/bwd/payloads/navp.ts';
import { decodeGt } from '../../src/data/bwd/payloads/gt.ts';
import { decodeAffl } from '../../src/data/bwd/payloads/affl.ts';
import { decodeTsk } from '../../src/data/bwd/payloads/tsk.ts';
import { decodePtbl } from '../../src/data/bwd/payloads/ptbl.ts';
import { decodeMtbl, MTBL_RECORDS_AT, MTBL_RECORD_SIZE, type MissionObjectiveRecord } from '../../src/data/bwd/payloads/mtbl.ts';
import { decodeObjl } from '../../src/data/bwd/payloads/objl.ts';
import { decodeXplo } from '../../src/data/bwd/payloads/xplo.ts';
import { decodeBmen, decodeBmid, decodeBmpj, decodeBsec } from '../../src/data/bwd/payloads/bitmap3d.ts';
import { decodeStar } from '../../src/data/bwd/payloads/star.ts';
import { decodeFtbl } from '../../src/data/bwd/payloads/ftbl.ts';
import { gameSource, hasDecompiled, hasGameData, MW2_ROOT, readListing } from '../support/env.ts';
import { diffLines, expectSameLines, lines, padL, padR } from '../support/listing.ts';
import {
  cmp,
  cmpTuple,
  Counter,
  dumpAtoi,
  namedStreams,
  type NamedStream,
  objPolyNames,
  pyBytesRepr,
  pyFixed,
  pyFloat,
  pyG,
  pyStrRepr,
  resourceNames,
} from '../support/bwdHelpers.ts';

const h4 = (v: number) => (v & 0xffff).toString(16).padStart(4, '0');

// dump_objectives.TYPES / CATEGORY
const TYPES = new Map<number, string>([
  [0x0, 'timer'], [0x1, 'destroy'], [0x2, 'destroy'], [0x4, 'protect'],
  [0x8, 'identify'], [0x10, 'start'], [0x20, 'identify+req'],
  [0x100, 'reach'], [0x200, 'timer:follow'], [0x400, 'timer:rest'], [0x800, 'timer:shutdown'],
  [0x1000, 'immediate'], [0x2000, 'avoid'],
  [0x10000, 'WIN mission'], [0x20000, 'LOSE mission'],
  [0x40000, 'toggle listed'], [0x80000, 'force fail'],
  [0x100000, 'force succeed'],
]);
/** dump_objectives.TYPES before commit 716e3a2, which named the three timers apart. */
const TYPES_BEFORE_716E3A2 = new Map<number, string>([...TYPES, [0x200, 'timer'], [0x400, 'timer'], [0x800, 'timer']]);
const CATEGORY = new Map<number, string>([[1, 'Primary'], [2, 'Secondary'], [8, 'Return']]);
const PREREQ = new Map<number, string>([[0x43, 'C'], [0x53, 'S'], [0x46, 'F']]);

/** dump_objectives.record(): the columns one objective prints. */
function objectiveColumns(r: MissionObjectiveRecord, types = TYPES) {
  const pre: string[] = [];
  for (const p of r.prereqs) {
    const code = PREREQ.get(p.condition);
    if (!code) break; // objective_is_active stops at the first non-condition
    pre.push(`${code}(${p.record},${p.table})`);
  }
  const typ = r.type >>> 0;
  return {
    type: `${padR('0x' + typ.toString(16), 7)} ${padR(types.get(typ) ?? '?', 13)}`,
    limit: r.timeLimit,
    listed: r.listed === 0x56 ? 'Y' : '-',
    req: r.isPrerequisite === 0x4d ? 'M' : '-',
    cat: r.category,
    pre: pre.length ? `${r.prereqAll ? 'all' : 'any'}:${pre.join(',')}` : '',
    stream: r.targetStreamName,
    ok: r.successSound,
    fail: r.failureSound,
    text: r.text,
    quota: r.membersPerTarget,
    restraint: r.restraint,
  };
}

/** dump_bitmap3d.replay: one stream's BMPJ/BMID/BSEC/BMEN, replayed as the dump replays them. */
interface SlotState {
  block?: number;
  period?: number;
  mode?: number;
}
function replay(s: NamedStream, cnames: Map<number, string>, byName: Map<string, number>, stats = new Counter<string>()) {
  const blocks = new Map<number, string[]>();
  const slots = new Map<number, SlotState>();
  let current = 0;
  let pending = false;
  let seen = false;
  const slot = (a: number) => {
    let x = slots.get(a);
    if (!x) slots.set(a, (x = {}));
    return x;
  };
  for (const c of s.chunks) {
    if (c.tag !== 'BMPJ' && c.tag !== 'BMID' && c.tag !== 'BSEC' && c.tag !== 'BMEN') continue;
    seen = true;
    stats.add(c.tag);
    if (c.tag === 'BMPJ') {
      const f = decodeBmpj(c).frame;
      let cid = f.id;
      if (cid === -1) {
        stats.add('by name');
        cid = byName.get(f.name.toLowerCase()) ?? -1;
      }
      if (pending) {
        current++;
        pending = false;
      }
      let name = cnames.get(cid);
      if (name === undefined) {
        stats.add('unresolved');
        name = `?CEL ${cid}`;
      }
      let blk = blocks.get(current);
      if (!blk) blocks.set(current, (blk = []));
      if (blk.length < 32) blk.push(name);
    } else if (c.tag === 'BMID') {
      const x = slot(decodeBmid(c).slot);
      x.block = current;
      x.mode = 1;
      pending = true;
    } else if (c.tag === 'BSEC') {
      const d = decodeBsec(c);
      const x = slot(d.slot);
      x.period = d.ticksPerFrame;
      if (x.mode === undefined) x.mode = 1;
    } else {
      const d = decodeBmen(c);
      slot(d.slot).mode = d.playMode;
    }
  }
  return { slots, blocks, seen };
}

describe.runIf(hasGameData && hasDecompiled)('BWD chunk payloads', () => {
  let prj: ProjectFile;
  let streams: NamedStream[];
  let polyNames: Map<number, string>;

  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    streams = namedStreams(prj);
    polyNames = resourceNames(prj, 'POLY');
  });

  it("project_next_chunk and the dump tools' chunks() walk every stream alike", () => {
    let differ = 0;
    for (const s of streams) {
      const py: string[] = [];
      const dv = new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength);
      for (let pos = 0; pos + 8 <= s.bytes.length; ) {
        const lead = s.bytes[pos] === 0x42 && s.bytes[pos + 1] === 0x57 && s.bytes[pos + 2] === 0x44 && s.bytes[pos + 3] === 0;
        const size = lead ? 0xc : dv.getUint32(pos + 4, true);
        if (size < 8 || pos + size > s.bytes.length) break;
        py.push(`${pos}:${tagOf(s.bytes, pos)}:${size}`);
        pos += size;
      }
      const port = s.chunks.map((c) => `${c.offset}:${c.tag}:${c.size}`);
      if (py.slice(1).join() !== port.join()) differ++;
    }
    expect(streams.length).toBeGreaterThan(0);
    expect(differ).toBe(0);
  });

  it('gamepieces.txt corresponds line for line', () => {
    const mekNames = resourceNames(prj, 'MEK');
    const objTags = (mask: number) => {
      const m = widen(mask);
      const names: string[] = [];
      for (let bit = 0; bit < 32; bit++) {
        const b = 2 ** bit;
        if (Math.floor(m / b) % 2) {
          const n = TYPES.get(b) ?? `type${b.toString(16)}`;
          if (!names.includes(n)) names.push(n);
        }
      }
      return names.join(',') || 'none';
    };
    const rng = (v: number) => {
      v &= 0xffff;
      return v === 0xffff ? 'nolimit' : `${v || 250}m`;
    };
    const flagTags = (f: number) => {
      const t = [f & 0x1400 ? 'combatant' : 'non-combatant'];
      if (f & 0x1000) t.push('any-range');
      if (f & 0x0800) t.push('never-target');
      const rest = f & ~0x1c00;
      if (rest) t.push(`unknown(${h4(rest)})`);
      return t.join(',');
    };
    const out: string[] = [];
    let total = 0;
    let mismatch = 0;
    let nomek = 0;
    const skill = new Counter<number>();
    const ftags = new Counter<string>();
    for (const s of streams) {
      const rows: string[] = [];
      for (const c of s.chunks) {
        if (c.tag !== 'GPS') continue;
        const g = decodeGps(c);
        const sh = g.gpsParams.map(i16);
        total++;
        skill.add(sh[4]! & 0xff);
        ftags.add(flagTags(g.flags));
        const mname = mekNames.get(g.mekId);
        let check = '';
        if (mname === undefined) {
          nomek++;
          check = `  (no MEK ${g.mekId})`;
        } else if (mname.toLowerCase() !== g.configName.toLowerCase()) {
          mismatch++;
          check = `  MEK ${g.mekId} IS ${mname}`;
        }
        const side = g.side === 0 ? 'PLAYER' : g.side === 1 ? 'side1' : `side${g.side}`;
        rows.push(
          `  grp ${padL(g.group, 2)}${g.leader === 1 ? '*' : ' '} ${padR(side, 6)} ${padR(g.chassisName, 9)} ${padR(g.configName, 9)} mek ${padL(g.mekId, 4)}` +
            `  think ${sh[0]}  leash ${rng(sh[1]!)} acq ${rng(sh[3]!)} restacq ${rng(sh[2]!)}  skill ${sh[4]! & 0xff}  rest ${sh[5]} ${sh[6]} ${sh[7]}` +
            `  obj ${h4(g.objectiveMask)} ${padR('[' + objTags(g.objectiveMask) + ']', 26)} flags ${h4(g.flags)} ${padR('[' + flagTags(g.flags) + ']', 28)} ${g.name} | ${g.nameAlt}${check}`,
        );
      }
      if (rows.length) out.push(`${s.name} (BWD ${s.rid})  ${rows.length} gamepieces`, ...rows, '');
    }
    out.unshift(
      `MW2 gamepieces (GPS chunks) - MW2.PRJ, ${total} chunks, ${mismatch} config/MEK name mismatches, ${nomek} with no MEK resource`,
      'skill byte (0 is read as 1; outside 1..4 becomes 1): ' + skill.sorted().map(([k, v]) => `${k} x${v}`).join(', '),
      'flags (+0x22, MechEntity.flags): ' + ftags.sorted().map(([k, v]) => `${k} x${v}`).join(', '),
      '* = group leader; leash/acq/restacq = the GPS ranges aiRangeOp4/2/1 (+0x12/+0x16/+0x14), 0 shown as the 250 m default; only local-AI mechs get them',
      '',
    );
    expectSameLines('gamepieces.txt', lines(readListing('gamepieces.txt')), out);
  });

  it('navpoints.txt corresponds line for line', () => {
    const out: string[] = [];
    const count = new Counter<string>();
    const inUse = new Counter<number>();
    const perStream = new Counter<number>();
    let inBlk = 0;
    let tailNonzero = 0;
    for (const s of streams) {
      const objs = objPolyNames(s.chunks, polyNames, (pid) => `?POLY ${pid}`);
      const rows: string[] = [];
      let depth = 0;
      for (const c of s.chunks) {
        if (c.tag === 'BLK') depth++;
        else if (c.tag === 'ENDB') depth = Math.max(0, depth - 1);
        else if (c.tag === 'NAVP') {
          const n = decodeNavp(c);
          if (c.bytes.subarray(0x3a, 0x50).some((b) => b !== 0)) tailNonzero++;
          count.add('NAVP');
          inUse.add(n.inUse);
          if (depth) inBlk++;
          rows.push(
            `  ${padL(rows.length, 2)} NAVP ${padR(pyStrRepr(n.name), 22)} pos ${padL(n.x, 8)} ${padL(n.y, 6)} ${padL(n.z, 8)}${depth ? ' (BLK frame)' : ''}` +
              `  heading ${padL(pyFixed(n.heading / 65536, 2), 7)}  inUse ${n.inUse}  flags ${h4(n.flags)}  handle ${h4(n.targetHandle)}` +
              `  group ${padL(n.groupId, 2)}  range ${padL(n.rangeMetres, 6)} m  obj ${h4(n.objectiveMask)}->${h4(widen(n.objectiveMask))}`,
          );
        } else if (c.tag === 'NAVO') {
          const n = decodeNavo(c);
          count.add('NAVO');
          rows.push(
            `  ${padL(rows.length, 2)} NAVO on ${n.objectId} ${objs.get(n.objectId) ?? '?'}  range ${n.range} (as-is)  obj ${h4(n.objectiveMask)}->${h4(widen(n.objectiveMask))}`,
          );
        }
      }
      if (rows.length) {
        perStream.add(rows.length);
        out.push(`${s.name} (BWD ${s.rid})  ${rows.length} navpoints`, ...rows, '');
      }
    }
    const kv = (c: Counter<number>) => c.sorted().map(([k, v]) => `${k} x${v}`).join(', ');
    out.unshift(
      `MW2 navpoints (NAVP / NAVO chunks) - MW2.PRJ, ${count.sorted().map(([k, v]) => `${k} ${v}`).join(', ')}`,
      `inUse as loaded: ${kv(inUse)}   (TrackedObject.inUse is only ever tested against zero)`,
      `NAVP inside BLK..ENDB (position is in the block's frame): ${inBlk}`,
      `NAVP bytes +0x3a..+0x4f, which the branch never reads, non-zero in ${tailNonzero} chunks`,
      `navpoints per stream: ${kv(perStream)}`,
      'heading in degrees (16.16 in the chunk); range in metres (the game stores * 100 as cm)',
      '',
    );
    expectSameLines('navpoints.txt', lines(readListing('navpoints.txt')), out);
  });

  it('gamethings.txt corresponds line for line', () => {
    const flagTags = (f: number) => {
      const t: string[] = [];
      if (f & 0x8000) t.push('debris');
      t.push(f & 0x1400 ? 'combatant' : 'non-combatant');
      if (f & 0x1000) t.push('any-range');
      if (f & 0x0800) t.push('never-target');
      if (f & 0x0004) t.push('destroyed');
      if (f & 0x0020) t.push('identified');
      const rest = f & ~0x9c24;
      if (rest) t.push(`unknown(${h4(rest)})`);
      return t.join(',');
    };
    const out: string[] = [];
    let total = 0;
    const resolved = new Counter<string>();
    const unread = new Counter<string>();
    const affl = new Counter<number>();
    const flagset = new Counter<number>();
    const zeroHp = new Counter<number>();
    for (const s of streams) {
      const objs = objPolyNames(s.chunks, polyNames, (pid) => `?POLY ${pid}`);
      const rows: string[] = [];
      let affiliation = -1;
      for (const c of s.chunks) {
        if (c.tag === 'AFFL') {
          affiliation = decodeAffl(c).affiliation;
          continue;
        }
        if (c.tag !== 'GT') continue;
        const g = decodeGt(c);
        unread.add([...c.bytes.subarray(0x0c, 0x18)].map((b) => b.toString(16).padStart(2, '0')).join(''));
        affl.add(affiliation);
        flagset.add(g.flags);
        if (g.hitPoints === 0) zeroHp.add(g.flags);
        total++;
        const ref = (i: number, kind: string) => {
          if (i === -1) return '-';
          const o = objs.get(i);
          if (o !== undefined) {
            resolved.add(`${kind} ok`);
            return `${i} ${o}`;
          }
          resolved.add(`${kind} missing`);
          return `${i} ?`;
        };
        const obj = ref(g.objectId, 'object');
        const repl = g.objectId !== -1 ? ref(g.replacementId, 'replacement') : `(${g.replacementId}, not read)`;
        rows.push(
          `  hp ${padL(g.hitPoints, 5)}  flags ${h4(g.flags)} ${padR('[' + flagTags(g.flags) + ']', 28)} obj ${h4(g.objectiveMask)}->${h4(widen(g.objectiveMask))}` +
            `  affl ${padL(affiliation, 2)}  ${padR(g.name, 22)} | ${padR(g.nameAlt, 22)}  is ${padR(obj, 18)}  destroyed ${repl}`,
        );
      }
      if (rows.length) out.push(`${s.name} (BWD ${s.rid})  ${rows.length} gamethings`, ...rows, '');
    }
    const unreadCommon = unread.mostCommon(6).map(([k, v]) => `${k} x${v}`).join(', ');
    out.unshift(
      `MW2 gamethings (GT chunks) - MW2.PRJ, ${total} chunks`,
      `ids resolved to an OBJ in the same stream: object ${resolved.get('object ok')} of ${resolved.get('object ok') + resolved.get('object missing')}, replacement ${resolved.get('replacement ok')} of ${resolved.get('replacement ok') + resolved.get('replacement missing')}`,
      'affiliation in force (from AFFL): ' + affl.sorted().map(([k, v]) => `${k} x${v}`).join(', '),
      `bytes +0x0c..+0x17, which the GT branch never reads: ${unreadCommon}${unread.size > 6 ? ` (and ${unread.size - 6} other patterns)` : ''}`,
      'flags as loaded, with how many of each have hp 0: ' + flagset.mostCommon().map(([k, v]) => `${h4(k)} [${flagTags(k)}] x${v} (${zeroHp.get(k)})`).join(', '),
      '  (0x8000 is DEBRIS - see GameThing.flags: every one of these places an OBJ whose parent is some',
      "   GT's replacement record, and its geometry becomes loose destructible pieces when it appears)",
      'columns: hp; flags; objective mask as stored -> as widened; affiliation; name | nameAlt;',
      "         'is' = the OBJ the gamething is (id and its POLY); 'destroyed' = the replacement shown after",
      '',
    );
    expectSameLines('gamethings.txt', lines(readListing('gamethings.txt')), out);
  });

  it('tasks.txt corresponds line for line', () => {
    const TASK_TYPES = new Map<number, string>([[0, 'rotate'], [1, 'colour_cycle'], [2, 'drive'], [3, 'anim'], [4, 'sound'], [5, 'track']]);
    type Path = [number, number];
    const pathOf = (c: Parameters<typeof decodePtbl>[0]): [string, Path] => {
      const p = decodePtbl(c);
      return [p.name, [p.points.length, p.points.reduce((a, x) => a + x.duration, 0)]];
    };
    const PATHS = new Map<string, Path[]>();
    for (const s of streams)
      for (const c of s.chunks)
        if (c.tag === 'PTBL') {
          const [name, path] = pathOf(c);
          const k = name.toLowerCase();
          if (!PATHS.has(k)) PATHS.set(k, []);
          PATHS.get(k)!.push(path);
        }
    const distinct = (ps: Path[]) => new Set(ps.map((p) => p.join(','))).size;
    const LOCAL = new Map<string, Path>();
    const trackPaths = new Counter<string>();
    let missing = 0;

    type V = number | string | null;
    const show = (v: V, isFloat: boolean) => {
      if (v === null) {
        missing++;
        return '-';
      }
      return isFloat ? pyG(v as number) : String(v);
    };
    // dump_tasks.scan: sscanf-like, fields after the first failed float left unset
    const scan = (params: string, conv: string): V[] => {
      const p = params.split(',');
      const out: V[] = [];
      for (let i = 0; i < conv.length; i++) {
        if (i >= p.length) {
          out.push(null);
          continue;
        }
        const c = conv[i];
        if (c === 'f') {
          const f = pyFloat(p[i]!);
          if (f === null) {
            for (let j = i; j < conv.length; j++) out.push(null);
            break;
          }
          out.push(f);
        } else out.push(c === 'd' ? dumpAtoi(p[i]!) : p[i]!);
      }
      return out;
    };
    const decode = (kind: number, params: string): string => {
      if (kind === 0) {
        const [pch, yaw, rol, per] = scan(params, 'ffff') as Array<number | null>;
        const ticks = per !== null ? Math.trunc(per! * 182.0) : 0;
        const a = show(pch!, true);
        const b = show(yaw!, true);
        const r = show(rol!, true);
        return `turns pitch ${a} yaw ${b} roll ${r} degrees every ${ticks ? `${pyG(per!)} s (${ticks} ticks)` : '1 s (0 -> 0xb6 default)'}`;
      }
      if (kind === 1) return 'values ' + params.split(',').slice(0, 16).map((x) => String(dumpAtoi(x))).join(',');
      if (kind === 2) {
        const [rad, lap, gate, unused] = scan(params, 'ffdd');
        const a = show(rad!, true);
        const b = show(lap!, true);
        const g = show(gate!, false);
        return `circle radius ${a}, lap ${b} s, gate ${g}${unused === null ? '' : `, 4th ${unused} (never stored)`}`;
      }
      if (kind === 3) {
        const [frame, role, track] = scan(params, 'ddd') as Array<number | null>;
        const kindOf = role === null ? '-' : role === 0 ? 'DISABLED (0)' : role! > 0x7f ? `CONTROLLING (${role})` : `plain (${role})`;
        const t = show(track!, false);
        const f = show(frame!, false);
        return `track ${t}, frame time ${f} ticks, ${kindOf}`;
      }
      if (kind === 4) {
        const [cutoff, name, gate] = scan(params, 'dsd');
        const audible = cutoff === null || (cutoff as number) < 500 ? '' : ' (audible to 500 m, the falloff limit)';
        const n = show(name!, false);
        const c = show(cutoff!, false);
        const g = show(gate!, false) + (gate !== null ? '' : ' (never written: uninitialised heap memory decides)');
        return `sound ${n}, cutoff ${c} m${audible}, gate ${g}`;
      }
      if (kind === 5) {
        const w = [...params.split(','), '', '', ''].slice(0, 3);
        const mode = w[0]!.toLowerCase() === 'loop' ? 'loop' : w[0]!.toLowerCase() === 'repeat' ? 'repeat' : 'once';
        const face = w[1]!.toLowerCase() === 'rotate' ? 'face travel' : 'point angles';
        const key = w[2]!.toLowerCase();
        let path: Path | null;
        let where: string;
        if (LOCAL.has(key)) {
          path = LOCAL.get(key)!;
          where = '';
          trackPaths.add('in its own stream');
        } else if (PATHS.has(key)) {
          path = PATHS.get(key)![0]!;
          where = ' FROM ANOTHER STREAM';
          trackPaths.add('only in another stream');
        } else {
          path = null;
          where = '';
          trackPaths.add('MISSING');
        }
        if (PATHS.has(key) && distinct(PATHS.get(key)!) > 1) where += ` (name has ${distinct(PATHS.get(key)!)} different paths in MW2.PRJ)`;
        return `path ${w[2]} (${path ? `${path[0]} points, ${path[1]} ticks` : 'NO SUCH PTBL'}${where}) ${mode}, ${face}  [words ${w.join(',')}]`;
      }
      return `UNKNOWN TYPE ${pyStrRepr(params)}`;
    };

    const out: string[] = [];
    let total = 0;
    let unparsed = 0;
    const kinds = new Counter<number>();
    const periods = new Map<number, Counter<number>>();
    const target = new Counter<string>();
    const words = new Counter<string>();
    for (const s of streams) {
      const objs = objPolyNames(s.chunks, polyNames, (pid) => `?POLY ${pid}`);
      LOCAL.clear();
      for (const c of s.chunks)
        if (c.tag === 'PTBL') {
          const [name, path] = pathOf(c);
          if (!LOCAL.has(name.toLowerCase())) LOCAL.set(name.toLowerCase(), path);
        }
      const rows: string[] = [];
      for (const c of s.chunks) {
        if (c.tag !== 'TSK') continue;
        const t = decodeTsk(c);
        total++;
        kinds.add(t.type);
        if (!periods.has(t.type)) periods.set(t.type, new Counter<number>());
        periods.get(t.type)!.add(t.period);
        let params: string;
        let who: string;
        if (t.objectIdText !== null) {
          params = t.parameters!;
          const oid = dumpAtoi(t.objectIdText);
          const o = objs.get(oid);
          if (o !== undefined) {
            target.add('object in stream');
            who = `${oid} ${o}`;
          } else {
            target.add('id not an OBJ in this stream');
            who = `${oid} ?`;
          }
        } else {
          params = t.argument;
          target.add("no ';' - global list");
          who = '(global list)';
        }
        if (t.type === 5) for (const w of params.split(',').slice(0, 2)) words.add(w);
        const before = missing;
        const text = decode(t.type, params);
        if (text.startsWith('UNKNOWN') || missing !== before) unparsed++;
        rows.push(`  ${padR(TASK_TYPES.get(t.type) ?? `type ${t.type}`, 11)} every ${padL(t.period, 3)}  on ${padR(who, 20)} ${text}`);
      }
      if (rows.length) out.push(`${s.name} (BWD ${s.rid})  ${rows.length} tasks`, ...rows, '');
    }
    const tn = (k: number) => TASK_TYPES.get(k) ?? String(k);
    out.unshift(
      `MW2 scheduled tasks (TSK chunks) - MW2.PRJ, ${total} chunks, ${unparsed} with a field their format left unset (shown as -)`,
      'by type: ' + kinds.sorted().map(([k, v]) => `${tn(k)} x${v}`).join(', '),
      'target: ' + target.mostCommon().map(([k, v]) => `${k} ${v}`).join(', '),
      'period (+0x0a, ticks between runs) by type: ' +
        [...periods.keys()]
          .sort((a, b) => a - b)
          .map((k) => `${tn(k)} ${periods.get(k)!.mostCommon(4).map(([p, v]) => `${p} x${v}`).join(', ')}`)
          .join('; '),
      `track paths (case-insensitive, first match wins, as the stricmp loop): ${PATHS.size} PTBL names in MW2.PRJ; ${trackPaths.mostCommon().map(([k, v]) => `${k} ${v}`).join(', ')}`,
      'track: first two words seen: ' + words.mostCommon().map(([k, v]) => `${k} x${v}`).join(', '),
      "values are labelled in each handler's parse order; a name like 'arg4' or 'a b c' means the",
      "field's meaning is NOT established - see the handler notes in tools/annotations.json",
      '',
    );
    expectSameLines('tasks.txt', lines(readListing('tasks.txt')), out);
  });

  it('objectives.txt corresponds line for line', () => {
    const out: string[] = ['MW2 mission objectives - MW2.PRJ', ''];
    let tables = 0;
    let records = 0;
    const streamNames = new Set(streams.map((s) => s.name.toLowerCase()));
    const loose = new Set(
      fs
        .readdirSync(MW2_ROOT)
        .filter((f) => f.toUpperCase().endsWith('.BWD'))
        .map((f) => f.slice(0, -4).toLowerCase()),
    );
    let named = 0;
    let inPrj = 0;
    let inFile = 0;
    let none = 0;
    for (const s of streams) {
      for (const c of s.chunks) {
        if (c.tag !== 'MTBL' || c.size < MTBL_RECORDS_AT) continue;
        const t = decodeMtbl(c);
        tables++;
        records += t.records.length;
        out.push(
          `${s.name} (BWD ${s.rid})  table ${t.group >>> 0}  limit ${t.timeLimit > 0 ? `${t.timeLimit}s` : 'none'}  mission ok=${t.successSound} fail=${t.failureSound}  ${t.records.length} objectives`,
        );
        t.records.forEach((r, i) => {
          const o = objectiveColumns(r);
          let stream = o.stream;
          const sl = stream.toLowerCase();
          if (sl) {
            named++;
            if (sl === 'null') none++;
            else if (streamNames.has(sl)) inPrj++;
            else if (loose.has(sl)) {
              inFile++;
              stream += '@';
            } else stream += '?';
          }
          out.push(
            `  ${padL(i, 2)} ${o.type} limit=${padR(o.limit, 4)} ${o.listed}${o.req} cat=${padR(`${o.cat} ${CATEGORY.get(o.cat) ?? 'Tertiary'}`, 9)}` +
              ` quota=${padR(o.quota || 'all', 3)} restraint=${o.restraint} stream=${padR(stream, 10)} ${padR(o.pre, 18)} ok=${padR(o.ok, 9)} fail=${padR(o.fail, 9)} ${o.text}`,
          );
        });
        out.push('');
      }
    }
    out.splice(
      1,
      0,
      `${tables} objective tables, ${records} objectives. stream= names: ${named} in all - ${inPrj} a BWD stream in this file, ${inFile} a loose .BWD beside it (marked @), ${none} NULL, ${named - inPrj - inFile - none} unknown (marked ?)`,
    );
    expectSameLines('objectives.txt', lines(readListing('objectives.txt')), out);
  });

  it('every MTBL string ends inside its field (the installer copies them unbounded)', () => {
    let strings = 0;
    const overruns: string[] = [];
    const field = (s: NamedStream, c: { bytes: Uint8Array }, o: number, n: number, what: string) => {
      strings++;
      if (!c.bytes.subarray(o, o + n).includes(0)) overruns.push(`${s.name} +0x${o.toString(16)} ${what}`);
    };
    for (const s of streams)
      for (const c of s.chunks) {
        if (c.tag !== 'MTBL' || c.size < MTBL_RECORDS_AT) continue;
        field(s, c, 0x12, 11, 'successSound');
        field(s, c, 0x1d, 9, 'failureSound');
        const n = decodeMtbl(c).records.length;
        for (let i = 0; i < n; i++) {
          const o = MTBL_RECORDS_AT + i * MTBL_RECORD_SIZE;
          field(s, c, o + 0x34, 11, 'successSound');
          field(s, c, o + 0x3f, 11, 'failureSound');
          field(s, c, o + 0x4a, 9, 'targetStreamName');
          field(s, c, o + 0x57, 64, 'text');
        }
      }
    expect(strings).toBeGreaterThan(0);
    expect(overruns).toEqual([]);
  });

  it('objective_targets.txt corresponds line for line', () => {
    const payloads = new Map<string, NamedStream>();
    for (const s of streams) payloads.set(s.name, s);
    const byLower = new Map<string, string>();
    for (const n of payloads.keys()) byLower.set(n.toLowerCase(), n);
    interface Placement {
      kind: string;
      label: string;
      mask: number;
      wide: number;
    }
    const placements = new Map<string, Placement[]>();
    for (const [name, s] of payloads) {
      const rows: Placement[] = [];
      for (const c of s.chunks) {
        let p: Omit<Placement, 'wide'> | null = null;
        if (c.tag === 'GT') {
          const g = decodeGt(c);
          p = { kind: 'gamething', label: g.name, mask: g.objectiveMask };
        } else if (c.tag === 'GPS') {
          const g = decodeGps(c);
          p = { kind: 'mech', label: g.name, mask: g.objectiveMask };
        } else if (c.tag === 'NAVP') {
          const n = decodeNavp(c);
          p = { kind: 'navpoint', label: n.name, mask: n.objectiveMask };
        } else if (c.tag === 'NAVO') {
          p = { kind: 'navobject', label: '', mask: decodeNavo(c).objectiveMask };
        }
        if (p) rows.push({ ...p, wide: widen(p.mask) });
      }
      placements.set(name, rows);
    }
    const build = (types: Map<number, string>): string[] => {
      const out: string[] = [];
      const stats = new Counter<string>();
      for (const [name, s] of payloads) {
        for (const c of s.chunks) {
          if (c.tag !== 'MTBL') continue;
          const t = decodeMtbl(c);
          const body: string[] = [];
          t.records.forEach((r, i) => {
            const ident = r.targetStreamName;
            const type = objectiveColumns(r, types).type;
            if (!ident) return;
            stats.add('objectives with an identifier');
            const src = byLower.get(ident.toLowerCase());
            if (src === undefined) {
              stats.add('no stream of that name');
              body.push(`  ${padL(i, 2)} ${type} ${padR(ident, 10)}  -> no stream named ${ident}`);
              return;
            }
            const hits = placements.get(src)!.filter((p) => (p.wide & r.type) !== 0);
            stats.add('objectives bound to a stream');
            if (!hits.length) stats.add('bound, but no placement matches the type');
            if (hits.length > 16) stats.add('over 16 candidates (excess dropped)');
            body.push(
              `  ${padL(i, 2)} ${type} ${padR(ident, 10)}  <- ${src}: ${hits.length} target${hits.length === 1 ? '' : 's'}${hits.length > 16 ? '  (only the first 16 attach)' : ''}`,
            );
            hits.forEach((h, k) => body.push(`        ${k < 16 ? '  ' : 'x '}${padR(h.kind, 9)} ${padR(h.label, 22)} mask ${h4(h.mask)} -> ${h4(h.wide)}`));
          });
          if (body.length) out.push(`${name}  table ${t.group >>> 0}`, ...body, '');
        }
      }
      out.unshift(
        'MW2 objective targets - MW2.PRJ',
        "an objective's targets = placements in the stream WITH ITS NAME whose widened",
        "mask shares a bit with its type; shown by name in stream order ('x' = past the",
        '16-target cap). Whether that stream runs in this mission is not checked (INCL).',
        ...stats.sorted().map(([k, v]) => `${k}: ${v}`),
        '',
      );
      return out;
    };
    const want = lines(readListing('objective_targets.txt'));
    const current = build(TYPES);
    if (diffLines(want, current).length === 0) return;
    // STALE LISTING. objective_targets.txt was last generated (b41cb18) before
    // dump_objectives.TYPES split the 0x200 / 0x400 / 0x800 labels into
    // timer:follow / timer:rest / timer:shutdown (716e3a2); running today's
    // dump_objective_targets.py prints those labels, and differs from the
    // checked-in file in exactly those lines. Until the listing is
    // regenerated it must match, line for line, the tool as it was when it
    // was written.
    console.warn('[golden] objective_targets.txt predates dump_objectives TYPES 716e3a2 - comparing with the old timer labels; regenerate the listing');
    expectSameLines('objective_targets.txt', want, build(TYPES_BEFORE_716E3A2));
  });

  it('objloc.txt corresponds line for line', () => {
    const SECTIONS = new Map<number, string>([[0, 'none'], [1, 'head'], [2, 'RT'], [3, 'CT'], [4, 'LT'], [5, 'RA'], [6, 'LA'], [7, 'RL'], [8, 'LL']]);
    const out: string[] = [];
    let totalObjl = 0;
    let unresolved = 0;
    let unlocated = 0;
    let pieces = 0;
    const locCount = new Counter<number>();
    for (const s of streams) {
      if (!s.chunks.some((c) => c.tag === 'OBJL')) continue;
      let gen = 0;
      let on = false;
      let depth = 0;
      const parts = new Map<string, { ns: number; id: number; meshes: string[] }>();
      const groups: Array<{ locs: Map<string, number>; ns: number; gi: number }> = [];
      let current: (typeof groups)[number] | null = null;
      for (const c of s.chunks) {
        const ns = on ? gen : 0;
        if (c.tag === 'MON') {
          gen++;
          on = true;
        } else if (c.tag === 'MOFF') on = false;
        else if (c.tag === 'REPR') depth++;
        else if (c.tag === 'ENDR') depth = Math.max(0, depth - 1);
        else if (c.tag === 'OBJ' && depth) {
          const oid = c.i16(8);
          const pid = c.i16(0x38);
          const k = `${ns},${oid}`;
          if (!parts.has(k)) parts.set(k, { ns, id: oid, meshes: [] });
          parts.get(k)!.meshes.push(polyNames.get(pid) ?? `?${pid}`);
        } else if (c.tag === 'GP' || c.tag === 'GPS') {
          current = { locs: new Map(), ns, gi: groups.length };
          groups.push(current);
        } else if (c.tag === 'OBJL') {
          const o = decodeObjl(c);
          totalObjl++;
          if (o.location === -1) continue;
          const k = `${ns},${o.partId}`;
          if (!parts.has(k)) unresolved++;
          if (current === null) {
            current = { locs: new Map(), ns, gi: groups.length };
            groups.push(current);
          }
          current.locs.set(k, o.location);
          locCount.add(o.location);
        }
      }
      out.push(`${s.name} (BWD ${s.rid})`);
      for (const g of groups) {
        pieces++;
        const owned = [...parts.entries()].filter(([, p]) => p.ns === g.ns);
        out.push(`  gamepiece ${g.gi}${g.ns ? ` (namespace ${g.ns})` : ''}: ${owned.length} parts`);
        for (const [k, p] of owned) {
          const loc = g.locs.get(k) ?? 0;
          if (loc === 0) unlocated++;
          out.push(`    part ${padL(p.id, 3)}  ${padR(SECTIONS.get(loc) ?? `?${loc}`, 4)} ${loc ? '' : '(vanishes from the wreck)'}  ${p.meshes.join(' ')}`);
        }
      }
      out.push('');
    }
    out.unshift(
      `MW2 part-to-section maps (OBJL chunks) - MW2.PRJ, ${totalObjl} chunks over ${pieces} gamepieces`,
      `OBJL ids that name no detail part in their stream's namespace: ${unresolved}`,
      'parts per section: ' + locCount.sorted().map(([k, v]) => `${SECTIONS.get(k) ?? k} ${v}`).join(', ') + `; parts with no OBJL (location 0): ${unlocated}`,
      "NO part is located at RT (2) or LT (4): direct weapon hits reach RT only through mech_apply_damage's 50% re-roll of CT hits, and never reach LT - only blasts and collisions do",
      'a hit on an unlocated part (location 0) does no damage: mech_apply_damage refuses 0',
      'meshes are listed by detail level, most detailed first (REPR nest 1, 2, ...)',
      '',
    );
    expectSameLines('objloc.txt', lines(readListing('objloc.txt')), out);
  });

  it('bitmap3d.txt corresponds line for line', () => {
    const cnames = resourceNames(prj, 'CEL');
    const byName = new Map<string, number>();
    for (const [k, v] of cnames) byName.set(v.toLowerCase(), k);
    const MODES = new Map<number, string>([[0, 'stopped'], [2, 'once']]);
    const out: string[] = [];
    const count = new Counter<string>();
    let unresolved = 0;
    let byNameUsed = 0;
    let unbound = 0;
    const periods = new Counter<number>();
    const modes = new Counter<string>();
    const framesPerSlot = new Counter<number>();
    for (const s of streams) {
      const stats = new Counter<string>();
      const { slots, blocks, seen } = replay(s, cnames, byName, stats);
      for (const k of ['BMPJ', 'BMID', 'BSEC', 'BMEN']) count.add(k, stats.get(k));
      byNameUsed += stats.get('by name');
      unresolved += stats.get('unresolved');
      if (!seen) continue;
      out.push(`${s.name} (BWD ${s.rid})  ${slots.size} slots, ${blocks.size} frame blocks`);
      for (const [slot, st] of slots) {
        const blk = st.block;
        const frames = blk !== undefined ? (blocks.get(blk) ?? []) : [];
        if (blk === undefined) unbound++;
        framesPerSlot.add(frames.length);
        if (st.period !== undefined) periods.add(st.period);
        if (st.mode !== undefined) modes.add(MODES.get(st.mode) ?? 'loop');
        out.push(
          `  slot ${padL(slot, 3)}  ${st.period !== undefined ? `every ${st.period} ticks (${pyFixed(st.period / 182.0, 2)} s)` : 'period unset (0x2d default when the slot is set up)'}` +
            `  ${st.mode !== undefined ? `mode ${st.mode} ${MODES.get(st.mode) ?? 'loop'}` : 'mode unset'}  ${padL(frames.length, 2)} frames: ` +
            (frames.length ? frames.join(' ') : blk === undefined ? 'NO BMID - not bound to a block' : '-'),
        );
      }
      out.push('');
    }
    out.unshift(
      `MW2 3dbitmap animations - MW2.PRJ, ${count.sorted().map(([k, v]) => `${k} ${v}`).join(', ')}`,
      `BMPJ frames given by name (TABL 8 MAPTABLE): ${byNameUsed}; frame ids that are not a CEL resource: ${unresolved}`,
      `slots set by BSEC/BMEN with no BMID in the same stream: ${unbound}`,
      'frames per slot: ' + framesPerSlot.sorted().map(([k, v]) => `${k} x${v}`).join(', '),
      'period (ticksPerFrame, 182 Hz) in force per SLOT - the last BSEC wins: ' + periods.mostCommon(8).map(([k, v]) => `${k} x${v}`).join(', '),
      'play mode: ' + modes.mostCommon().map(([k, v]) => `${k} x${v}`).join(', '),
      '',
    );
    expectSameLines('bitmap3d.txt', lines(readListing('bitmap3d.txt')), out);
  });

  it('xplo.txt corresponds line for line', () => {
    const cnames = resourceNames(prj, 'CEL');
    const byName = new Map<string, number>();
    for (const [k, v] of cnames) byName.set(v.toLowerCase(), k);
    // slot -> distinct (stream, frames) bindings over every stream
    const bound = new Map<number, Map<string, { stream: string; frames: string[] }>>();
    for (const s of streams) {
      const { slots, blocks } = replay(s, cnames, byName);
      for (const [slot, st] of slots) {
        if (st.block === undefined) continue;
        const frames = blocks.get(st.block) ?? [];
        if (!bound.has(slot)) bound.set(slot, new Map());
        bound.get(slot)!.set(JSON.stringify([s.name, frames]), { stream: s.name, frames });
      }
    }
    const out: string[] = [];
    let total = 0;
    let objOk = 0;
    let objMissing = 0;
    let noObj = 0;
    let clamped = 0;
    const sprite = new Counter<string>();
    const typesUsed = new Counter<number>();
    for (const s of streams) {
      const objs = objPolyNames(s.chunks, polyNames, (pid) => `?POLY ${pid}`);
      const rows: string[] = [];
      for (const c of s.chunks) {
        if (c.tag !== 'XPLO') continue;
        const x = decodeXplo(c);
        total++;
        let etype = x.typeIndex;
        let etypeS: string;
        if (!(etype >= 0 && etype <= 0x1f)) {
          clamped++;
          etypeS = `${etype} -> 3`;
          etype = 3;
        } else etypeS = String(etype);
        typesUsed.add(etype);
        let obj: string;
        if (x.objectId === -1) {
          noObj++;
          obj = '(none)';
        } else if (objs.has(x.objectId)) {
          objOk++;
          obj = `${x.objectId} ${objs.get(x.objectId)}`;
        } else {
          objMissing++;
          obj = `${x.objectId} ?`;
        }
        const b = x.bitmapSlot;
        let spr: string;
        if (b <= 0) {
          spr = b === -1 ? 'none' : `slot ${b} (NOT started: the XPLO test is > 0)`;
          sprite.add(b === -1 ? 'none' : 'slot 0');
        } else if (bound.has(b)) {
          const bs = [...bound.get(b)!.values()];
          const variants = new Map<string, string[]>();
          for (const v of bs) variants.set(JSON.stringify(v.frames), v.frames);
          const where = [...new Set(bs.map((v) => v.stream))].sort(cmp);
          const fr = [...variants.values()].sort(cmpTuple)[0]!;
          spr =
            `slot ${b}: ${fr.length} frames ${fr.slice(0, 3).join(' ')}${fr.length > 3 ? ' ...' : ''}  [bound in ${where.slice(0, 3).join(',')}${where.length > 3 ? ` +${where.length - 3}` : ''}` +
            `${variants.size > 1 ? `; ${variants.size} DIFFERENT frame sets` : ''}]`;
          sprite.add(variants.size === 1 ? 'resolved' : 'ambiguous');
        } else {
          spr = `slot ${b} (NO BMID binds it anywhere)`;
          sprite.add('never bound');
        }
        rows.push(`  simSlot ${padL(rows.length, 3)}  type ${padR(etypeS, 7)}  object ${padR(obj, 20)}  sprite ${spr}`);
      }
      if (rows.length) out.push(`${s.name} (BWD ${s.rid})  ${rows.length} effects`, ...rows, '');
    }
    out.unshift(
      `MW2 pre-built effects (XPLO chunks) - MW2.PRJ, ${total} chunks`,
      `object: ${objOk} resolve to an OBJ in the same stream, ${objMissing} do not, ${noObj} have none`,
      'sprite (bitmapSlot): ' + sprite.mostCommon().map(([k, v]) => `${k} ${v}`).join(', '),
      'effect types used: ' + typesUsed.sorted().map(([k, v]) => `${k} x${v}`).join(', ') + (clamped ? `; ${clamped} out of range, replaced by 3` : ''),
      'the simSlot number is the order within the stream; in the game it is xploSlotFill, global',
      '',
    );
    expectSameLines('xplo.txt', lines(readListing('xplo.txt')), out);
  });

  it('resource_tables.txt corresponds line for line', () => {
    const CALLER = new Map<number, string>([
      [5, 'MGEO (res_load_mgeo)'],
      [0xb, 'SNDS (ASND chunk, task_object_sound)'],
      [0xc, 'music (MUSI chunk)'],
      [0xd, 'lighting (LTBL chunk)'],
    ]);
    const typeNames = prj.types.map((t) => {
      const m = new Map<number, string>();
      for (const [k, v] of resourceNames(prj, t.tag)) m.set(k, v.toUpperCase());
      return { tag: t.tag, names: m };
    });
    const out: string[] = [];
    let tables = 0;
    let names = 0;
    for (const [rid, tname] of resourceNames(prj, 'TABL')) {
      const c = prj.readResource('TABL', rid) ?? new Uint8Array(0);
      if (c.length < 0xc || cstr(c.subarray(0, 4)) !== 'TABL' || c[3] !== 0x4c) {
        out.push(`TABL ${rid} ${tname}  - not a name index (${c.length} bytes, starts ${pyBytesRepr(c.subarray(0, 4))})`, '');
        continue;
      }
      const count = new DataView(c.buffer, c.byteOffset, c.byteLength).getInt16(8, true);
      const end = 0xc + count * 0xc;
      tables++;
      names += count;
      expect(end <= c.length, `TABL ${rid} is truncated`).toBe(true);
      const pairs = readNameTable(prj, rid).map((e) => [e.id, e.name] as const);
      const serves = typeNames.filter((t) => pairs.length && pairs.every(([i, n]) => t.names.get(i) === n.toUpperCase())).map((t) => t.tag);
      out.push(
        `TABL ${rid} ${tname}  ${count} names  serves ${serves.length ? serves.join('/') : '? (no type matches every name)'}${CALLER.has(rid) ? '  caller: ' + CALLER.get(rid) : ''}  (${c.length - end} unread bytes after the entries)`,
      );
      for (const [i, n] of pairs) out.push(`  ${padL(i, 5)}  ${n}`);
      out.push('');
    }
    out.unshift(`MW2 resource name tables - MW2.PRJ, ${tables} tables, ${names} names`, '');
    expectSameLines('resource_tables.txt', lines(readListing('resource_tables.txt')), out);
  });

  it('STAR and FTBL decode to the shapes their loaders accept', () => {
    // No listing prints these; this checks the decoders against the loaders'
    // own acceptance rules on every chunk in MW2.PRJ.
    let stars = 0;
    let ftbls = 0;
    for (const s of streams)
      for (const c of s.chunks) {
        if (c.tag === 'STAR') {
          stars++;
          const d = decodeStar(c);
          expect((c.size - 8) % 0x18, `${s.name} STAR size`).toBe(0);
          expect(d.groups.length).toBeGreaterThan(0);
          for (const g of d.groups) expect(g.formation.length, `${s.name} STAR formation name`).toBeGreaterThan(0);
        } else if (c.tag === 'FTBL') {
          ftbls++;
          const d = decodeFtbl(c);
          expect(d.slots.length, `${s.name} FTBL ${d.name}`).toBe(5);
          expect(d.name.length).toBeGreaterThan(0);
        }
      }
    expect(stars).toBeGreaterThan(0);
    expect(ftbls).toBeGreaterThan(0);
  });
});
