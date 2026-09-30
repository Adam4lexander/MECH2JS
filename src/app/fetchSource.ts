import type { InstallSource } from '../data/source/FileSource.ts';

/** Fetches from a URL prefix (default: the dev server's /mw2/ mount). */
export class FetchSource implements InstallSource {
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

  async readRange(name: string, start: number, end: number | null): Promise<Uint8Array> {
    const r = await fetch(this.base + name, { headers: { Range: `bytes=${start}-${end !== null ? end - 1 : ''}` } });
    if (!r.ok && r.status !== 206) throw new Error(`fetch ${this.base}${name}: ${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async list(dir: string): Promise<string[]> {
    const r = await fetch(`${this.base}__list/${dir}`);
    return r.ok ? ((await r.json()) as string[]) : [];
  }
}

/**
 * The dev server's install, or null when it has none: MW2_ROOT unset (the
 * mount answers 404), or no dev server at all (a static build, whose host
 * answers with a page or nothing). Then the player drops the install on the
 * page instead (app/InstallDrop.tsx).
 */
export async function serverInstall(): Promise<FetchSource | null> {
  try {
    const r = await fetch('/mw2/__list/');
    if (!r.ok || !(r.headers.get('Content-Type') ?? '').includes('application/json')) return null;
    const names = (await r.json()) as unknown;
    return Array.isArray(names) && names.some((n) => typeof n === 'string' && n.toUpperCase() === 'MW2.PRJ') ? new FetchSource('/mw2/') : null;
  } catch {
    return null;
  }
}
