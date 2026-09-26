/**
 * Where golden tests find their inputs. Suites that need the game install or
 * the decompilation skip - loudly, naming what is missing - when it is absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mw2Decompiled, mw2Root } from '../../tools/paths.ts';
import { NodeFsSource } from '../../tools/nodeSource.ts';

export const MW2_ROOT = mw2Root();
export const MW2_DECOMPILED = mw2Decompiled();

export const hasGameData = fs.existsSync(path.join(MW2_ROOT, 'MW2.PRJ')) && fs.existsSync(path.join(MW2_ROOT, 'MW2.EXE'));
export const hasDecompiled = fs.existsSync(path.join(MW2_DECOMPILED, 'mw2', 'listing'));

export const gameSource = (): NodeFsSource => new NodeFsSource(MW2_ROOT);

/**
 * The install's loose files as the port reads them (upper-case keys, '/'
 * separators): the star BWDs, MEK\ variants, the input maps and the GIDDI
 * drivers - what app/gameData.ts fetches.
 */
export function installFiles(): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  const add = (dir: string, re: RegExp) => {
    const d = path.join(MW2_ROOT, dir);
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) if (re.test(f)) m.set((dir ? dir + '/' : '') + f.toUpperCase(), new Uint8Array(fs.readFileSync(path.join(d, f))));
  };
  add('', /\.(BWD|MAP)$/i);
  add('MEK', /\.MEK$/i);
  add('GIDDI', /\.(DLL|STD|CAL)$/i);
  return m;
}

export function listingPath(name: string): string {
  return path.join(MW2_DECOMPILED, 'mw2', 'listing', name);
}

export function readListing(name: string): string {
  return fs.readFileSync(listingPath(name), 'utf8').replace(/\r\n/g, '\n');
}

export function buildPath(name: string): string {
  return path.join(MW2_DECOMPILED, 'mw2', 'build', name);
}

export function skipReason(): string {
  const miss: string[] = [];
  if (!hasGameData) miss.push(`game data (MW2.PRJ + MW2.EXE) under MW2_ROOT=${MW2_ROOT}`);
  if (!hasDecompiled) miss.push(`decompilation listings under MW2_DECOMPILED=${MW2_DECOMPILED}`);
  return miss.join('; ');
}

if (!hasGameData || !hasDecompiled) {
  console.warn(`[golden] SKIPPING suites that need: ${skipReason()}`);
}
