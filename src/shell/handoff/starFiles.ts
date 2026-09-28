/**
 * The star files MW2.EXE reads through INCL -2: userstar.bwd (the player's
 * star), en01star.bwd .. en05star.bwd (the opponents), and instmap1.bwd (the
 * Trial of Grievance insignia). MW2SHELL.EXE's star_files module
 * (decompiled/mw2shell/src/handoff/star_files.c); the layouts are in
 * decompiled/mw2shell/README.md, "Star files" and "instmap1.bwd".
 *
 * Each file is built in bwdBuffer (0x800 bytes) and written whole. MW2 needs
 * both header dwords: project_next_chunk stops at streamLength and rejects
 * any chunk larger than maxChunkSize.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { resourceIdByName } from '../../data/prj/ProjectFile.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { project, strnicmp } from '../project.ts';

const BUF = SHELL_LABEL.bwdBuffer;
const LIMIT = structSize('BwdBuffer');

/** Appends `bytes` at bwdLength if they fit the 0x800-byte buffer, raising the largest-chunk size. */
function bwdAppend(bytes: Uint8Array): void {
  const m = mem();
  const len = m.i32(SHELL_LABEL.bwdLength);
  if (len + bytes.length > LIMIT) return;
  m.view(BUF + len, bytes.length).set(bytes);
  m.setI32(SHELL_LABEL.bwdLength, len + bytes.length);
  if (m.i32(SHELL_LABEL.bwdMaxChunk) < bytes.length) {
    m.setI32(SHELL_LABEL.bwdMaxChunk, bytes.length);
    m.setI32(BUF + fieldOffset('BwdBuffer', 'maxChunkSize'), bytes.length);
  }
}

/** A chunk {tag, size, ...body} of exactly `size` bytes, zero-padded. */
function chunk(tag: string, size: number, body: (dv: DataView, b: Uint8Array) => void = () => {}): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < 4 && i < tag.length; i++) b[i] = tag.charCodeAt(i);
  const dv = new DataView(b.buffer);
  dv.setInt32(4, size, true);
  body(dv, b);
  return b;
}

/** chunkTags indices: the shell keeps its BWD chunk tags packed 4 bytes apart in its data. */
const TAG = { BWD: 0, REV: 1, DTBL: 2, BMPJ: 14, BMID: 15, GPS: 52 } as const;

/** A chunk tag's four bytes from the image. */
function tagAt(index: number): string {
  const m = mem();
  const a = SHELL_LABEL.chunkTags + index * 4;
  return String.fromCharCode(m.u8(a), m.u8(a + 1), m.u8(a + 2), m.u8(a + 3));
}

/**
 * Clears the BWD build buffer and appends the three chunks every star file
 * starts with: {'BWD', 0, 0} (its dwords become streamLength and
 * maxChunkSize), {'REV', 0xc, "1.22"} and {'DTBL', 0x1c, zeros}.
 *
 * @mw2shell bwd_build_begin 0x0001d140
 * @fidelity exact
 */
export function bwdBuildBegin(): void {
  const m = mem();
  m.fill(BUF, 0, LIMIT);
  m.setI32(SHELL_LABEL.bwdLength, 0);
  m.setI32(SHELL_LABEL.bwdMaxChunk, 0);
  // the header's size dword is 0 when appended; streamLength is set by the writer
  const header = chunk(tagAt(TAG.BWD), 0xc);
  new DataView(header.buffer).setInt32(4, 0, true);
  bwdAppend(header);
  bwdAppend(
    chunk(tagAt(TAG.REV), 0xc, (_dv, b) => {
      b.set([0x31, 0x2e, 0x32, 0x32], 8); // "1.22"
    }),
  );
  bwdAppend(chunk(tagAt(TAG.DTBL), 0x1c));
}

/** The chassisTable row whose 3-letter prefix starts `mekName` (strnicmp), or -1; the row count is where the NULL prefix ends it. */
export function chassisIndexOf(mekName: string): number {
  const m = mem();
  const stride = structSize('ChassisEntry');
  for (let i = 0; ; i++) {
    const prefix = m.ptrStr(SHELL_LABEL.chassisTable + i * stride + fieldOffset('ChassisEntry', 'prefix'));
    if (prefix === null) return -1;
    if (strnicmp(mekName, prefix, 3) === 0) return i;
  }
}

