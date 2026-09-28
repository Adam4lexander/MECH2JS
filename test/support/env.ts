/**
 * Where golden tests find their inputs. Suites that need the game install or
 * the decompilation skip - loudly, naming what is missing - when it is absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mw2Decompiled, mw2Root } from '../../tools/paths.ts';
import { NodeFsSource } from '../../tools/nodeSource.ts';
import type { MechChoice } from '../../src/data/catalog/mechs.ts';
import { buildEmptyStar, buildUserStar, type StarSetup } from '../../src/data/config/userStar.ts';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { dosFiles, setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { seedControlFiles } from '../../src/shell/controls/seed.ts';
import { instmapWrite } from '../../src/shell/handoff/starFiles.ts';

// An unset path (no MW2_ROOT / MW2_DECOMPILED in .env.local) becomes a
// placeholder that exists nowhere, so every has* below is false and the
// suites' skip messages name the variable to set.
export const MW2_ROOT = mw2Root() ?? '<MW2_ROOT unset: see .env.example>';
export const MW2_DECOMPILED = mw2Decompiled() ?? '<MW2_DECOMPILED unset: see .env.example>';

export const hasGameData = fs.existsSync(path.join(MW2_ROOT, 'MW2.PRJ')) && fs.existsSync(path.join(MW2_ROOT, 'MW2.EXE'));
export const hasDecompiled = fs.existsSync(path.join(MW2_DECOMPILED, 'mw2', 'listing'));

export const gameSource = (): NodeFsSource => new NodeFsSource(MW2_ROOT);

/**
 * The star the install's USERSTAR.BWD held when the tests were written - a
 * Mad Dog (mdg00std, MEK 62, piece stream 29 'maddog') piloted by 'ADAM'
 * with one Mad Dog starmate 'Friend 1' - which the sim tests play with.
 * test/sim/missionSetup.test.ts checks buildUserStar reproduces that file.
 */
export const TEST_STAR: StarSetup = (() => {
  const madDog: MechChoice = { config: 'mdg00std', mekId: 62, stream: { id: 29, name: 'maddog' }, tons: 60 };
  return { pilot: { name: 'ADAM', mech: madDog }, starmates: [{ name: 'Friend 1', mech: madDog }] };
})();

/**
 * The loose files a mission reads (upper-case keys, '/' separators), as the
 * app has them on a first run - nothing a player saved, so every install
 * gives the same disk: the GIDDI drivers (content, what app/gameData.ts
 * fetches), the files the port writes for itself (firstRunFiles), and the
 * player's star built from `star` (as Game.loadMission does). No
 * MW2SND.CFG: the shell writes one only when the options screen is saved,
 * and without it MW2.EXE keeps its defaults. For tests of every mission,
 * the opponent stars the shell would write are supplied empty.
 */
export function installFiles(star: StarSetup = TEST_STAR): Map<string, Uint8Array> {
  const m = giddiDrivers();
  for (const [k, v] of firstRunFiles(m)) m.set(k, v);
  m.set('USERSTAR.BWD', buildUserStar(star));
  for (let i = 1; i <= 5; i++) m.set(`EN0${i}STAR.BWD`, buildEmptyStar());
  return m;
}

/** The install's GIDDI input drivers (.DLL, .STD, .CAL), keyed 'GIDDI/<NAME>'. */
function giddiDrivers(): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  const d = path.join(MW2_ROOT, 'GIDDI');
  if (!fs.existsSync(d)) return m;
  for (const f of fs.readdirSync(d)) if (/\.(DLL|STD|CAL)$/i.test(f)) m.set(`GIDDI/${f.toUpperCase()}`, new Uint8Array(fs.readFileSync(path.join(d, f))));
  return m;
}

let firstRun: Map<string, Uint8Array> | null = null;

/**
 * What the port writes for itself before a first mission, made once on a
 * scratch disk (the disk's layers are put back after): the controls files
 * (shell/controls/seed.ts - INPUT.MAP, GAMEKEY.MAP, giddi\*.cpc) and
 * INSTMAP1.BWD as the grievance screen's default pair writes it
 * (instmap_write(Wolf, Jade Falcon), as the dev launch does).
 */
