/**
 * The budget pre-pass. Before a mission is loaded, static_arena_measure calls
 * project_load_by_name, which walks the mission stream and every stream it
 * includes (INCL, GPS), checks each starts with REV and DTBL, and sums the
 * DTBL chunks' counts. arena_budget_build turns the sums into ten
 * {tag, bytes} budgets: the first seven size the static arenas static_malloc
 * serves, the last three size the project id maps (project_maps_alloc, via
 * arena_budget_bytes).
 *
 * DTBL payload, as the walk reads it (all shorts except the last):
 *   +0x08 AGP count (gamepieces: MechEntity+AI blocks and loadouts)
 *   +0x0a  summed into 0x1534ba - no reader found (unestablished)
 *   +0x0c SEG count (scene nodes)
 *   +0x0e OBJI count (project id map entries)
 *   +0x10  summed into 0x1534c0 - no reader found (unestablished)
 *   +0x12  summed into 0x1534c2 - no reader found (unestablished)
 *   +0x14 TLIS count (task nodes, and anim players under ADAT)
 *   +0x16 ANTK count      \ counted once per DISTINCT stream (the seen list);
 *   +0x18 ANFL bytes, int / everything above once per inclusion
 *
 * The sums are shorts that wrap and are never reset by the code: they start
 * zeroed in the image, and a second measurement in the same run would add
 * to the first. The port's registerGlobals reset zeroes them.
 */
import { i16 } from '../../core/int/cint.ts';
import { systemError } from '../../core/systemError.ts';
import type { ProjectItem } from '../../data/bwd/stream.ts';
import { projectNextChunk } from '../../data/bwd/stream.ts';
import { ArenaBudget } from '../../generated/classes.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage } from '../../engine/image.ts';
import { sceneNodeSize } from '../../engine/scene/sceneGraph.ts';
import { missionTablesFree } from '../tables/missionTables.ts';
import { scenarioTableLoad } from '../tables/scenario.ts';
import {
  projectGpspecApply,
  projectItemApply,
  projectItemRelease,
  projectOpenStream,
  projectTraceChunk,
  streamSeenAdd,
  streamSeenClear,
  streamSeenFind,
  streams,
} from './streams.ts';

export const ARENA_BUDGET_COUNT = 10;
/** arenaTag_AGP .. arenaTag_CINS: ten dwords at 0x9e9ec, in arenaBudget order */
export const ARENA_TAG_NAMES = 0x9e9ec;
const ARENA_TAG_TEXT = ['AGP', 'MGP', 'SEG', 'TLIS', 'ADAT', 'ANTK', 'ANFL', 'OBJI', 'CID', 'CINS'];
/** arenaBudget indices */
export const ARENA = { AGP: 0, MGP: 1, SEG: 2, TLIS: 3, ADAT: 4, ANTK: 5, ANFL: 6, OBJI: 7, CID: 8, CINS: 9 } as const;

/** A tag as the little-endian dword the game stores ('AGP\0' -> 0x00504741). @portOnly */
export function tagDword(tag: string): number {
  let v = 0;
  for (let k = 0; k < 4; k++) v |= (k < tag.length ? tag.charCodeAt(k) & 0xff : 0) << (k * 8);
  return v >>> 0;
}

/**
 * The ten arena tags, from the image when one is loaded.
 *
 * @mw2data arenaTag_AGP 0x0009e9ec
 */
export function arenaTags(): number[] {
  const exe = bootImage();
  return ARENA_TAG_TEXT.map((t, i) => (exe ? exe.u32(ARENA_TAG_NAMES + i * 4) : tagDword(t)));
}

/** "1.22l9" at 0x9ebf0, the build string REV is checked against; its first four bytes as a big-endian number. */
const BUILD_STRING = 0x9ebf0;

