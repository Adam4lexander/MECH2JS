/**
 * The game CD as a DOS drive, read from the install as it goes: either
 * the ISO9660 data track of the install's CD image (MECH2_16B.BIN, via its
 * cue sheet), read by byte range, or - a ripped CD - the CD's directories
 * copied into the install, each file fetched whole. The programs find their
 * movies and screen animations (X:\SMK\...), launch pictures and the
 * instructor's voice there, as they did with the disc in the drive.
 *
 * @portOnly the host's CD-ROM drive
 */
import { IsoImage, RawSectorSource } from '../../data/formats/iso9660.ts';
import { parseCue } from '../../data/formats/cue.ts';
import { dosFilePrefetchDir, setCdDrive, type CdDrive } from '../../engine/dosFiles.ts';
import { warn } from '../../core/log.ts';
import type { GameCd } from '../gameData.ts';
import type { InstallSource } from '../../data/source/FileSource.ts';

/** The letter the port's CD drive answers to (MSCDEX's first CD drive on a typical PC). */
export const CD_LETTER = 'D';

/** The drive over the CD image's data track, or null when the cue sheet has none. */
async function imageDrive(src: InstallSource, cue: { name: string; text: string }): Promise<CdDrive | null> {
  const sheet = parseCue(cue.text);
  const data = sheet?.tracks.find((t) => !t.audio);
  if (!sheet || !data) return null;
  const iso = await IsoImage.open(new RawSectorSource((o, n) => src.readRange(sheet.file, o, o + n), data.start));
  return {
    letter: CD_LETTER,
    read: async (path) => ((await iso.exists(path)) ? iso.read(path) : null),
    list: async (dir) => {
      const e = await iso.lookup(dir);
      if (!e || !e.directory) return null;
      return (await iso.readDir(e)).filter((c) => !c.directory && c.name !== '.' && c.name !== '..').map((c) => c.name);
    },
  };
}

/** The drive over the CD's files in the install: 'SMK/MINTRO.SMK' is the install's smk\mintro.smk. */
function filesDrive(src: InstallSource): CdDrive {
  return {
    letter: CD_LETTER,
    read: async (path) => ((await src.exists(path)) ? src.read(path) : null),
    list: async (dir) => {
      const names = await src.list(dir);
      return names.length > 0 ? names.map((n) => n.slice(n.lastIndexOf('/') + 1)) : null;
    },
  };
}

/** Mounts the game CD as drive D:, or leaves no CD drive when the install has none. */
export async function mountCd(src: InstallSource, cd: GameCd | null): Promise<boolean> {
  let drive: CdDrive | null = null;
  try {
    if (cd?.kind === 'image') drive = await imageDrive(src, cd.cue);
    else if (cd?.kind === 'files') drive = filesDrive(src);
  } catch (e) {
    warn('cd', `the CD image could not be read: ${String(e)}`);
  }
  setCdDrive(drive);
  if (!drive) return false;
  // the training instructor's voice (MW2.EXE's project_scan_dev_dir reads it at a mission's start-up): 2.6 MB, fetched now
  void dosFilePrefetchDir(`${CD_LETTER}:keating`);
  return true;
}
