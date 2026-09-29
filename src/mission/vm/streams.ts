/**
 * Opening mission streams: the {id, name} references INCL, GPS and the
 * loaders carry are turned into ProjectItems (src/data/bwd/stream.ts) that
 * project_next_chunk walks.
 *
 * A reference resolves in three ways (project_open_stream):
 *   id >= 0    the BWD resource of that id in MW2.PRJ
 *   id == -1   the name, looked up in TABL 14 (the BWD name table); a name
 *              that is not there falls through to a loose file
 *   id == -2   a loose file beside MW2.EXE: the name, with ".BWD" appended
 *              when it has no '.', joined to the directory prefix at
 *              0x9ea24 by screenshot_sub_04c4b0 (ported with the MEK
 *              loaders in src/sim/mech/looseFiles.ts) and read whole
 * With looseFilesFirst (-P) every reference tries the loose file first and
 * falls back to the resource quietly.
 *
 * LOOSE FILES IN THE PORT. The original reads them with a blocking DOS
 * open/read inside the interpreter. The port's FileSource is async, so the
 * loose files a mission needs are read BEFORE the load into an in-memory map
 * (setLooseFiles, keyed by the upper-cased file name, e.g. 'USERSTAR.BWD')
 * and project_open_stream reads that map synchronously; the mission load
 * fills it from the port's disk (mission/load.ts). SHIPPED_LOOSE_STREAMS are
 * the names MW2.PRJ's id -2 INCLs use (test/golden/missionStreams.test.ts
 * checks the list against the data). A file missing from the map is a missing file, as
 * res_load_file failing would be.
 *
 * The seen-stream list ("file ID list", SYSERR_CANTMALLOCFILEIDLIST) lives
 * here too: project_walk_chunks uses it to count the ANTK and ANFL budgets
 * once per distinct stream.
 */
import { divergence, quirk } from '../../core/provenance.ts';
import { log } from '../../core/log.ts';
import { i16 } from '../../core/int/cint.ts';
import { systemError } from '../../core/systemError.ts';
import { type Chunk, ProjectItem, projectItemFromStream, type StreamRef } from '../../data/bwd/stream.ts';
import { readProjectTags, type ProjectTag } from '../../data/exe/tables/projectTags.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage, imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheRelease, idByName } from '../../engine/resources/cache.ts';
import { screenshotSub04c4b0 } from '../../sim/mech/looseFiles.ts';
import { scenario } from '../tables/scenario.ts';

/** The callback project_item_apply / project_gpspec_apply run an opened stream through; returns the C's 0/1. */
export type StreamHandler = (item: ProjectItem) => number;

/** One record of the seen-stream list: the short id and at most 8 name characters (record +4, +6). */
export interface StreamSeenRecord {
  id: number;
  name: string;
}

export const streams = registerGlobals(
  'streams',
  {
    /** 0x9ea1c: the -P option - every reference tries a loose file first, and a missing one is not an error */
    looseFilesFirst: 0,
    /** 0x9ea20: the -E option - project_open_stream and project_walk_chunks trace to mw2debug.txt */
    projectTraceEnabled: 0,
    /** streamSeenHead (0x9eb28) .. streamSeenTail (0x1535f0), as a list */
    streamSeen: [] as StreamSeenRecord[],
    /** @portOnly the pre-loaded loose files, keyed by upper-cased path */
    looseFiles: new Map<string, Uint8Array>(),
  },
  () => {
    streams.looseFilesFirst = imageI32(LABEL.looseFilesFirst, 0);
    streams.projectTraceEnabled = imageI32(LABEL.projectTraceEnabled, 0);
    streams.streamSeen = [];
    // The loose-file map is input, not game state: a reset keeps it.
  },
);

// ------------------------------------------------------------ loose files

/**
 * Installs the loose files project_open_stream can read, keyed by the
 * upper-cased file name ('USERSTAR.BWD'). Replaces any earlier map.
 *
 * @portOnly the synchronous stand-in for the DOS file system (see the module note)
 */
export function setLooseFiles(files: Map<string, Uint8Array>): void {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of files) m.set(k.toUpperCase(), v);
  streams.looseFiles = m;
}

/**
 * The loose BWD streams MW2.PRJ includes by id -2: USERSTAR and EN01STAR ..
 * EN05STAR (the player's and the enemy stars, per MissionObjectiveRecord's
 * note in mw2_types.h) and INSTMAP1 (purpose not established). Checked
 * against every INCL in MW2.PRJ by the golden test.
 */
export const SHIPPED_LOOSE_STREAMS = ['USERSTAR.BWD', 'EN01STAR.BWD', 'EN02STAR.BWD', 'EN03STAR.BWD', 'EN04STAR.BWD', 'EN05STAR.BWD', 'INSTMAP1.BWD'];