export const projectWalk = registerGlobals(
  'projectWalk',
  {
    /** 0x1534b8 short */
    dtblCountAGP: 0,
    /** 0x1534ba short: DTBL +0x0a summed; no reader found - unestablished */
    dtblCount1534ba: 0,
    /** 0x1534bc short */
    dtblCountSEG: 0,
    /** 0x1534be short */
    dtblCountOBJI: 0,
    /** 0x1534c0 short: DTBL +0x10 summed; no reader found - unestablished */
    dtblCount1534c0: 0,
    /** 0x1534c2 short: DTBL +0x12 summed; no reader found - unestablished */
    dtblCount1534c2: 0,
    /** 0x1534c4 short */
    dtblCountTLIS: 0,
    /** 0x1534c6 short, once per distinct stream */
    dtblCountANTK: 0,
    /** 0x1534c8 int, once per distinct stream */
    dtblBytesANFL: 0,
    /** 0x153460: ArenaBudget[10], filled by arena_budget_build */
    arenaBudget: Array.from({ length: ARENA_BUDGET_COUNT }, () => new ArenaBudget()),
  },
  () => {
    const w = projectWalk;
    // Only the named sums have labels; all of them are zero in the image.
    w.dtblCountAGP = 0;
    w.dtblCount1534ba = 0;
    w.dtblCountSEG = 0;
    w.dtblCountOBJI = 0;
    w.dtblCount1534c0 = 0;
    w.dtblCount1534c2 = 0;
    w.dtblCountTLIS = 0;
    w.dtblCountANTK = 0;
    w.dtblBytesANFL = 0;
    w.arenaBudget = Array.from({ length: ARENA_BUDGET_COUNT }, () => new ArenaBudget());
  },
);

/** Byte-swapped dword: the value of 4 bytes read big-endian. @portOnly */
const bswap = (v: number): number => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;

/**
 * Walks one stream for the budget: REV first (system_error 0x48, answer 0,
 * when it is not), its version - four bytes compared big-endian, unsigned -
 * not below the build's "1.22" (0x49), then DTBL (0x3e). Adds the DTBL counts
 * (ANTK and ANFL only for a stream not yet on the seen list, which it is then
 * added to), then walks every chunk from DTBL on: STBL is loaded, INCL and
 * GPS recurse into this function. Answers the AND of those handlers.
 *
 * @mw2 project_walk_chunks 0x0004b4a0
 * @fidelity exact
 */
export function projectWalkChunks(item: ProjectItem): number {
  let c = projectNextChunk(item);
  let result = 1;
  if (!c || c.tag !== 'REV') {
    result = 0;
    systemError(0x48);
    return result;
  }
  const build = bootImage()?.u32(BUILD_STRING) ?? tagDword('1.22');
  if (bswap(c.u32(8)) < bswap(build)) {
    systemError(0x49);
    return 0;
  }
  c = projectNextChunk(item);
  if (!c || c.tag !== 'DTBL') {
    systemError(0x3e);
    return 0;
  }
  const self = { id: item.resourceId, name: item.name };
  const seen = streamSeenFind(self);
  if (!seen) streamSeenAdd(self);
  const w = projectWalk;
  w.dtblCountAGP = i16(w.dtblCountAGP + c.i16(0x08));
  w.dtblCount1534ba = i16(w.dtblCount1534ba + c.i16(0x0a));
  w.dtblCountSEG = i16(w.dtblCountSEG + c.i16(0x0c));
  w.dtblCountOBJI = i16(w.dtblCountOBJI + c.i16(0x0e));
  w.dtblCount1534c0 = i16(w.dtblCount1534c0 + c.i16(0x10));
  w.dtblCount1534c2 = i16(w.dtblCount1534c2 + c.i16(0x12));
  w.dtblCountTLIS = i16(w.dtblCountTLIS + c.i16(0x14));
  if (!seen) {
    w.dtblCountANTK = i16(w.dtblCountANTK + c.i16(0x16));
    w.dtblBytesANFL = (w.dtblBytesANFL + c.i32(0x18)) | 0;
  }
  while (c) {
    if (streams.projectTraceEnabled !== 0) projectTraceChunk(c.tag);
    if (c.tag === 'STBL') result = (result & scenarioTableLoad(c)) >>> 0;
    else if (c.tag === 'INCL') result = (result & projectItemApply(c, projectWalkChunks)) >>> 0;
    else if (c.tag === 'GPS') result = (result & projectGpspecApply(c, projectWalkChunks)) >>> 0;
    c = projectNextChunk(item);
  }
  return result;
}

