/**
 * Where the game install and the decompilation live, for tools, tests and the
 * dev server. Both default to siblings of port/ and are overridable through
 * MW2_ROOT / MW2_DECOMPILED (see .env.example).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function mw2Root(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(PORT_DIR, env.MW2_ROOT ?? '..');
}

export function mw2Decompiled(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(PORT_DIR, env.MW2_DECOMPILED ?? '../decompiled');
}
