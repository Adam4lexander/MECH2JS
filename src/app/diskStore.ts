/**
 * The port's own files - everything MW2SHELL.EXE and MW2.EXE write (the
 * pilot registry, mw2prm.cfg, the cfg files, the star BWDs, user MEKs) -
 * kept in the browser's IndexedDB so a career survives a reload. The engine
 * sees them as the 'own' layer of engine/dosFiles.ts; this module restores
 * that layer at start-up and writes every change back.
 *
 * @portOnly the host's persistence for the virtual DOS disk
 */
import { setDiskPersistence, setOwnFiles } from '../engine/dosFiles.ts';
import { warn } from '../core/log.ts';

const DB = 'mw2-port';
const STORE = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let db: Promise<IDBDatabase> | null = null;

async function all(): Promise<Map<string, Uint8Array>> {
  const d = await (db ??= open());
  return new Promise((resolve, reject) => {
    const out = new Map<string, Uint8Array>();
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.set(String(c.key), new Uint8Array(c.value as ArrayBuffer));
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function put(key: string, bytes: Uint8Array | null): Promise<void> {
  const d = await (db ??= open());
  const tx = d.transaction(STORE, 'readwrite');
  const s = tx.objectStore(STORE);
  if (bytes) s.put(bytes.slice().buffer, key);
  else s.delete(key);
  // settles when the write is committed, so a failed save (quota, storage cleared) is reported
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/**
 * Restores the port's files into the disk and starts saving changes. When
 * IndexedDB is unavailable (a private window, blocked storage) the disk still
 * works, for this session only.
 */
export async function attachDiskStore(): Promise<Map<string, Uint8Array>> {
  let files = new Map<string, Uint8Array>();
  try {
    files = await all();
  } catch (e) {
    warn('disk', `IndexedDB unavailable, the port's files will not be kept: ${String(e)}`);
    setOwnFiles(files);
    return files;
  }
  setOwnFiles(files);
  setDiskPersistence((key, bytes) => {
    put(key, bytes).catch((e: unknown) => warn('disk', `could not save ${key}: ${String(e)}`));
  });
  return files;
}
