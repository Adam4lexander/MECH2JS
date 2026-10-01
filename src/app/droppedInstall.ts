/**
 * The install from a folder the player drops on the page (or picks), for when
 * the dev server has none (MW2_ROOT unset) or there is no dev server at all.
 * The files stay on the player's disk: the browser reads each as the game
 * asks for it, the CD image by byte range. Only the install's content is
 * indexed (data/source/installFiles.ts), never its config or player files.
 *
 * Where the browser has the File System Access API (Chromium), the install
 * directory's handle is kept in IndexedDB, so a reload finds the folder
 * again - with the player's leave, which the browser may ask for once more.
 * Elsewhere the folder is dropped again after a reload.
 *
 * @portOnly the host's access to the install
 */
import type { InstallSource } from '../data/source/FileSource.ts';
import { indexInstall, INSTALL_REQUIRED, listInstallDir } from '../data/source/installFiles.ts';
import { warn } from '../core/log.ts';

type Opener = () => Promise<File>;
type Walked = [path: string, open: Opener][];

/** How many directories deep under what was dropped the install (MW2.PRJ) and its own directories are looked for. */
const MAX_DEPTH = 3;

// Parts of the File System Access API the DOM lib leaves out (Chromium only).
type ReadPermission = { mode: 'read' };
type PermissionedHandle = FileSystemHandle & {
  queryPermission?(d: ReadPermission): Promise<PermissionState>;
  requestPermission?(d: ReadPermission): Promise<PermissionState>;
};
type HandleItem = DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };
type PickerWindow = Window & { showDirectoryPicker?(o: { id?: string; mode?: 'read' }): Promise<FileSystemDirectoryHandle> };

const upper = (name: string) => name.replace(/\\/g, '/').toUpperCase();

export class DroppedInstall implements InstallSource {
  private opened = new Map<string, Promise<File>>();

  /** `files`: the install's files by upper-case path relative to it ('GIDDI/KEYBOARD.DLL') */
  constructor(
    readonly name: string,
    private readonly files: Map<string, Opener>,
  ) {}

  private open(name: string): Promise<File> {
    const key = upper(name);
    let f = this.opened.get(key);
    if (!f) {
      const opener = this.files.get(key);
      if (!opener) return Promise.reject(new Error(`${name} is not in ${this.name}`));
      f = opener();
      this.opened.set(key, f);
      // a file that could not be opened is tried again next time rather than kept
      f.catch(() => this.opened.delete(key));
    }
    return f;
  }

  async read(name: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.open(name)).arrayBuffer());
  }

  async exists(name: string): Promise<boolean> {
    return this.files.has(upper(name));
  }

  async readRange(name: string, start: number, end: number | null): Promise<Uint8Array> {
    const f = await this.open(name);
    return new Uint8Array(await f.slice(start, end ?? undefined).arrayBuffer());
  }

  async list(dir: string): Promise<string[]> {
    return listInstallDir(this.files.keys(), dir);
  }
}

/** The install in what was walked, and the directory it is in ('' when loose files were dropped); throws saying what is missing. */
function fromWalked(label: string, walked: Walked): { install: DroppedInstall; root: string } {
  const index = indexInstall(walked);
  if (!index) throw new Error(`There is no MW2.PRJ in ${label}. Drop the MechWarrior 2 install folder - the one holding MW2.PRJ and MW2.EXE.`);
  const missing = INSTALL_REQUIRED.filter((n) => !index.files.has(n));
  if (missing.length > 0) throw new Error(`${label} has MW2.PRJ but no ${missing.join(' or ')}.`);
  const name = index.root.replace(/\/$/, '').split('/').pop() || label;
  return { install: new DroppedInstall(name, index.files), root: index.root };
}

async function walkHandle(dir: FileSystemDirectoryHandle, prefix: string, depth: number, out: Walked, dirs: Map<string, FileSystemDirectoryHandle>): Promise<void> {
  dirs.set(prefix, dir);
  for await (const h of dir.values()) {
    if (h.kind === 'file') out.push([prefix + h.name, () => (h as FileSystemFileHandle).getFile()]);
    else if (depth < MAX_DEPTH) await walkHandle(h as FileSystemDirectoryHandle, `${prefix}${h.name}/`, depth + 1, out, dirs);
  }
}

