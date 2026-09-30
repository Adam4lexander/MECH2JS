/**
 * Which of the install's files the port reads: the game's content, never the
 * files the programs write. The install's config and player files (the star
 * BWDs, MW2*.CFG, MEK\ variants) and its controls files (INPUT.MAP,
 * GAMEKEY.MAP and the other *.MAP, GIDDI\*.CPC) are left out: the port writes
 * its own (engine/dosFiles.ts, app/diskStore.ts, shell/controls/seed.ts).
 * The dev server serves these names alone (tools/vite-plugin-mw2-data.ts),
 * and a folder dropped on the page is indexed by them (app/droppedInstall.ts).
 *
 * Paths are relative to the install directory (the one holding MW2.PRJ),
 * '/'-separated, and matched ignoring case, as DOS did.
 *
 * @portOnly the host's view of the install
 */
export const INSTALL_WHITELIST: readonly RegExp[] = [
  /^MW2\.PRJ$/i,
  /^MW2\.EXE$/i,
  /^MW2SHELL\.EXE$/i,
  /^(DATABASE|ARCHWO|ARCHJF)\.MW2$/i,
  /^MW2\.INI$/i,
  /^GIDDI\/[A-Z0-9_]+\.(DLL|STD|CAL)$/i,
  // the two pictures MW2.EXE's fifth cheat code shows (cheat_credits_render_hook)
  /^VFX\/VFX(JK|HD)\.BIN$/i,
  // the game CD's image: its audio tracks are the mission music (read by byte range)
  /^[A-Z0-9_]+\.(CUE|BIN)$/i,
  // or the CD's files, copied off it into the install (a ripped CD): the directories the programs read from X:\
  /^SMK\/[A-Z0-9_]+\.(SMK|SHP)$/i,
  /^LAUNCH\/[A-Z0-9_]+\.SHP$/i,
  /^KEATING\/[A-Z0-9_]+\.SFL$/i,
];

/** The files without which there is no game: the project and the two programs. */
export const INSTALL_REQUIRED: readonly string[] = ['MW2.PRJ', 'MW2.EXE', 'MW2SHELL.EXE'];

export function isInstallFile(rel: string): boolean {
  return INSTALL_WHITELIST.some((re) => re.test(rel));
}

/**
 * The install inside a dropped folder: the shallowest directory holding
 * MW2.PRJ ('' when the files themselves were dropped, 'MECH2/' for a folder),
 * and its whitelisted files by upper-case path relative to it
 * ('GIDDI/KEYBOARD.DLL'). Null when no MW2.PRJ is there.
 */
export function indexInstall<T>(files: Iterable<readonly [path: string, file: T]>): { root: string; files: Map<string, T> } | null {
  const all = [...files];
  let root: string | null = null;
  for (const [p] of all) {
    const m = /^(.*\/)?MW2\.PRJ$/i.exec(p);
    if (!m) continue;
    const dir = m[1] ?? '';
    if (root === null || dir.split('/').length < root.split('/').length) root = dir;
  }
  if (root === null) return null;
  const lower = root.toLowerCase();
  const out = new Map<string, T>();
  for (const [p, f] of all) {
    if (!p.toLowerCase().startsWith(lower)) continue;
    const rel = p.slice(root.length);
    if (isInstallFile(rel)) out.set(rel.toUpperCase(), f);
  }
  return { root, files: out };
}

/** The files of one directory of an index ('' for the root), as 'DIR/NAME' paths - the dev server's /mw2/__list. */
export function listInstallDir(files: Iterable<string>, dir: string): string[] {
  const prefix = dir === '' ? '' : `${dir.toUpperCase().replace(/\/+$/, '')}/`;
  return [...files].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
}