/**
 * A loose file's bytes from the pre-loaded map, or null - res_load_file
 * (0x4c170) as project_open_stream uses it. The ported res_load_file
 * (resLoadFile, src/sim/mech/looseFiles.ts) reads the MEK loaders' own source
 * (setMekSource); streams keep the map setLooseFiles installs. On failure the
 * original appends "Couldn't load ID=%s" to symlog.txt; the port logs it. A
 * fresh copy is returned, as the original reads the file into a fresh
 * allocation.
 *
 * @portOnly res_load_file over the stream loose-file map
 */
function looseFileRead(path: string): Uint8Array | null {
  divergence('loose files are read from a map pre-loaded before the load (setLooseFiles), not from disk', 'project_open_stream');
  const b = streams.looseFiles.get(path.toUpperCase());
  if (!b) {
    log('symlog', `Couldn't load ID=${path}`);
    return null;
  }
  return b.slice();
}

// ------------------------------------------------------------ tracing

/**
 * Appends a line to mw2debug.txt and shows it on the debug overlay.
 *
 * @mw2 debug_log 0x0004bb00
 * @fidelity partial
 * @divergence goes to the log sink (channel 'mw2debug') instead of the file and hud_debug_sub_0499c0's overlay
 */
export function debugLog(text: string): void {
  log('mw2debug', text);
}

let tagTable: ProjectTag[] | null = null;

/**
 * Traces one chunk of a project_walk_chunks walk as "<keyword>, ".
 *
 * @mw2 project_trace_chunk 0x0004bb40
 * @fidelity exact
 */
export function projectTraceChunk(tag: string): void {
  const exe = bootImage();
  if (!tagTable && exe) tagTable = readProjectTags(exe);
  // project_tag_to_keyword answers "unknown" (0x937a4) for a tag not in the table.
  const kw = tagTable ? (tagTable.find((t) => t.tag === tag)?.keyword ?? 'unknown') : tag;
  debugLog(`${kw}, `);
}

// ------------------------------------------------------------ open / release

/**
 * Opens the stream a {id, name} reference names. id -1 is resolved through
 * TABL 14; a loose file is tried for -1 or -2 (the name still unresolved) or
 * when looseFilesFirst is set; otherwise, or when the loose file is missing,
 * the BWD resource is loaded from the main project. The stream must start
 * with its BWD chunk. Returns the ready item or null.
 *
 * THE LOOSE BRANCH WRITES ".BWD" INTO THE CALLER'S REFERENCE when the name
 * has no '.', and every later message and the path use the extended name.
 * The port writes it into `ref.name`. Every caller in the game passes a
 * local copy (a 12-character buffer plus its NUL), so nothing persists; in
 * project_item_apply's frame a name of 10 or more characters would carry the
 * extension over the saved callback pointer. The shipped names are 8.
 *
 * @mw2 project_open_stream 0x0004b7d0
 * @fidelity exact
 * @divergence the item is allocated here instead of being the caller's 28-byte local; the 0x2b message names the item (projectItemFromStream) rather than the reference
 */
export function projectOpenStream(ref: StreamRef): ProjectItem | null {
  const item = new ProjectItem();
  let buffer: Uint8Array | null = null;
  let id = i16(ref.id);
  item.name = ref.name.slice(0, 8); // strncpy 8, NUL forced at +0xb
  if (streams.projectTraceEnabled !== 0) {
    // "\n%s: " (0x93778) with the name, or "\nPrj file ID# %d: " (0x93780) when it is empty
    debugLog(ref.name !== '' ? `\n${ref.name}: ` : `\nPrj file ID# ${i16(ref.id)}: `);
  }
  if (id === -1) {
    id = idByName(0xe, ref.name);
    if (id === -1) systemError(0x3d, `${ref.name} ID ${i16(ref.id)}`);
  }
  if (id === -2 || id === -1 || streams.looseFilesFirst !== 0) {
    item.cached = 0;
    item.resourceId = -1;
    if (!ref.name.includes('.')) {
      // strcat(name, ".") then strcat(name, "BWD") (0x937a0, 0x9ed14)
      quirk("'.BWD' is appended in the caller's own reference buffer", 'project_open_stream');
      ref.name = ref.name + '.' + 'BWD';
    }
    buffer = looseFileRead(screenshotSub04c4b0(ref.name));
    if (!buffer && streams.looseFilesFirst === 0) systemError(0x29, `${ref.name} ID ${i16(ref.id)}`);
  }
  if (!buffer && id !== -1) {
    item.cached = 1;
    item.resourceId = i16(id);
    buffer = cacheLoadResource(id, 'BWD');
    if (!buffer) systemError(0x2a, `${ref.name} ID ${i16(ref.id)}`);
  }
  if (!buffer) return null;
  return projectItemFromStream(buffer, item);
}

