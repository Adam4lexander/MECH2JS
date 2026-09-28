/**
 * Where the game install and the decompilation live, for tools, tests and the
 * dev server: MW2_ROOT and MW2_DECOMPILED, from the environment or from this
 * repo's .env.local / .env. There are no defaults - the port is its own repo,
 * and neither lives beside it. .env.example has MW2_ROOT alone: the
 * decompilation is not public, and only the maintainer sets MW2_DECOMPILED
 * (docs/porting-notes.md).
 *
 * The files are loaded here, on import, so every entry point - vite, vitest,
 * the gen scripts - sees the same values. A variable already in the
 * environment wins over both files, and .env.local over .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// process.loadEnvFile never overrides a variable that is already set, so the
// first file loaded wins: .env.local, then .env
for (const name of ['.env.local', '.env']) {
  const file = path.join(PORT_DIR, name);
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

type Env = Record<string, string | undefined>;

function configured(env: Env, name: string): string | null {
  const v = env[name]?.trim();
  return v ? path.resolve(PORT_DIR, v) : null;
}

/** The game install (MW2.PRJ, MW2.EXE, MW2SHELL.EXE, the archives, GIDDI, the CD image), or null when unset. */
export function mw2Root(env: Env = process.env): string | null {
  return configured(env, 'MW2_ROOT');
}

/** The decompilation (the mw2-decompiled repo's decompiled/ directory), or null when unset. */
export function mw2Decompiled(env: Env = process.env): string | null {
  return configured(env, 'MW2_DECOMPILED');
}

/** The message for an unset path, naming the variable and the file to set it in. */
export function unsetMessage(name: 'MW2_ROOT' | 'MW2_DECOMPILED'): string {
  if (name === 'MW2_DECOMPILED') return `MW2_DECOMPILED is not set: the decompilation's decompiled/ directory, in .env.local in ${PORT_DIR}`;
  return `${name} is not set: copy .env.example to .env.local in ${PORT_DIR} and set it`;
}

/** For tools that cannot run without the decompilation: its path, or exit saying what to set. */
export function requireDecompiled(): string {
  const d = mw2Decompiled();
  if (!d) {
    console.error(unsetMessage('MW2_DECOMPILED'));
    process.exit(1);
  }
  return d;
}
