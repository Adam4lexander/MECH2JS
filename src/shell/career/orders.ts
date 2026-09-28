/**
 * The briefing and debriefing text (decompiled/mw2shell/src/handoff/
 * mission_prep.c): a BWD stream's ORDR chunk, its \H \Q \R codes filled
 * in, laid out as pages. And the project handle the shell reads its BWD
 * streams through: main's project (0x91190), {project file, TABL table
 * (0xe), the last stream opened, its length}. README "Briefing and
 * debriefing text: the ORDR chunk".
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { resourceIdByName } from '../../data/prj/ProjectFile.ts';
import { dosFileWrite } from '../../engine/dosFiles.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { divergence, unestablished } from '../../core/provenance.ts';
import { mem } from '../memory.ts';
import { driver } from '../state.ts';
import { shellProject } from '../project.ts';
import type { FontHolder } from '../ui/labels.ts';
import { remapAt } from '../ui/labels.ts';
import { Page, pageInit, textLayoutPage } from '../text/page.ts';
import { strDupNonempty, collectionAppend } from '../util/collection.ts';
import { currentPilot, pilotField, rankTitle } from './missions.ts';

/** The project handle: main's `project` at 0x91190, 16 bytes. */
export const projectHandle = registerGlobals(
  'projectHandle',
  {
    /** +0: the project file's handle (-1: not open) */
    handle: -1,
    /** +4: the TABL table streams are named in (0xe) */
    table: 0,
    /** +8: the stream bwd_stream_open last loaded (the cache's data) */
    data: null as Uint8Array | null,
    /** +0xc: its length, from the BWD header's +4 */
    length: 0,
  },
  () => {
    projectHandle.handle = -1;
    projectHandle.table = 0;
    projectHandle.data = null;
    projectHandle.length = 0;
  },
  'mw2shell',
);

/**
 * (project, 'MW2.PRJ'): table 0xe, no stream yet; the allocation hooks and
 * the resource cache set up, the file opened and its directories loaded.
 *
 * @mw2shell project_open 0x0001ceb0
 * @fidelity partial
 * @divergence MW2.PRJ is the host's (shellProject.prj, set by startShellProcess); the port's resource cache needs no hooks, hash or directory load
 */
export function projectOpen(_name: string): void {
  divergence('MW2.PRJ is opened by the host (shellProject.prj), not by project_open', 'project_open');
  projectHandle.table = 0xe;
  projectHandle.data = null;
  projectHandle.handle = shellProject.prj ? 0 : -1;
}

/**
 * (project, name, table): the name's id in TABL `table`, or -1 when the
 * project is not open.
 *
 * @mw2shell project_tabl_lookup 0x0001cf00
 * @fidelity exact
 */
export function projectTablLookup(name: string, table: number): number {
  if (projectHandle.handle < 0 || !shellProject.prj) return -1;
  return resourceIdByName(shellProject.prj, table, name);
}

/**
 * The release that matches project_stream_load: the same lookup, then the
 * cache frees the item.
 *
 * @mw2shell project_stream_release 0x0001cfa0
 * @fidelity partial
 * @divergence the port's resources are copies with nothing to release
 */
export function projectStreamRelease(_name: string, _table: number): void {}

/**
 * Loads a BWD stream by name (TABL project.table) as the project's current
 * stream: its data, and its length from the header's +4 (0 first, and left
 * 0 when the name is not found - the data pointer then keeps the previous
 * stream). True when data loaded.
 *
 * @mw2shell bwd_stream_open 0x0001d020
 * @fidelity exact
 * @divergence the port's MW2.PRJ reader stands in for the shell's resource cache
 */
export function bwdStreamOpen(name: string): boolean {
  projectHandle.length = 0;
  const prj = shellProject.prj;
  if (projectHandle.handle < 0 || !prj) return false;
  const id = resourceIdByName(prj, projectHandle.table, name);
  if (id === -1 || id === -2) return false;
  // 0x73424 'BWD'
  const data = prj.readResource('BWD', id);
  projectHandle.data = data;
  if (!data) {
    unestablished('bwd_stream_open: the cache returned no data (the original reads its +4 anyway)', 'bwd_stream_open');
    return false;
  }
  projectHandle.length = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(4, true);
  return true;
}

/**
 * The first chunk of the current stream, from +0xc, whose tag is `tag`;
 * its offset in the stream, or -1. Chunks are {tag, size including the
 * 8-byte head, payload}.
 *
 * @mw2shell bwd_find_chunk 0x0001d080
 * @fidelity exact
 */