/**
 * Fills arenaBudget from the DTBL sums - each entry an arena tag and a count
 * times that arena's item size - and returns it:
 *   AGP  AGP * 0x1ec     MGP  AGP * mech_loadout_size (0x852)
 *   SEG  SEG * scene_node_size (0x7c)
 *   TLIS TLIS * task_node_size (0x18)   ADAT TLIS * 0x28
 *   ANTK ANTK * 0x14     ANFL the ANFL bytes
 *   OBJI OBJI * 8        CID, CINS  OBJI * 4 each
 *
 * @mw2 arena_budget_build 0x0004b690
 * @fidelity exact
 * @divergence mech_loadout_size (0x287b0) and task_node_size (0x17520) are not ported in their own modules yet; their constant answers, 0x852 and 0x18, are used here
 */
export function arenaBudgetBuild(): ArenaBudget[] {
  const w = projectWalk;
  const b = w.arenaBudget;
  const tags = arenaTags();
  const MECH_LOADOUT_SIZE = 0x852; // mech_loadout_size()
  const TASK_NODE_SIZE = 0x18; // task_node_size()
  b[0]!.bytes = Math.imul(w.dtblCountAGP, 0x1ec);
  b[1]!.bytes = Math.imul(w.dtblCountAGP, MECH_LOADOUT_SIZE);
  b[2]!.bytes = Math.imul(w.dtblCountSEG, sceneNodeSize());
  b[3]!.bytes = Math.imul(w.dtblCountTLIS, TASK_NODE_SIZE);
  b[4]!.bytes = Math.imul(w.dtblCountTLIS, 0x28);
  b[5]!.bytes = Math.imul(w.dtblCountANTK, 0x14);
  b[6]!.bytes = w.dtblBytesANFL | 0;
  b[7]!.bytes = Math.imul(w.dtblCountOBJI, 8);
  b[8]!.bytes = Math.imul(w.dtblCountOBJI, 4);
  b[9]!.bytes = b[8]!.bytes;
  for (let i = 0; i < ARENA_BUDGET_COUNT; i++) b[i]!.tag = tags[i]!;
  return b;
}

/**
 * arenaBudget[index].bytes, or 0 outside 0..9. project_maps_alloc asks for
 * 7, 8 and 9 (OBJI, CID, CINS).
 *
 * @mw2 arena_budget_bytes 0x0004b3f0
 * @fidelity exact
 */
export function arenaBudgetBytes(index: number): number {
  return index > -1 && index < ARENA_BUDGET_COUNT ? projectWalk.arenaBudget[index]!.bytes : 0;
}

/** Watcom isdigit through the ctype table at 0x952c8 (bit 0x20): ASCII '0'..'9'. @portOnly clib */
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** clib_sub_0628fa, Watcom atoi: skip ctype spaces, a sign, then digits. @portOnly clib */
function clibAtoi(s: string): number {
  let i = 0;
  const sp = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  while (i < s.length && sp(s.charCodeAt(i))) i++;
  const sign = s[i];
  if (sign === '+' || sign === '-') i++;
  let v = 0;
  while (i < s.length && isDigit(s.charCodeAt(i))) v = (Math.imul(v, 10) + (s.charCodeAt(i++) - 0x30)) | 0;
  return sign === '-' ? -v | 0 : v;
}

/**
 * Measures a mission: its name (at most 12 characters) is a resource id when
 * it starts with a digit, else a name for TABL 14. Opens it, walks it with
 * project_walk_chunks and, if the walk succeeded, builds the arena budget.
 * Then releases the stream, empties the seen list and frees the mission
 * tables. Returns the budget table, or null.
 *
 * @mw2 project_load_by_name 0x0004b410
 * @fidelity exact
 */
export function projectLoadByName(name: string): ArenaBudget[] | null {
  const short = name.slice(0, 12); // strncpy 12, NUL at [12]
  let result: ArenaBudget[] | null = null;
  const id = isDigit(name.charCodeAt(0)) ? i16(clibAtoi(name)) : -1;
  const item = projectOpenStream({ id, name: short });
  if (item) {
    if (projectWalkChunks(item) !== 0) result = arenaBudgetBuild();
    projectItemRelease(item);
    streamSeenClear();
    missionTablesFree();
  }
  return result;
}

