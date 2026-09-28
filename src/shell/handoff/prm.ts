/**
 * mw2prm.cfg: the shell's state parked across a mission, and MW2.EXE's
 * command line (decompiled/mw2shell/src/handoff/prm.c; the layout is in
 * decompiled/mech2/README.md). 0x218 bytes, PrmBlock at 0xa6394, read and
 * written whole - prm_save writes over the block prm_load read, so the file
 * keeps the tail of any longer earlier command line.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { starLaunchPrepare, starsRestoreFromPrm, starsSaveToPrm } from './stars.ts';

const PRM = SHELL_LABEL.prmBlock;
const SIZE = structSize('PrmBlock');
const F = {
  resumeState: fieldOffset('PrmBlock', 'resumeState'),
  career: fieldOffset('PrmBlock', 'career'),
  pilotAccepted: fieldOffset('PrmBlock', 'pilotAccepted'),
  pilotSlot: fieldOffset('PrmBlock', 'pilotSlot'),
  commandLine: fieldOffset('PrmBlock', 'commandLine'),
};
const PILOT_SIZE = structSize('PilotRecord');

/** What prm_load hands back through its pointer arguments. */
export interface PrmLoaded {
  state: number;
  career: number;
  /** a byte: the pilot-accepted flag */
  pilotAccepted: number;
  /** the command line's first word (prm_load cuts it at the first character <= ' ') */
  commandLine: string;
}

/**
 * Reads mw2prm.cfg into the block and hands out the resume state, career,
 * pilot-accepted byte and the command line's first word; restores
 * currentPilot from the slot (-1: none) and both stars. Null when the file
 * is missing or short (the outputs are then left untouched).
 *
 * @mw2shell prm_load 0x000374c0
 * @fidelity exact
 */
export function prmLoad(): PrmLoaded | null {
  const f = dosFileLoad('mw2prm.cfg');
  if (!f || f.length < SIZE) return null;
  const m = mem();
  m.view(PRM, SIZE).set(f.subarray(0, SIZE));
  const cl = PRM + F.commandLine;
  let n = 0;
  while (m.u8(cl + n) > 0x20) n++;
  m.setU8(cl + n, 0);
  const slot = m.i32(PRM + F.pilotSlot);
  m.setI32(SHELL_LABEL.currentPilot, slot < 0 ? 0 : SHELL_LABEL.pilotRegistry + slot * PILOT_SIZE);
  const out: PrmLoaded = {
    state: m.i32(PRM + F.resumeState),
    career: m.i32(PRM + F.career),
    pilotAccepted: m.u8(PRM + F.pilotAccepted),
    commandLine: m.cstr(cl),
  };
  starsRestoreFromPrm();
  return out;
}

/**
 * Writes mw2prm.cfg: the next state, career and pilot-accepted byte, the
 * command line (`commandLine` + " -b=" + launchAnimName, then - unless the
 * next state is 0xe or -3 - star_launch_prepare's formations, which also
 * writes the star files), the current pilot's slot and both stars.
 *
 * @mw2shell prm_save 0x000375a0
 * @fidelity exact
 */
export function prmSave(nextState: number, career: number, pilotAccepted: number, commandLine: string): void {
  const m = mem();
  m.setI32(PRM + F.pilotAccepted, pilotAccepted & 0xff);
  m.setI32(PRM + F.resumeState, nextState);
  m.setI32(PRM + F.career, career);
  const cl = PRM + F.commandLine;
  m.strcpy(cl, commandLine);
  m.strcat(cl, m.cstr(SHELL_LABEL.optionLaunchAnim));
  m.strcat(cl, m.cstr(SHELL_LABEL.launchAnimName));
  const pilot = m.u32(SHELL_LABEL.currentPilot);
  m.setI32(PRM + F.pilotSlot, pilot === 0 ? -1 : ((pilot - SHELL_LABEL.pilotRegistry) / PILOT_SIZE) | 0);
  starsSaveToPrm();
  if (nextState !== 0xe && nextState !== -3) starLaunchPrepare();
  dosFileWrite('mw2prm.cfg', m.view(PRM, SIZE));
}

/** @portOnly MW2.EXE's command line as MECH2 passes it (the C string at +0x118 of the file) */
export function prmCommandLine(file: Uint8Array): string {
  let s = '';
  for (let i = F.commandLine; i < file.length && file[i] !== 0; i++) s += String.fromCharCode(file[i]!);
  return s;
}
