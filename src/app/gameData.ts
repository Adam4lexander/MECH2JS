/**
 * Everything the port reads from the install, fetched once: MW2.PRJ, MW2.EXE,
 * MW2.INI and the loose files beside them that are settings and drivers - the
 * input maps, MW2SND.CFG and the GIDDI input drivers.
 *
 * NOT the player's data the shell leaves there - the star BWD files
 * (USERSTAR, EN01..05STAR, INSTMAP1) and the mech lab's MEK\ variants: the
 * port builds the player's star from its own mission setup (userStar.ts), and
 * a mission that wants what only the shell sets up is not offered.
 */
import { ExeImage } from '../data/exe/ExeImage.ts';
import { IniFile } from '../data/config/ini.ts';
import { ProjectFile, readNameTable, TABL } from '../data/prj/ProjectFile.ts';
import { FetchSource } from './fetchSource.ts';
import { walkStream } from '../data/bwd/stream.ts';

export interface GameData {
  prj: ProjectFile;
  exe: ExeImage;
  ini: IniFile;
  /** loose files by upper-case name ('INPUT.MAP', 'GIDDI/KEYBOARD.DLL') */
  loose: Map<string, Uint8Array>;
  /** the game CD's cue sheet, when its image is in the install (the music) */
  cue: { name: string; text: string } | null;
}

export interface MissionEntry {
  /** the SCN1 stream name, e.g. AMY_SCN1 */
  stream: string;
  /** the prefix naming the mission's other streams, e.g. AMY_ */
  prefix: string;
  id: number;
  /** a briefing stream (…BRF1) exists for it */
  hasBriefing: boolean;
  /** the loose files its streams include (INCL id -2), e.g. 'USERSTAR.BWD' */
  loose: string[];
  /** 'ready' needs none; 'star' needs only the player's star; 'opponents' needs files only the shell sets up */
  needs: 'ready' | 'star' | 'opponents';
}

async function listDir(dir: string): Promise<string[]> {
  const r = await fetch(`/mw2/__list/${dir}`);
  return r.ok ? ((await r.json()) as string[]) : [];
}

export async function loadGameData(progress: (msg: string) => void = () => {}): Promise<GameData> {
  const src = new FetchSource('/mw2/');
  progress('MW2.PRJ');
  const prj = new ProjectFile(await src.read('MW2.PRJ'));
  progress('MW2.EXE');
  const exe = ExeImage.fromExe(await src.read('MW2.EXE'));
  progress('MW2.INI');
  let ini = new IniFile(null);
  try {
    ini = new IniFile(await src.read('MW2.INI'));
  } catch {
    /* the INI only supplies error texts */
  }
  const loose = new Map<string, Uint8Array>();
  const names = [
    ...(await listDir('')).filter((n) => /\.MAP$/i.test(n) || /^MW2SND\.CFG$/i.test(n)),
    ...(await listDir('GIDDI')),
  ];
  for (const n of names) {
    progress(n);
    loose.set(n.toUpperCase(), await src.read(n));
  }
  let cue: GameData['cue'] = null;
  const cueName = (await listDir('')).find((n) => /\.CUE$/i.test(n));
  if (cueName) cue = { name: cueName, text: new TextDecoder().decode(await src.read(cueName)) };
  return { prj, exe, ini, loose, cue };
}

/**
 * The loose files a stream includes, following its INCLs through MW2.PRJ: an
 * id -2 INCL names a loose file ('.BWD' appended, as project_open_stream
 * does), id -1 a stream by name, any other id a BWD resource.
 */
function looseIncludes(prj: ProjectFile, byName: Map<string, number>, id: number, seen: Set<number>, out: Set<string>): void {
  if (id < 0 || seen.has(id)) return;
  seen.add(id);
  const bytes = prj.readResource('BWD', id);
  if (!bytes) return;
  for (const c of walkStream(bytes)) {
    if (c.tag !== 'INCL') continue;
    const ref = c.i16(8);
    const name = c.str(0xa, 12).toUpperCase();
    if (ref === -2) out.add(name.includes('.') ? name : `${name}.BWD`);
    else looseIncludes(prj, byName, ref === -1 ? (byName.get(name) ?? -1) : ref, seen, out);
  }
}

/** Every mission: the BWD streams whose name ends SCN1, from BWDTABLE, with the loose files each needs. */
export function missionCatalog(prj: ProjectFile): MissionEntry[] {
  const all = readNameTable(prj, TABL.BWD);
  const names = new Set(all.map((e) => e.name.toUpperCase()));
  const byName = new Map(all.map((e) => [e.name.toUpperCase(), e.id] as const));
  return all
    .filter((e) => /SCN1$/i.test(e.name))
    .map((e): MissionEntry => {
      const prefix = e.name.toUpperCase().replace(/SCN1$/, '');
      const inc = new Set<string>();
      looseIncludes(prj, byName, e.id, new Set(), inc);
      const loose = [...inc].sort();
      const needs = loose.length === 0 ? 'ready' : loose.every((n) => n === 'USERSTAR.BWD') ? 'star' : 'opponents';
      return { stream: e.name.toUpperCase(), prefix, id: e.id, hasBriefing: names.has(prefix + 'BRF1'), loose, needs };
    })
    .sort((a, b) => a.stream.localeCompare(b.stream));
}