async function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries answers in batches, and an empty one at the end
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walkEntry(e: FileSystemEntry, prefix: string, depth: number, out: Walked): Promise<void> {
  if (e.isFile) out.push([prefix + e.name, () => new Promise<File>((resolve, reject) => (e as FileSystemFileEntry).file(resolve, reject))]);
  else if (e.isDirectory && depth <= MAX_DEPTH) for (const c of await readEntries(e as FileSystemDirectoryEntry)) await walkEntry(c, `${prefix}${e.name}/`, depth + 1, out);
}

// The remembered install directory, in its own database (app/diskStore.ts's holds the port's files).
const DB = 'mw2-port-install';
const STORE = 'handles';
const KEY = 'install';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function remember(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const tx = (await db()).transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(dir, KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn('install', `the folder will not be remembered: ${String(e)}`);
  }
}

/** The install directory dropped or picked before, when the browser kept it. */
export async function rememberedInstall(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const req = (await db()).transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    return await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result instanceof FileSystemDirectoryHandle ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function fromDirectory(dir: FileSystemDirectoryHandle): Promise<DroppedInstall> {
  const walked: Walked = [];
  const dirs = new Map<string, FileSystemDirectoryHandle>();
  await walkHandle(dir, `${dir.name}/`, 0, walked, dirs);
  const { install, root } = fromWalked(dir.name, walked);
  const home = dirs.get(root);
  if (home) await remember(home);
  return install;
}

/**
 * The remembered install again. Without `ask`, only when the browser still
 * lets the page read it (null otherwise); with `ask` - inside a click - the
 * browser asks the player, and a refusal throws.
 */
export async function reopenInstall(dir: FileSystemDirectoryHandle, ask: boolean): Promise<DroppedInstall | null> {
  const h = dir as PermissionedHandle;
  let state = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
  if (state !== 'granted' && ask) state = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
  if (state !== 'granted') {
    if (ask) throw new Error(`The browser may not read ${dir.name}.`);
    return null;
  }
  return fromDirectory(dir);
}

/**
 * The install in what was dropped: a folder holding it (at most a few
 * directories down), or its files themselves. The drop's items are taken
 * now - they are gone once the event is over - and read after.
 */
export function installFromDrop(dt: DataTransfer): Promise<DroppedInstall> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const handles = items.map((i) => (i as HandleItem).getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null));
  const entries = items.map((i) => i.webkitGetAsEntry());
  const files = [...dt.files];
  return (async () => {
    const hs = await Promise.all(handles);
    const label = hs[0]?.name ?? entries[0]?.name ?? files[0]?.name ?? 'the dropped files';
    if (hs.length > 0 && hs.every((h) => h !== null)) {
      // one folder: its handle is what a reload reopens
      if (hs.length === 1 && hs[0]!.kind === 'directory') return fromDirectory(hs[0] as FileSystemDirectoryHandle);
      const walked: Walked = [];
      const dirs = new Map<string, FileSystemDirectoryHandle>();
      for (const h of hs) {
        if (h!.kind === 'file') walked.push([h!.name, () => (h as FileSystemFileHandle).getFile()]);
        else await walkHandle(h as FileSystemDirectoryHandle, `${h!.name}/`, 0, walked, dirs);
      }
      return fromWalked(hs.length === 1 ? label : 'the dropped files', walked).install;
    }
    const walked: Walked = [];
    if (entries.some((e) => e !== null)) {
      for (const e of entries) if (e) await walkEntry(e, '', 0, walked);
    } else {
      for (const f of files) walked.push([f.name, async () => f]);
    }
    return fromWalked(items.length === 1 ? label : 'the dropped files', walked).install;
  })();
}

/** Whether the browser has a folder picker whose choice a reload can reopen (Chromium). */
export function canPickDirectory(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/** The install in a folder the player picks; null when they cancel. */
export async function installFromPicker(): Promise<DroppedInstall | null> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (window as PickerWindow).showDirectoryPicker!({ id: 'mw2-install', mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
  return fromDirectory(dir);
}

/** The install in a folder picked through a directory input (browsers without the picker): its files, with their paths. */
export async function installFromFiles(files: FileList): Promise<DroppedInstall> {
  const all = [...files];
  const label = all[0]?.webkitRelativePath.split('/')[0] || 'the chosen folder';
  return fromWalked(label, all.map((f): [string, Opener] => [f.webkitRelativePath || f.name, async () => f])).install;
}
