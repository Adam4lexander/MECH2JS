/**
 * The game CD as a DOS drive: the ISO9660 data track of the install's CD
 * image (MECH2_16B.BIN, via its cue sheet), read by byte range from the dev
 * server. The shell finds its movies and screen animations there
 * (X:\SMK\...), as it did with the disc in the drive.
 *
 * @portOnly the host's CD-ROM drive
 */
import { IsoImage, RawSectorSource } from '../../data/formats/iso9660.ts';
import { parseCue } from '../../data/formats/cue.ts';
import { dosFilePrefetchDir, setCdDrive } from '../../engine/dosFiles.ts';
import { warn } from '../../core/log.ts';

/** The letter the port's CD drive answers to (MSCDEX's first CD drive on a typical PC). */
export const CD_LETTER = 'D';

async function rangeRead(file: string, offset: number, length: number): Promise<Uint8Array> {
  const r = await fetch(`/mw2/${file}`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (!r.ok && r.status !== 206) throw new Error(`${file}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Mounts the CD image's data track as drive D:, or leaves no CD drive when there is no image. */
export async function mountCd(cue: { name: string; text: string } | null): Promise<boolean> {
  const sheet = cue ? parseCue(cue.text) : null;
  const data = sheet?.tracks.find((t) => !t.audio);
  if (!sheet || !data) {
    setCdDrive(null);
    return false;
  }
  try {
    const iso = await IsoImage.open(new RawSectorSource((o, n) => rangeRead(sheet.file, o, n), data.start));
    setCdDrive({
      letter: CD_LETTER,
      read: async (path) => ((await iso.exists(path)) ? iso.read(path) : null),
      list: async (dir) => {
        const e = await iso.lookup(dir);
        if (!e || !e.directory) return null;
        return (await iso.readDir(e)).filter((c) => !c.directory && c.name !== '.' && c.name !== '..').map((c) => c.name);
      },
    });
    // the training instructor's voice (MW2.EXE's project_scan_dev_dir reads it at a mission's start-up): 2.6 MB, fetched now
    void dosFilePrefetchDir(`${CD_LETTER}:keating`);
    return true;
  } catch (e) {
    warn('cd', `the CD image could not be read: ${String(e)}`);
    setCdDrive(null);
    return false;
  }
}
