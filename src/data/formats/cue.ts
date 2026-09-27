/**
 * A CD image's cue sheet (the install's MECH2_16B.CUE beside its BIN): the
 * tracks and where each starts in the raw 2352-byte-sector image. Track 1 is
 * the data track (ISO9660, data/formats/iso9660.ts); the rest are the
 * Redbook music (audio/binCdDrive.ts).
 *
 * @portOnly
 */

/** Bytes per raw CD sector in a BIN image. */
export const CD_RAW_SECTOR = 2352;

export interface CueTrack {
  number: number;
  audio: boolean;
  /** byte offset of INDEX 01 in the BIN */
  start: number;
  /** byte offset where the next track's INDEX 00 (or 01) begins; the file's end for the last */
  end: number | null;
}

export interface CueSheet {
  file: string;
  tracks: CueTrack[];
}

function msf(t: string): number {
  const [m, s, f] = t.split(':').map(Number);
  return ((m! * 60 + s!) * 75 + f!) * CD_RAW_SECTOR;
}

/** Reads a single-FILE cue sheet. @portOnly */
export function parseCue(text: string): CueSheet | null {
  let file = '';
  const tracks: CueTrack[] = [];
  const pre: number[] = [];
  let cur: CueTrack | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^FILE\s+"([^"]+)"/i.exec(line))) file = m[1]!;
    else if ((m = /^TRACK\s+(\d+)\s+(\S+)/i.exec(line))) {
      cur = { number: Number(m[1]), audio: /^AUDIO$/i.test(m[2]!), start: 0, end: null };
      tracks.push(cur);
      pre.push(-1);
    } else if (cur && (m = /^INDEX\s+(\d+)\s+(\d+:\d+:\d+)/i.exec(line))) {
      if (Number(m[1]) === 1) cur.start = msf(m[2]!);
      else if (Number(m[1]) === 0) pre[pre.length - 1] = msf(m[2]!);
    }
  }
  if (!file || tracks.length === 0) return null;
  for (let i = 0; i + 1 < tracks.length; i++) tracks[i]!.end = pre[i + 1]! >= 0 ? pre[i + 1]! : tracks[i + 1]!.start;
  return { file, tracks };
}
