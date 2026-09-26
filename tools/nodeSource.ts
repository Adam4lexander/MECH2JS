/**
 * FileSource over the local filesystem, for tests and node tools. Lookups are
 * case-insensitive, as they were under DOS.
 */
import fs from 'node:fs';
import type { FileSource } from '../src/data/source/FileSource.ts';
import { resolveCaseInsensitive } from './vite-plugin-mw2-data.ts';

export class NodeFsSource implements FileSource {
  constructor(readonly root: string) {}

  async read(name: string): Promise<Uint8Array> {
    const bytes = this.readSync(name);
    if (!bytes) throw new Error(`not found under ${this.root}: ${name}`);
    return bytes;
  }

  async exists(name: string): Promise<boolean> {
    return resolveCaseInsensitive(this.root, name) !== null;
  }

  readSync(name: string): Uint8Array | null {
    const p = resolveCaseInsensitive(this.root, name);
    if (!p) return null;
    const b = fs.readFileSync(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
}