/**
 * Releases what an opened item holds: a loose file's buffer (cached 0) or
 * the cached BWD resource. Null is ignored.
 *
 * @mw2 project_item_release 0x0004baa0
 * @fidelity exact
 */
export function projectItemRelease(item: ProjectItem | null): void {
  if (!item) return;
  if (item.cached === 0) return; // free(item->base): the port's buffer is garbage-collected
  cacheRelease(item.resourceId, 'BWD');
}

// ------------------------------------------------------------ includes

/**
 * INCL: opens the stream the chunk names (id at +8, a 12-character name at
 * +0xa), runs `handler` over it and releases it; returns the handler's
 * answer masked to bit 0. A by-name reference (-1/-2) whose name starts with
 * '^' takes the next name of the scenario table instead (system_error 0x39
 * with no table, 0x3b when it is used up, and nothing is opened). A failed
 * open is system_error 0x34 and answers 0.
 *
 * @mw2 project_item_apply 0x0004db00
 * @fidelity exact
 */
export function projectItemApply(c: Chunk, handler: StreamHandler): number {
  const ref: StreamRef = { id: c.i16(8), name: c.str(0xa, 12) };
  let ok = true;
  let result = 0;
  if ((ref.id === -2 || ref.id === -1) && ref.name.charCodeAt(0) === 0x5e) {
    const s = scenario;
    if (s.scenarioTable === null) {
      systemError(0x39);
      ok = false;
    } else if (s.scenarioTableIndex < s.scenarioTableCount) {
      ref.name = scenarioName(s.scenarioTable, s.scenarioTableIndex);
      s.scenarioTableIndex = (s.scenarioTableIndex + 1) | 0;
    } else {
      systemError(0x3b);
      ok = false;
    }
  }
  if (ok) {
    const item = projectOpenStream(ref);
    if (!item) systemError(0x34);
    else {
      result = handler(item) & 1;
      projectItemRelease(item);
    }
  }
  return result;
}

/** strncpy of 12 bytes from scenarioTable + 8 + index * 0xc, NUL at [12]. @portOnly */
function scenarioName(table: Uint8Array, index: number): string {
  const o = 8 + index * 0xc;
  let s = '';
  for (let k = 0; k < 12 && o + k < table.length; k++) {
    const b = table[o + k]!;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/**
 * GPS: opens the stream the chunk names (id at +0xa, a 12-character name at
 * +0x24) and runs `handler` over it, returning its answer unmasked. No '^'
 * substitution. A failed open is system_error 0x35 and answers 0.
 *
 * @mw2 project_gpspec_apply 0x0004dcf0
 * @fidelity exact
 */
export function projectGpspecApply(c: Chunk, handler: StreamHandler): number {
  const ref: StreamRef = { id: c.i16(0xa), name: c.str(0x24, 12) };
  let result = 0;
  const item = projectOpenStream(ref);
  if (!item) systemError(0x35);
  else {
    result = handler(item);
    projectItemRelease(item);
  }
  return result;
}

// ------------------------------------------------------------ seen-stream list

/**
 * Appends {id, first 8 name characters} to the seen list; returns 1. (The
 * original's allocation can fail - system_error 0x42 and 0 - which the
 * port's cannot.)
 *
 * @mw2 stream_seen_add 0x0004c5d0
 * @fidelity exact
 */
export function streamSeenAdd(ref: StreamRef): number {
  streams.streamSeen.push({ id: i16(ref.id), name: ref.name.slice(0, 8) });
  return 1;
}

/**
 * The first record matching `ref`, or null. A record stored with id -1 or -2
 * matches on the name, case-sensitively (Watcom strcmp); any other record on
 * the id alone.
 *
 * @mw2 stream_seen_find 0x0004c650
 * @fidelity exact
 */
export function streamSeenFind(ref: StreamRef): StreamSeenRecord | null {
  for (const r of streams.streamSeen) {
    const hit = r.id === -2 || r.id === -1 ? r.name === ref.name : r.id === i16(ref.id);
    if (hit) return r;
  }
  return null;
}

/**
 * Empties the seen list.
 *
 * @mw2 stream_seen_clear 0x0004c6a0
 * @fidelity exact
 */
export function streamSeenClear(): void {
  streams.streamSeen = [];
}

// ------------------------------------------------------------ chunk values

/**
 * A chunk's dwords at +8 and +0xc, the two outputs GNDM, SKYM and HRZM take.
 *
 * @mw2 project_chunk_read_values 0x0004d7a0
 * @fidelity partial
 * @divergence the optional third output (the (size - 0x10) / 4 dwords from +0x10) is not offered: all three callers pass null for it, so the copy never runs in this build
 */
export function projectChunkReadValues(c: Chunk): [number, number] {
  return [c.i32(8), c.i32(0xc)];
}

