/**
 * ISO 9660: the file system on the game CD (MECH2_16B.BIN, track 1), where
 * the front end's movies (SMK\*.SMK) and most of its screen animations live.
 *
 * The image is read a sector range at a time through a SectorSource, so a
 * 750 MB BIN never has to be held in memory: in the browser the bytes come
 * from HTTP range requests, in node from fs reads.
 *
 *   raw sector (MODE1/2352)  +0 sync (12)  +12 header (4)  +16 user data (2048)  +2064 EDC/ECC
 *   sector 16                the Primary Volume Descriptor (type 1, "CD001")
 *     PVD +40   volume identifier, 32 a-characters
 *         +80   volume space size, u32 LE (+84 BE)
 *         +128  logical block size, u16 LE (+130 BE)
 *         +156  the root directory's record, 34 bytes
 *   directory record
 *         +0    record length (0: no more records in this sector)
 *         +1    extended attribute record length, in blocks
 *         +2    extent LBA, u32 LE (+6 BE)
 *         +10   data length, u32 LE (+14 BE)
 *         +18   recording date and time, 7 bytes
 *         +25   flags: 0x02 directory, 0x80 not the final extent
 *         +32   name length, +33 name ("\0" is ".", "\1" is ".."; files carry ";1")
 *   Records never straddle a sector; a record length of 0 skips to the next.
 *
 * Names are matched case-insensitively with any ';<version>' suffix and a
 * trailing '.' dropped, as DOS (MSCDEX) presents them.
 *
 * @portOnly the port's own reader: the original ran from the CD through DOS and MSCDEX.
 */

export const ISO_SECTOR = 2048;
export const RAW_SECTOR = 2352;

/** Reads 2048-byte logical sectors of a data track. */
export interface SectorSource {
  /** user data of sectors lba .. lba + count - 1, concatenated (count * 2048 bytes) */
  readSectors(lba: number, count: number): Promise<Uint8Array>;
}

/** Reads `length` bytes of the underlying image starting at byte `offset`. */
export type ByteRangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * A MODE1/2352 track read from a raw image (BIN): each sector's 2048 bytes
 * of user data at +16. `trackStart` is the byte offset of the track's first
 * sector (0 for MECH2_16B.BIN's track 1; from the cue sheet's INDEX 01).
 *
 * @portOnly
 */
export class RawSectorSource implements SectorSource {
  constructor(
    private readonly read: ByteRangeReader,
    private readonly trackStart = 0,
    private readonly sectorSize = RAW_SECTOR,
    private readonly dataOffset = 16,
  ) {}

  async readSectors(lba: number, count: number): Promise<Uint8Array> {
    const raw = await this.read(this.trackStart + lba * this.sectorSize, count * this.sectorSize);
    if (raw.length < count * this.sectorSize) throw new Error(`iso9660: short read at sector ${lba} (${raw.length} of ${count * this.sectorSize} bytes)`);
    const out = new Uint8Array(count * ISO_SECTOR);
    for (let i = 0; i < count; i++) {
      const at = i * this.sectorSize + this.dataOffset;
      out.set(raw.subarray(at, at + ISO_SECTOR), i * ISO_SECTOR);
    }
    return out;
  }
}

/** A cooked image (.ISO, 2048-byte sectors) or a track already in memory. @portOnly */
export class CookedSectorSource implements SectorSource {
  constructor(private readonly read: ByteRangeReader) {}

  async readSectors(lba: number, count: number): Promise<Uint8Array> {
    const b = await this.read(lba * ISO_SECTOR, count * ISO_SECTOR);
    if (b.length < count * ISO_SECTOR) throw new Error(`iso9660: short read at sector ${lba}`);
    return b;
  }
}

export interface IsoEntry {
  /** name as recorded, version suffix and trailing '.' removed (e.g. 'MINTRO.SMK') */
  name: string;
  /** name exactly as recorded (e.g. 'MINTRO.SMK;1') */
  rawName: string;
  directory: boolean;
  /** first sector of the extent (after any extended attribute record) */
  lba: number;
  /** bytes */
  size: number;
  /** recording date, as recorded: [years since 1900, month, day, hour, minute, second, GMT offset in 15 min] */
  date: readonly number[];
  flags: number;
}

export interface IsoVolume {
  volumeId: string;
  systemId: string;
  volumeSetId: string;
  publisherId: string;
  applicationId: string;
  /** sectors in the volume */
  volumeSpaceSize: number;
  logicalBlockSize: number;
  root: IsoEntry;
}

const ascii = (b: Uint8Array, at: number, n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i]!);
  return s;
};
const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);

/** Strips the ';1' version and a trailing '.' (a file with no extension is recorded 'NAME.;1'). @portOnly */
export function isoCleanName(raw: string): string {
  let n = raw;
  const semi = n.indexOf(';');
  if (semi >= 0) n = n.slice(0, semi);
  if (n.endsWith('.') && n.length > 1) n = n.slice(0, -1);
  return n;
}

/** Reads the directory record at `at`. The caller has checked b[at] > 0. @portOnly */
export function parseDirectoryRecord(b: Uint8Array, at: number): IsoEntry {
  const nameLen = b[at + 32]!;
  const rawName = nameLen === 1 && b[at + 33] === 0 ? '.' : nameLen === 1 && b[at + 33] === 1 ? '..' : ascii(b, at + 33, nameLen);
  const flags = b[at + 25]!;
  return {
    name: rawName === '.' || rawName === '..' ? rawName : isoCleanName(rawName),
    rawName,
    directory: (flags & 2) !== 0,
    lba: u32(b, at + 2) + b[at + 1]!,
    size: u32(b, at + 10),
    date: Array.from(b.subarray(at + 18, at + 25), (v, i) => (i === 6 ? (v << 24) >> 24 : v)),
    flags,
  };
}