export function bwdFindChunk(tag: number): number {
  const s = projectHandle.data;
  let at = 0xc;
  if (!s || projectHandle.length <= 0xc) return -1;
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  do {
    if (at + 8 > s.length) return -1;
    if (dv.getInt32(at, true) === tag) return at;
    const size = dv.getInt32(at + 4, true);
    // the original steps on regardless: a 0 size would loop for ever
    if (size === 0) return -1;
    at += size;
  } while (at < projectHandle.length);
  return -1;
}

/**
 * Frees the resource cache and closes the project file.
 *
 * @mw2shell project_close 0x0001d0c0
 * @fidelity partial
 * @divergence the host owns MW2.PRJ; only the handle is closed
 */
export function projectClose(): void {
  projectHandle.data = null;
  projectHandle.length = 0;
  projectHandle.handle = -1;
}

/**
 * (pages, x, y, width, height, stream, font, q): the text of the stream's
 * ORDR chunk (briefingTags[0]) as pages appended to `pages`. The chunk's
 * last byte is forced to a NUL. With q not NULL the raw text is written to
 * tmp.out and the codes are filled in: \H / \h the pilot's careerHonor
 * ('%d'), \Q / \q `q`, \R0 \R1 \R2 (either case) rankTitles[rank], [rank +
 * 1], [rank + 2] - the last two clamped to 9, which is past the nine titles
 * - and any other \x kept. Every page is a page_init box (x, y, width,
 * height) in `font`, coloured through ordersTextRemap - [0] 0xff, [1] 1,
 * the rest 0xff: only ink 1 draws.
 *
 * @mw2shell orders_text_build 0x0001caa0
 * @fidelity exact
 * @divergence the NUL is forced into the port's copy of the stream, not the cached resource (the same byte each time, so nothing reads the difference)
 */
export function ordersTextBuild(pages: Page[], x: number, y: number, width: number, height: number, stream: string, font: FontHolder, q: string | null): void {
  const m = mem();
  const remap = remapAt(SHELL_LABEL.ordersTextRemap);
  remap[0] = 0xff;
  remap[1] = 1;
  for (let i = 2; i < 0x100; i++) remap[i] = 0xff;
  bwdStreamOpen(stream);
  const chunk = bwdFindChunk(m.i32(SHELL_LABEL.briefingTags));
  if (chunk < 0) return;
  const s = projectHandle.data!;
  const size = new DataView(s.buffer, s.byteOffset, s.byteLength).getInt32(chunk + 4, true);
  const body = s.slice(chunk + 8, chunk + 8 + size - 8);
  body[size - 9] = 0;
  const nul = body.indexOf(0);
  const raw = body.subarray(0, nul < 0 ? body.length : nul);
  let text: string | null = String.fromCharCode(...raw);
  if (q !== null) {
    const pilot = currentPilot();
    const field = (f: 'rank' | 'careerHonor'): number => {
      if (pilot === 0) {
        unestablished('orders_text_build: \\H or \\R with no current pilot (the original reads through NULL)', 'orders_text_build');
        return 0;
      }
      return pilotField(pilot, f);
    };
    // 0x886e4: the text with its codes filled in
    let out = '';
    const at = (i: number) => (i < text!.length ? text!.charCodeAt(i) : 0);
    let i = 0;
    while (i < text.length) {
      let next = i + 1;
      if (at(i) === 0x5c) {
        const b = at(i + 1);
        if (b === 0x48 || b === 0x68) {
          // H h: 0x73414 '%d'
          out += String(field('careerHonor'));
          next = i + 2;
        } else if (b === 0x51 || b === 0x71) {
          out += q;
          next = i + 2;
        } else if (b === 0x52 || b === 0x72) {
          next = i + 2;
          const d = at(i + 2);
          if (d === 0x30) {
            out += rankTitle(field('rank'));
            next = i + 3;
          } else if (d === 0x31) {
            out += rankTitle(Math.min(field('rank') + 1, 9));
            next = i + 3;
          } else if (d === 0x32) {
            out += rankTitle(Math.min(field('rank') + 2, 9));
            next = i + 3;
          }
        } else {
          out += '\\' + String.fromCharCode(b);
          next = i + 2;
        }
      } else out += text[i];
      i = next;
    }
    // 0x7341a 'tmp.out', 0x73417 'wb': the raw text, strlen bytes
    dosFileWrite('tmp.out', raw);
    text = strDupNonempty(out);
    if (text === null) {
      unestablished('orders_text_build: an empty text after the codes - text_layout_page is handed NULL', 'orders_text_build');
      text = '';
    }
  }
  let rest: string | null = text;
  do {
    const page = pageInit(new Page(), font, driver(), remap, x, y, width, height);
    rest = textLayoutPage(page, rest);
    collectionAppend(pages, page);
  } while (rest !== null);
}