/** A chassisTable row's fields. */
export function chassisEntry(i: number): { animCode: string; prefix: string; streamName: string; displayName: string; tonnage: number; nameSound: number } {
  const m = mem();
  const a = SHELL_LABEL.chassisTable + i * structSize('ChassisEntry');
  const s = (f: string) => m.ptrStr(a + fieldOffset('ChassisEntry', f)) ?? '';
  return {
    animCode: s('animCode'),
    prefix: s('prefix'),
    streamName: s('streamName'),
    displayName: s('displayName'),
    tonnage: m.i32(a + fieldOffset('ChassisEntry', 'tonnage')),
    nameSound: m.i32(a + fieldOffset('ChassisEntry', 'nameSound')),
  };
}

/**
 * Appends one 'Mech's 0x5c-byte GPS chunk - nothing when the MEK name
 * matches no chassis. +8 the MEK's TABL 6 id (-2 unless the name ends
 * 'std': MW2 then opens mek\<name>), +0xa the chassis stream's TABL 0xe id,
 * +0xc the star number, +0xd leader (index 0), +0xe 0 for the player's own
 * 'Mech else 2, +0x10 five shorts of enemySkillTable[skill] (skill clamped
 * to 1..8, and 0 in the player's star), +0x20 6, +0x22 0x400, +0x24 the
 * chassis stream name, +0x2d the MEK name, +0x36 the pilot name (15 chars).
 * Only 0x5a bytes are built; the last two are the buffer's zeros.
 *
 * @mw2shell star_bwd_add_mech 0x0001d310
 * @fidelity exact
 */
export function starBwdAddMech(mekName: string, pilotName: string, index: number, starNumber: number, skill: number): void {
  const row = chassisIndexOf(mekName);
  if (row < 0) return;
  if (skill < 1) skill = 1;
  if (skill > 8) skill = 8;
  if (starNumber === 0) skill = 0;
  const m = mem();
  const stream = chassisEntry(row).streamName;
  const prj = project();
  const gps = chunk(tagAt(TAG.GPS), 0x5c, (dv, b) => {
    const put = (at: number, s: string, n: number) => {
      for (let i = 0; i < n; i++) b[at + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
    };
    put(0x2d, mekName, 8);
    put(0x24, stream, 8);
    put(0x36, pilotName, 0xf);
    dv.setInt16(0x22, 0x400, true);
    dv.setInt16(8, strnicmp(mekName.slice(5), 'std', 3) === 0 ? resourceIdByName(prj, 6, mekName.slice(0, 8)) : -2, true);
    dv.setInt16(0xa, resourceIdByName(prj, 0xe, stream.slice(0, 8)), true);
    b[0xc] = starNumber & 0xff;
    b[0xd] = index === 0 ? 1 : 0;
    b[0xe] = index === 0 && starNumber === 0 ? 0 : 2;
    for (let k = 0; k < 5; k++) dv.setInt16(0x10 + k * 2, m.i16(SHELL_LABEL.enemySkillTable + skill * 10 + k * 2), true);
    dv.setInt16(0x20, 6, true);
  });
  // only 0x5a bytes are copied: the last two stay the buffer's zeros
  gps[0x5a] = 0;
  gps[0x5b] = 0;
  bwdAppend(gps);
}

/** Sets streamLength and writes the buffer's used bytes to `name`. */
function bwdWrite(name: string): void {
  const m = mem();
  const len = m.i32(SHELL_LABEL.bwdLength);
  m.setI32(BUF + fieldOffset('BwdBuffer', 'streamLength'), len);
  dosFileWrite(name, m.view(BUF, len));
}

/** One star record's members for star_files_write: {chassis, mekName, pilotName} at a 0x24 stride. */
function starMembers(addr: number, count: number): Array<{ chassis: number; mekName: string; pilotName: string }> {
  const m = mem();
  const stride = structSize('StarMember');
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = addr + i * stride;
    out.push({ chassis: m.i32(a), mekName: m.cstr(a + fieldOffset('StarMember', 'mekName'), 16), pilotName: m.cstr(a + fieldOffset('StarMember', 'pilotName'), 16) });
  }
  return out;
}