/** Reads the Primary Volume Descriptor (the first type-1 descriptor from sector 16). @portOnly */
export async function readPrimaryVolume(src: SectorSource): Promise<IsoVolume> {
  for (let lba = 16; lba < 16 + 32; lba++) {
    const s = await src.readSectors(lba, 1);
    if (ascii(s, 1, 5) !== 'CD001') throw new Error(`iso9660: no volume descriptor at sector ${lba}`);
    const type = s[0]!;
    if (type === 255) break;
    if (type !== 1) continue;
    const trim = (at: number, n: number) => ascii(s, at, n).replace(/[ \0]+$/, '');
    return {
      systemId: trim(8, 32),
      volumeId: trim(40, 32),
      volumeSpaceSize: u32(s, 80),
      logicalBlockSize: u16(s, 128),
      volumeSetId: trim(190, 128),
      publisherId: trim(318, 128),
      applicationId: trim(574, 128),
      root: parseDirectoryRecord(s, 156),
    };
  }
  throw new Error('iso9660: no primary volume descriptor');
}

/** The records of one directory's extent, '.' and '..' left out. @portOnly */
export function parseDirectory(extent: Uint8Array, size: number): IsoEntry[] {
  const out: IsoEntry[] = [];
  let at = 0;
  const end = Math.min(size, extent.length);
  while (at < end) {
    const len = extent[at]!;
    if (len === 0) {
      at = (Math.floor(at / ISO_SECTOR) + 1) * ISO_SECTOR;
      continue;
    }
    if (len < 34 || at + len > end) throw new Error(`iso9660: bad directory record at +${at} (length ${len})`);
    const e = parseDirectoryRecord(extent, at);
    if (e.name !== '.' && e.name !== '..') out.push(e);
    at += len;
  }
  return out;
}

/**
 * An ISO 9660 volume over a SectorSource: path lookup, directory listings
 * and whole-file reads. Paths use '/' or '\' separators and match
 * case-insensitively; directories are read once and cached.
 *
 * @portOnly
 */
export class IsoImage {
  private dirs = new Map<number, Promise<IsoEntry[]>>();

  private constructor(
    readonly source: SectorSource,
    readonly volume: IsoVolume,
  ) {}

  static async open(source: SectorSource): Promise<IsoImage> {
    const vol = await readPrimaryVolume(source);
    if (vol.logicalBlockSize !== ISO_SECTOR) throw new Error(`iso9660: logical block size ${vol.logicalBlockSize} is not supported`);
    return new IsoImage(source, vol);
  }

  get root(): IsoEntry {
    return this.volume.root;
  }

  /** The entries of a directory, in recorded order. */
  readDir(dir: IsoEntry): Promise<IsoEntry[]> {
    if (!dir.directory) return Promise.reject(new Error(`iso9660: ${dir.name} is not a directory`));
    let p = this.dirs.get(dir.lba);
    if (!p) {
      p = (async () => {
        const n = Math.ceil(dir.size / ISO_SECTOR);
        return parseDirectory(await this.source.readSectors(dir.lba, n), dir.size);
      })();
      p.catch(() => this.dirs.delete(dir.lba));
      this.dirs.set(dir.lba, p);
    }
    return p;
  }

  /** The entry at `path` ('' or '/' is the root), or null when any segment is missing. */
  async lookup(path: string): Promise<IsoEntry | null> {
    let cur = this.root;
    for (const seg of path.split(/[\\/]+/)) {
      if (seg === '' || seg === '.') continue;
      if (!cur.directory) return null;
      const want = isoCleanName(seg).toUpperCase();
      const hit = (await this.readDir(cur)).find((e) => e.name.toUpperCase() === want);
      if (!hit) return null;
      cur = hit;
    }
    return cur;
  }

  /** The entries of the directory at `path`; throws when it is not one. */
  async list(path: string): Promise<IsoEntry[]> {
    const e = await this.lookup(path);
    if (!e) throw new Error(`iso9660: not found: ${path}`);
    return this.readDir(e);
  }

  /** A file's bytes, or `length` bytes of it from `offset`. */
  async readFile(entry: IsoEntry, offset = 0, length = entry.size - offset): Promise<Uint8Array> {
    if (entry.directory) throw new Error(`iso9660: ${entry.name} is a directory`);
    if (offset < 0 || length < 0 || offset + length > entry.size) throw new Error(`iso9660: range ${offset}+${length} outside ${entry.name} (${entry.size} bytes)`);
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / ISO_SECTOR);
    const last = Math.floor((offset + length - 1) / ISO_SECTOR);
    const b = await this.source.readSectors(entry.lba + first, last - first + 1);
    const at = offset - first * ISO_SECTOR;
    return b.subarray(at, at + length);
  }

  /** The file at `path`; throws when it is missing or a directory. */
  async read(path: string): Promise<Uint8Array> {
    const e = await this.lookup(path);
    if (!e || e.directory) throw new Error(`iso9660: no file ${path}`);
    return this.readFile(e);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.lookup(path)) !== null;
  }

  /** Every entry under `dir` (the root by default), depth first, with its full path ('SMK/MINTRO.SMK'). */
  async walk(dir: IsoEntry = this.root, prefix = ''): Promise<{ path: string; entry: IsoEntry }[]> {
    const out: { path: string; entry: IsoEntry }[] = [];
    for (const e of await this.readDir(dir)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      out.push({ path: p, entry: e });
      if (e.directory) out.push(...(await this.walk(e, p)));
    }
    return out;
  }
}
