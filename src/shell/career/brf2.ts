/**
 * A mission's BRF2 stream (<first 4 letters>brf2 in MW2.PRJ's BWD table): the
 * briefing chunks MW2.EXE never reads - SUPS (the launch animation stem),
 * SDSC (a star: Keshik limits and its 'Mechs, the player's first and the
 * opponent's second) and PDSC (the planet and three lines about it).
 * decompiled/mw2shell/src/career/pilots.c and handoff/mission_prep.c; the
 * chunk layouts are in decompiled/mw2shell/README.md, "The per-mission BRF2
 * stream".
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { resourceIdByName } from '../../data/prj/ProjectFile.ts';
import { mem } from '../memory.ts';
import { project } from '../project.ts';
import { starConfigure, starSetMember } from '../handoff/stars.ts';

/**
 * A stream by name through TABL `table`, as its resource bytes; null for a
 * name the table does not have.
 *
 * @mw2shell project_stream_load 0x0001cf40
 * @fidelity exact
 * @divergence the resource comes from the port's MW2.PRJ reader, not the shell's cache (project_stream_release has nothing to free)
 */
export function projectStreamLoad(name: string, table: number, type: string): Uint8Array | null {
  const prj = project();
  const id = resourceIdByName(prj, table, name);
  if (id === -1 || id === -2) return null;
  return prj.readResource(type, id);
}

/**
 * The first chunk after `after` (or from the stream's first, at +0xc) whose
 * tag is chunkTags[letter] - 'E' PDSC, 'F' SDSC, 'G' SUPS; its offset in the
 * stream, or -1. Chunks are stepped by their size at +4 rounded toward zero
 * to a multiple of 4.
 *
 * @mw2shell brf2_find_chunk 0x0001cfd0
 * @fidelity exact
 */
export function brf2FindChunk(stream: Uint8Array, letter: string, after = -1): number {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const m = mem();
  const tag = m.i32(SHELL_LABEL.chunkTags + letter.charCodeAt(0) * 4);
  const end = dv.getInt32(4, true);
  let p = after < 0 ? 0xc : after + dv.getInt32(after + 4, true);
  while (p < end) {
    if (p + 8 > stream.length) return -1;
    if (dv.getInt32(p, true) === tag) return p;
    const size = dv.getInt32(p + 4, true);
    const step = size < 0 ? -Math.floor(-size / 4) : Math.floor(size / 4);
    if (step === 0) return -1; // the original loops forever on a zero-sized chunk
    p += step * 4;
  }
  return -1;
}

/** @portOnly a SDSC chunk's fields: +8 skill (the opponent's), +0xc max tonnage, +0x10 member count, +0x14 max 'Mechs, 16-byte MEK names from +0x18. */
export function brf2Sdsc(stream: Uint8Array, at: number) {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const names: string[] = [];
  const maxMechs = dv.getInt32(at + 0x14, true);
  for (let i = 0; i < maxMechs; i++) {
    let s = '';
    for (let k = 0; k < 16; k++) {
      const c = stream[at + 0x18 + i * 0x10 + k]!;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    names.push(s);
  }
  return { skill: dv.getInt32(at + 8, true), maxTonnage: dv.getInt32(at + 0xc, true), memberCount: dv.getInt32(at + 0x10, true), maxMechs, names };
}

/** What mission_brf2_load's planet branch shows, for the screen that asked for it. */
export interface Brf2Planet {
  /** briefingPlanet: 0..11 (PDSC's 1..12, else 0) */
  planet: number;
  /** PDSC's text from +0xc: up to three lines, each ended by a byte below 0x20 */
  lines: string[];
}

/**
 * Loads <first 4 letters of name>brf2: SUPS's string into launchAnimName;
 * with loadStars, the first SDSC configures the player's star and the second
 * the opponent's (and sets opponentStarSkill); then the player's star is
 * current with member 0 selected. With showPlanet, PDSC's planet and text
 * are returned for the caller's screen (the original starts the aplanNN
 * animation and three labels here).
 *
 * @mw2shell mission_brf2_load 0x000291b0
 * @fidelity partial
 * @divergence the planet branch's animation and labels are drawn by the calling screen from the returned Brf2Planet
 */
export function missionBrf2Load(name: string, loadStars: boolean, showPlanet: boolean): Brf2Planet | null {
  const m = mem();
  const streamName = name.slice(0, 4) + m.cstr(SHELL_LABEL.brf2Suffix);
  const stream = projectStreamLoad(streamName, 0xe, 'BWD');
  if (!stream) return null;
  const sups = brf2FindChunk(stream, 'G');
  if (sups >= 0) {
    let s = '';
    for (let i = sups + 8; i < stream.length && stream[i] !== 0; i++) s += String.fromCharCode(stream[i]!);
    m.strcpy(SHELL_LABEL.launchAnimName, s);
  }
  if (loadStars) {
    const first = brf2FindChunk(stream, 'F');
    if (first >= 0) {
      const s = brf2Sdsc(stream, first);
      starConfigure(0, 0, s.maxMechs, s.memberCount, s.maxTonnage);
      s.names.forEach((n, i) => starSetMember(i, n, null));
      starConfigure(0, 0, s.maxMechs, s.memberCount, s.maxTonnage);
    }
    const second = first >= 0 ? brf2FindChunk(stream, 'F', first) : brf2FindChunk(stream, 'F');
    if (second >= 0) {
      const s = brf2Sdsc(stream, second);
      starConfigure(1, 0, s.maxMechs, s.memberCount, s.maxTonnage);
      s.names.forEach((n, i) => starSetMember(i, n, null));
      starConfigure(1, 0, s.maxMechs, s.memberCount, s.maxTonnage);
      m.setI32(SHELL_LABEL.opponentStarSkill, s.skill);
    }
  }
  starConfigure(0, -1, -1, -1, -1);
  starSetMember(0, null, null);
  if (!showPlanet) return null;
  const pdsc = brf2FindChunk(stream, 'E');
  if (pdsc < 0) return null;
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let planet = dv.getInt32(pdsc + 8, true) - 1;
  if (planet < 0 || planet > 0xb) planet = 0;
  m.setI32(SHELL_LABEL.briefingPlanet, planet);
  const size = dv.getInt32(pdsc + 4, true);
  const lines: string[] = [];
  let k = 0;
  for (let line = 0; line < 3; line++) {
    let s = '';
    while (k < size - 0xc && stream[pdsc + 0xc + k]! > 0x1f) s += String.fromCharCode(stream[pdsc + 0xc + k++]!);
    k++;
    lines.push(s);
  }
  return { planet, lines };
}