/**
 * Writes userstar.bwd from the player's members (star 0, skill 0), then
 * en01star.bwd .. en05star.bwd from the opponent's: the same 'Mechs in each,
 * star n, skill starting at opponentStarSkill - 2 (MW2DIF.CFG's difficulty
 * 0 adds one, 2 takes one) and one lower in each later file - a lower row is
 * harder. A member whose chassis is < 0 is skipped but still counts as an
 * index.
 *
 * @mw2shell star_files_write 0x0001d540
 * @fidelity exact
 */
export function starFilesWrite(playerCount: number, playerStar: number, enemyCount: number, enemyStar: number): void {
  bwdBuildBegin();
  starMembers(playerStar, Math.max(0, playerCount)).forEach((p, i) => {
    if (p.chassis >= 0) starBwdAddMech(p.mekName, p.pilotName, i, 0, 0);
  });
  bwdWrite('userstar.bwd');
  let skill = mem().i32(SHELL_LABEL.opponentStarSkill) - 2;
  const dif = dosFileLoad('MW2DIF.CFG');
  if (dif && dif.length >= 8) {
    if (dif[5] === 0) skill++;
    else if (dif[5] === 2) skill--;
  }
  for (let n = 1; n < 6; n++) {
    bwdBuildBegin();
    starMembers(enemyStar, Math.max(0, enemyCount)).forEach((p, i) => {
      if (p.chassis >= 0) starBwdAddMech(p.mekName, p.pilotName, i, n, skill);
    });
    bwdWrite(`en${String(n).padStart(2, '0')}star.bwd`);
    skill--;
  }
}

/** A BMPJ chunk: {tag, size, short id, name\0}, size = 8 + 2 + strlen + 1 rounded down after adding 3 - so 8-letter names take 20 bytes. */
function bmpj(name: string): Uint8Array {
  const size = (name.length + 1 + 0xd) & ~3;
  return chunk(tagAt(TAG.BMPJ), size, (dv, b) => {
    dv.setInt16(8, resourceIdByName(project(), 8, name), true);
    // the name is strcpy'd into a 22-byte stack buffer and `size` bytes copied from it:
    // bytes past the NUL are whatever the stack held (zero in the shipped file)
    for (let i = 0; i < name.length && 10 + i < size; i++) b[10 + i] = name.charCodeAt(i) & 0xff;
  });
}

function bmid(slot: number): Uint8Array {
  return chunk(tagAt(TAG.BMID), 0xc, (dv) => {
    dv.setInt16(8, slot, true);
    dv.setInt16(10, -1, true);
  });
}

/**
 * Writes instmap1.bwd: the star-file header, then three BMPJ + BMID pairs
 * pointing 3D-bitmap slot 0x114 at insigniaNames[insigniaA], 0x115 at
 * insigniaNames[insigniaB] and 0x101 at 'jscamoia'.
 *
 * @mw2shell instmap_write 0x0001d6c0
 * @fidelity exact
 * @divergence the bytes after each BMPJ name's NUL are uninitialised stack in the original; the port writes zeros (the shipped instmap1.bwd has zeros there)
 */
export function instmapWrite(insigniaA: number, insigniaB: number): void {
  const m = mem();
  const name = (i: number) => m.ptrStr(SHELL_LABEL.insigniaNames + i * 4) ?? '';
  bwdBuildBegin();
  bwdAppend(bmpj(name(insigniaA)));
  bwdAppend(bmid(0x114));
  bwdAppend(bmpj(name(insigniaB)));
  bwdAppend(bmid(0x115));
  bwdAppend(bmpj('jscamoia'));
  bwdAppend(bmid(0x101));
  bwdWrite('instmap1.bwd');
}

