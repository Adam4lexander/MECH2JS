import type { FileSource } from '../data/source/FileSource.ts';

/** Fetches from a URL prefix (default: the dev server's /mw2/ mount). */
export class FetchSource implements FileSource {
  constructor(readonly base = '/mw2/') {}

  async read(name: string): Promise<Uint8Array> {
    const r = await fetch(this.base + name);
    if (!r.ok) throw new Error(`fetch ${this.base}${name}: ${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async exists(name: string): Promise<boolean> {
    const r = await fetch(this.base + name, { method: 'HEAD' });
    return r.ok;
  }
}
