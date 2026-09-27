/**
 * MECH2.EXE, the launcher: the loop that runs the front end and the sim in
 * turn (decompiled/mech2/README.md; main @ 0x101fb). In the original each
 * step is a spawned process; the port's host supplies the two programs and
 * this loop keeps their order and exit-code contract:
 *
 *   status = mw2shell intro
 *   while status != 0xff:
 *     read mw2prm.cfg (0x218 bytes; stop if it is missing or short)
 *     status = mw2.exe <the C string at +0x118>
 *     if status == 0xff: break
 *     status = mw2shell sim
 *
 * memory_check and cd_check_disc (the CD must be in the drive) are the
 * host's business; the closing copyright lines are printed to the log.
 *
 * @portOnly MECH2.EXE's main (not a tagged target: its four functions are this loop and DOS checks)
 */
import { dosFileLoad } from '../engine/dosFiles.ts';
import { log } from '../core/log.ts';

/** The two programs, as the host runs them. Each resolves with its exit status. */
export interface Mech2Programs {
  /** MW2SHELL.EXE with its one argument: 'intro' at start, 'sim' back from a mission */
  shell(arg: 'intro' | 'sim'): Promise<number>;
  /** MW2.EXE with its argv (argv[0] 'mw2.exe', then the command line split at spaces) */
  sim(argv: string[]): Promise<number>;
}

const PRM_SIZE = 0x218;
const PRM_COMMAND_LINE = 0x118;

/** The command line MECH2 passes to mw2.exe: the C string at +0x118 of mw2prm.cfg. */
export function prmCommandTail(prm: Uint8Array): string {
  let s = '';
  for (let i = PRM_COMMAND_LINE; i < prm.length && prm[i] !== 0; i++) s += String.fromCharCode(prm[i]!);
  return s;
}

/**
 * Runs the game until a program exits with 0xff (the shell's "Embrace
 * cowardice" or the sim's Flee to DOS).
 *
 * @portOnly MECH2.EXE main (0x101fb)
 */
export async function mech2Main(programs: Mech2Programs, splitArgs: (program: string, tail: string) => string[]): Promise<void> {
  let status = await programs.shell('intro');
  while (status !== 0xff) {
    const prm = dosFileLoad('mw2prm.cfg');
    if (!prm || prm.length < PRM_SIZE) break; // exit(0)
    status = await programs.sim(splitArgs('mw2.exe', prmCommandTail(prm)));
    if (status === 0xff) break;
    status = await programs.shell('sim');
  }
  log('mech2', 'MechWarrior 2: 31st Century Combat');
  log('mech2', 'Copyright (C) 1995, Activision Studios, Inc., All Rights Reserved.');
}
