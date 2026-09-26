/**
 * Loose files the gamepiece loaders read before (MEK) or instead of (an
 * MGEO '.mgi') a resource in MW2.PRJ - the user variants in MEK\*.MEK above
 * all. The loaders run synchronously inside the mission interpreter, as
 * res_load_file does, so the source must answer synchronously: NodeFsSource
 * (tools/nodeSource.ts) does, and a Map of pre-read files does.
 *
 * Names are the game's own ('mek\mdg00usr.mek'); they are matched
 * case-insensitively with '\' read as '/'.
 */
import { log } from '../../core/log.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage } from '../../engine/image.ts';

/** A synchronous loose-file lookup: the file's bytes, or null if there is none. */
export interface LooseFileReader {
  readSync(name: string): Uint8Array | null;
}

let source: LooseFileReader | null = null;

/**
 * Where res_load_file finds loose files: a reader (NodeFsSource), a map of
 * pre-read files keyed by name (any case, '\' or '/'), or null for none - then
 * every loose load fails and the loaders use MW2.PRJ.
 *
 * @portOnly
 */
export function setMekSource(src: LooseFileReader | Map<string, Uint8Array> | null): void {
  if (src instanceof Map) {
    const byKey = new Map<string, Uint8Array>();
    for (const [k, v] of src) byKey.set(looseKey(k), v);
    source = { readSync: (name) => byKey.get(looseKey(name)) ?? null };
  } else source = src;
}

const looseKey = (name: string): string => name.replace(/\\/g, '/').toUpperCase();

export const looseFiles = registerGlobals(
  'looseFiles',
  {
    /**
     * 0x9ea24: a directory prefixed to bare file names by
     * screenshot_sub_04c4b0 when non-empty. Empty in the image; what sets it
     * is not established.
     */
    DAT_0009ea24: '',
  },
  () => {
    const img = bootImage();
    let s = '';
    if (img) for (let a = 0x9ea24; img.u8(a) !== 0 && s.length < 0x50; a++) s += String.fromCharCode(img.u8(a));
    looseFiles.DAT_0009ea24 = s;
  },
);

/**
 * The path a loose file is opened by: the name itself, or DAT_0009ea24 +
 * '\' + name when that directory is set and the name has no '\' or '/'.
 * The result goes to a static 0x50-byte buffer (0x1534f0).
 *
 * @mw2 screenshot_sub_04c4b0 0x0004c4b0
 * @fidelity exact
 */
export function screenshotSub04c4b0(name: string): string {
  const dir = looseFiles.DAT_0009ea24;
  if (dir !== '' && !name.includes('\\') && !name.includes('/')) return `${dir}\\${name}`;
  return name;
}

/**
 * Reads a whole loose file: its bytes, or null (logging "Couldn't load
 * ID=%s" to symlog.txt) when it cannot be opened.
 *
 * @mw2 res_load_file 0x0004c170
 * @fidelity partial
 * @divergence no file handle is returned or closed, and no arena: the caller gets the bytes; the failure line goes to the log channel 'symlog' rather than symlog.txt
 */
export function resLoadFile(name: string): Uint8Array | null {
  const bytes = source ? source.readSync(name.replace(/\\/g, '/')) : null;
  if (!bytes) {
    log('symlog', `Couldn't load ID=${name}`);
    return null;
  }
  return bytes;
}
