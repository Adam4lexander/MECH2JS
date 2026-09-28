/**
 * The star BWD files the shell (MW2SHELL.EXE) writes beside MW2.EXE before a
 * mission - USERSTAR.BWD, the player's star, and EN01..EN05STAR.BWD, the
 * opponents some missions take - built in memory from the port's own mission
 * setup instead of read from the install.
 *
 * Layout, as the shell's files have it: the BWD chunk {'BWD', stream length,
 * largest chunk}, REV '1.22', an empty DTBL of 0x1c, then one GPS chunk of
 * 0x5c per 'Mech (see data/bwd/payloads/gps.ts for the fields the game reads):
 *
 *   player    group 0, leader 1, side 0 (the player's mech), AI parameters 0,
 *             objective mask 0x0006, flags 0x0400 - the same values as the
 *             player GPS of MW2.PRJ's own star streams (AMY_STAR, KIM_STAR ...)
 *   starmate  group 0, leader 0, side 2 (the group's allegiance), AI
 *             parameters 0, mask 0x0006, flags 0x0400
 *
 * These are the shell's own rules: its writer is ported as
 * shell/handoff/starFiles.ts (star_bwd_add_mech, star_files_write), which
 * the game's front end and the dev route use. This builder stays for the dev
 * picker's own star, which is freer than the shell's in two ways: any 'Mech
 * the missions field (not only the shell's 18-row chassisTable, with its
 * Keshik tonnage cap), and names up to 21 characters (the shell cuts them at
 * 15). test/sim/missionSetup.test.ts checks it against the install's
 * USERSTAR.BWD.
 *
 * The chunk is 0x5c bytes, so the name the game reads at +0x4c (22 bytes)
 * runs into the next chunk; the shell leaves +0x4c.. zero, so it reads empty.
 *
 * @portOnly the dev picker's star builder (the shell's writer is shell/handoff/starFiles.ts)
 */
import type { MechChoice } from '../catalog/mechs.ts';

export interface StarMember {
  /** at most 21 characters (the game's strncpy 0x16, last byte NUL) */
  name: string;
  mech: MechChoice;
}

export interface StarSetup {
  pilot: StarMember;
  /** at most STARMATE_LIMIT */
  starmates: StarMember[];
}

/** A star is five 'Mechs at most (MechGroup.members), the player and four starmates. */
export const STARMATE_LIMIT = 4;

const GPS_SIZE = 0x5c;

function ascii(b: Uint8Array, at: number, s: string, max: number): void {
  for (let i = 0; i < Math.min(s.length, max); i++) b[at + i] = s.charCodeAt(i) & 0x7f;
}

function gps(m: StarMember, player: boolean): Uint8Array {
  const b = new Uint8Array(GPS_SIZE);
  const dv = new DataView(b.buffer);
  ascii(b, 0, 'GPS', 4);
  dv.setUint32(4, GPS_SIZE, true);
  dv.setInt16(0x08, m.mech.mekId, true);
  dv.setInt16(0x0a, m.mech.stream.id, true);
  b[0x0c] = 0;
  b[0x0d] = player ? 1 : 0;
  b[0x0e] = player ? 0 : 2;
  dv.setUint16(0x20, 0x0006, true);
  dv.setUint16(0x22, 0x0400, true);
  ascii(b, 0x24, m.mech.stream.name, 8);
  ascii(b, 0x2d, m.mech.config, 8);
  ascii(b, 0x36, m.name, 0x15);
  return b;
}

/** A star file: the BWD header, REV, DTBL and the GPS chunks given. */
function starFile(chunks: Uint8Array[]): Uint8Array {
  const rev = new Uint8Array(0xc);
  ascii(rev, 0, 'REV', 4);
  new DataView(rev.buffer).setUint32(4, 0xc, true);
  ascii(rev, 8, '1.22', 4);
  const dtbl = new Uint8Array(0x1c);
  ascii(dtbl, 0, 'DTBL', 4);
  new DataView(dtbl.buffer).setUint32(4, 0x1c, true);
  const body = [rev, dtbl, ...chunks];
  const length = 0xc + body.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(length);
  const dv = new DataView(out.buffer);
  ascii(out, 0, 'BWD', 4);
  dv.setUint32(4, length, true);
  dv.setUint32(8, Math.max(...body.map((c) => c.length)), true);
  let at = 0xc;
  for (const c of body) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** USERSTAR.BWD for this setup: the player, then the starmates. */
export function buildUserStar(s: StarSetup): Uint8Array {
  return starFile([gps(s.pilot, true), ...s.starmates.slice(0, STARMATE_LIMIT).map((m) => gps(m, false))]);
}

/** An opponent star with no 'Mechs - what the shell leaves in EN0nSTAR.BWD when no opponents were set up. */
export function buildEmptyStar(): Uint8Array {
  return starFile([]);
}
