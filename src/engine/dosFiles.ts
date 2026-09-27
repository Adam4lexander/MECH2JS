/**
 * The game directory as the original programs' fopen, fread, fwrite and
 * file_load see it: files addressed by DOS paths relative to the game
 * directory ("input.map", "giddi\keyboard.dll", "mek\tbr00usr.mek"),
 * case-insensitively. MW2.EXE and MW2SHELL.EXE share it - in the original
 * the files are the whole contract between them (mw2prm.cfg, the star BWDs,
 * mw2msn.cfg...).
 *
 * Three layers, looked up top first:
 *   overlay  - scratch files nothing persists (the dev mission picker's stars)
 *   own      - the port's own files: everything the programs write (the
 *              pilot registry, mw2prm.cfg, the cfg files, the stars, user
 *              MEKs...). The host persists them (app/diskStore.ts) through
 *              the hook set with setDiskPersistence.
 *   assets   - what the host read from the install before a load: the
 *              GIDDI drivers and other read-only content.
 * The port never reads the install's config or player files (see
 * docs/porting-notes.md): a file a program writes lives in `own`.
 *
 * Keys are the upper-cased path with '/' separators; nothing here touches a
 * real disk.
 *
 * @portOnly the C runtime's file access, over an in-memory file system
 */
import { registerGlobals } from './globals.ts';

export const dosFiles = registerGlobals(
  'dosFiles',
  {
    /** read-only content from the install */
    files: new Map<string, Uint8Array>(),
    /** the port's own files: what the programs have written */
    own: new Map<string, Uint8Array>(),
    /** scratch files over both, or null */
    overlay: null as Map<string, Uint8Array> | null,
  },
  () => {
    // the disk is not process state: a program starting keeps it
  },
);

let persist: ((key: string, bytes: Uint8Array | null) => void) | null = null;

/** @portOnly the read-only layer (the install's assets the host read) */
export function setDosFiles(files: Map<string, Uint8Array>): void {
  dosFiles.files = new Map([...files].map(([k, v]) => [dosPathKey(k), v]));
}

/** @portOnly the port's own files, as the host restored them (e.g. from IndexedDB) */
export function setOwnFiles(files: Map<string, Uint8Array>): void {
  dosFiles.own = new Map([...files].map(([k, v]) => [dosPathKey(k), v]));
}

/**
 * @portOnly scratch files over the disk (null removes them). While an
 * overlay is set, writes land in it and are not persisted.
 */
export function setOverlayFiles(files: Map<string, Uint8Array> | null): void {
  dosFiles.overlay = files ? new Map([...files].map(([k, v]) => [dosPathKey(k), v])) : null;
}

/** @portOnly the host's hook, told of every write (bytes) and removal (null) in the own layer */
export function setDiskPersistence(fn: ((key: string, bytes: Uint8Array | null) => void) | null): void {
  persist = fn;
}

/** @portOnly the key a DOS path is stored under */
export function dosPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toUpperCase();
}

function lookup(key: string): Uint8Array | undefined {
  return dosFiles.overlay?.get(key) ?? dosFiles.own.get(key) ?? dosFiles.files.get(key);
}

/**
 * The whole file, or null when it does not exist - what file_load returns
 * (a malloc'd copy, or 0).
 *
 * @portOnly the result of file_load / fopen+fread on the install
 */
export function dosFileLoad(path: string): Uint8Array | null {
  return lookup(dosPathKey(path)) ?? null;
}

/** @portOnly whether fopen(path, "rb") would succeed */
export function dosFileExists(path: string): boolean {
  return lookup(dosPathKey(path)) !== undefined;
}

/**
 * Writes a whole file - fopen(path, "wb"), fwrite, fclose. A copy is kept.
 *
 * @portOnly the C runtime's file writes, into the port's own layer
 */