function firstRunFiles(giddi: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (firstRun) return firstRun;
  const saved = { files: dosFiles.files, own: dosFiles.own, overlay: dosFiles.overlay };
  try {
    setDosFiles(giddi);
    setOwnFiles(new Map());
    setOverlayFiles(null);
    const shellExe = ExeImage.fromExe(new Uint8Array(fs.readFileSync(path.join(MW2_ROOT, 'MW2SHELL.EXE'))));
    seedControlFiles(shellExe);
    // instmap_write names its bitmaps from MW2.PRJ: the shell process, started as the dev launch starts it
    startShellProcess(shellExe, new ProjectFile(new Uint8Array(fs.readFileSync(path.join(MW2_ROOT, 'MW2.PRJ')))));
    instmapWrite(0, 1);
    firstRun = new Map(dosFiles.own);
  } finally {
    dosFiles.files = saved.files;
    dosFiles.own = saved.own;
    dosFiles.overlay = saved.overlay;
  }
  return firstRun;
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

// ---- the front end (MW2SHELL.EXE) ----

/** The shell's executable and its main asset archive. */
export const hasShellData = fs.existsSync(path.join(MW2_ROOT, 'MW2SHELL.EXE')) && fs.existsSync(path.join(MW2_ROOT, 'DATABASE.MW2'));
export const hasShellDecompiled = fs.existsSync(path.join(MW2_DECOMPILED, 'mw2shell', 'listing'));
/** The CD image the movies and most screen animations live on. */
export const hasCdImage = fs.existsSync(path.join(MW2_ROOT, 'MECH2_16B.BIN')) && fs.existsSync(path.join(MW2_ROOT, 'MECH2_16B.CUE'));
/** The CD's files copied into the install instead (a ripped CD): LAUNCH\ and KEATING\ (a rip may leave the Smacker files out). */
export const hasCdFiles = ['LAUNCH', 'KEATING'].every((d) => fs.existsSync(path.join(MW2_ROOT, d)));
/** The CD either way, as the CD drive reads it (openCd). */
export const hasCd = hasCdImage || hasCdFiles;

export function shellListingPath(name: string): string {
  return path.join(MW2_DECOMPILED, 'mw2shell', 'listing', name);
}

export function readShellListing(name: string): string {
  return fs.readFileSync(shellListingPath(name), 'utf8').replace(/\r\n/g, '\n');
}

export function shellBuildPath(name: string): string {
  return path.join(MW2_DECOMPILED, 'mw2shell', 'build', name);
}

/**
 * Files the shell wrote into the install (MW2PRM.CFG, MW2REG.CFG, the star
 * BWDs, INSTMAP1.BWD, MEK\*USR.MEK, INPUT.MAP...), read as the EXPECTED
 * output of the ported writers. Tests only: at run time the port never reads
 * the install's config or player files - it keeps its own. Keys are
 * upper-case with '/' separators; a name that is absent is left out.
 */
export function installShellFixtures(names: readonly string[]): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const n of names) {
    const [dir, file] = n.includes('/') ? [n.slice(0, n.lastIndexOf('/')), n.slice(n.lastIndexOf('/') + 1)] : ['', n];
    const d = path.join(MW2_ROOT, dir);
    if (!fs.existsSync(d)) continue;
    const re = new RegExp('^' + file.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    for (const f of fs.readdirSync(d)) if (re.test(f)) m.set((dir ? dir.toUpperCase() + '/' : '') + f.toUpperCase(), new Uint8Array(fs.readFileSync(path.join(d, f))));
  }
  return m;
}

export function skipReason(): string {
  const miss: string[] = [];
  if (!hasGameData) miss.push(`game data (MW2.PRJ + MW2.EXE) under MW2_ROOT=${MW2_ROOT}`);
  if (!hasDecompiled) miss.push(`decompilation listings under MW2_DECOMPILED=${MW2_DECOMPILED}`);
  return miss.join('; ');
}

export function shellSkipReason(): string {
  const miss: string[] = [];
  if (!hasShellData) miss.push(`the front end (MW2SHELL.EXE + DATABASE.MW2) under MW2_ROOT=${MW2_ROOT}`);
  if (!hasShellDecompiled) miss.push(`the shell's decompilation listings under MW2_DECOMPILED=${MW2_DECOMPILED}`);
  return miss.join('; ');
}

if (!hasGameData || !hasDecompiled) {
  console.warn(`[golden] SKIPPING suites that need: ${skipReason()}`);
}
if (!hasShellData || !hasShellDecompiled) {
  console.warn(`[golden] SKIPPING shell suites that need: ${shellSkipReason()}`);
}
