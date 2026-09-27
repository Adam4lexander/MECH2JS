/**
 * The dev route's way into a mission (the mission picker): what the shell's
 * screens would do before a launch, done by the ported shell code into a
 * scratch overlay of the disk - the mission's BRF2 stars and launch
 * animation (mission_brf2_load), the Trial of Grievance insignia map
 * (instmap_write), and prm_save, which writes the star files and MW2.EXE's
 * command line. Nothing is persisted; the player's career files are not
 * touched.
 *
 * @portOnly the mission picker's stand-in for the shell's screens
 */
import type { ExeImage } from '../data/exe/ExeImage.ts';
import type { ProjectFile } from '../data/prj/ProjectFile.ts';
import { dosFileLoad, dosFileWrite, setOverlayFiles } from '../engine/dosFiles.ts';
import { splitCommandTail } from '../mission/commandLine.ts';
import { prmCommandTail } from '../launcher/mech2.ts';
import { startShellProcess } from './boot.ts';
import { missionBrf2Load } from './career/brf2.ts';
import { instmapWrite } from './handoff/starFiles.ts';
import { prmSave } from './handoff/prm.ts';

export interface DevLaunch {
  shellExe: ExeImage;
  prj: ProjectFile;
  /** the SCN1 stream, e.g. 'CHEDSCN1' */
  stream: string;
  /** the mission includes INSTMAP1.BWD (the Trial of Grievance scenarios) */
  insignia: boolean;
  /** the picker's own USERSTAR.BWD, replacing the BRF2 star the shell would write; null keeps the shell's */
  userStar: Uint8Array | null;
}

/** Writes the mission's files into a fresh overlay and returns MW2.EXE's argv. */
export function prepareDevMission(opts: DevLaunch): string[] {
  setOverlayFiles(new Map());
  startShellProcess(opts.shellExe, opts.prj);
  missionBrf2Load(opts.stream.toLowerCase(), true, false);
  // the grievance screen's default pair: Wolf against Jade Falcon
  if (opts.insignia) instmapWrite(0, 1);
  // main's state 10: career 2 (the Trial of Grievance mode needs no pilot), resume at the debriefing
  prmSave(3, 2, 1, opts.stream.toLowerCase());
  if (opts.userStar) dosFileWrite('USERSTAR.BWD', opts.userStar);
  return splitCommandTail('mw2.exe', prmCommandTail(dosFileLoad('mw2prm.cfg')!));
}