export function dosFileWrite(path: string, bytes: Uint8Array): void {
  const key = dosPathKey(path);
  const copy = bytes.slice();
  if (dosFiles.overlay) {
    dosFiles.overlay.set(key, copy);
    return;
  }
  dosFiles.own.set(key, copy);
  persist?.(key, copy);
}

/**
 * Deletes a file - remove(path). Only the port's own files can be removed;
 * returns whether one was.
 *
 * @portOnly the C runtime's remove
 */
export function dosFileRemove(path: string): boolean {
  const key = dosPathKey(path);
  if (dosFiles.overlay?.delete(key)) return true;
  if (!dosFiles.own.delete(key)) return false;
  persist?.(key, null);
  return true;
}

/**
 * The file names (without their directory, upper-cased as DOS reports
 * them) matching a DOS wildcard pattern such as "mek\tbr??usr.mek", in name
 * order - what a findfirst / findnext walk returns.
 *
 * @portOnly the C runtime's directory search
 */
export function dosFindFiles(pattern: string): string[] {
  const key = dosPathKey(pattern);
  const slash = key.lastIndexOf('/');
  const dir = slash < 0 ? '' : key.slice(0, slash + 1);
  const re = new RegExp('^' + key.slice(slash + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  const names = new Set<string>();
  for (const layer of [dosFiles.files, dosFiles.own, dosFiles.overlay ?? new Map()]) {
    for (const k of layer.keys()) {
      if (!k.startsWith(dir)) continue;
      const rest = k.slice(dir.length);
      if (!rest.includes('/') && re.test(rest)) names.add(rest);
    }
  }
  return [...names].sort();
}

/** The CD drive: its letter and a reader for paths on it ('SMK\MINTRO.SMK'). */
let cd: { letter: string; read: (path: string) => Promise<Uint8Array | null> } | null = null;

/** @portOnly the host's CD drive (the game CD's image), or null for none */
export function setCdDrive(drive: { letter: string; read: (path: string) => Promise<Uint8Array | null> } | null): void {
  cd = drive ? { letter: drive.letter.toUpperCase(), read: drive.read } : null;
}

/** @portOnly the CD drive's letter, or '' */
export function cdDriveLetter(): string {
  return cd?.letter ?? '';
}

/**
 * A file anywhere a program can open one: the disk, or - for a path on the
 * CD's drive ("D:\smk\mintro.smk") - the CD, which the host reads
 * asynchronously (the image is far too big to hold).
 *
 * @portOnly fopen+fread across the hard disk and the CD
 */
export async function dosFileLoadAsync(path: string): Promise<Uint8Array | null> {
  const key = dosPathKey(path);
  const m = /^([A-Z]):\/?(.*)$/.exec(key);
  if (m) {
    if (cd && m[1] === cd.letter) return cd.read(m[2]!);
    return null;
  }
  return lookup(key) ?? null;
}

/** @portOnly every file the programs can see, merged top layer first (for the sim's loose-file maps) */
export function dosDiskSnapshot(): Map<string, Uint8Array> {
  return new Map([...dosFiles.files, ...dosFiles.own, ...(dosFiles.overlay ?? new Map())]);
}

/**
 * A text file opened for reading, line by line - fopen(name, "r") and the
 * fgets calls on it. Text mode drops the '\r' of each CRLF.
 *
 * @portOnly the C runtime's text stream
 */
export class DosTextFile {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  /** fgets(buf, n, f): up to n - 1 characters, keeping the '\n'; null at end of file */
  fgets(n: number): string | null {
    if (this.pos >= this.bytes.length) return null;
    let s = '';
    while (this.pos < this.bytes.length && s.length < n - 1) {
      const c = this.bytes[this.pos++]!;
      if (c === 0x0d) continue;
      s += String.fromCharCode(c);
      if (c === 0x0a) break;
    }
    return s;
  }
}

/** @portOnly fopen(path, "r"), or null */
export function dosFopen(path: string): DosTextFile | null {
  const b = dosFileLoad(path);
  return b ? new DosTextFile(b) : null;
}
