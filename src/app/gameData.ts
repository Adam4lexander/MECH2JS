/**
 * Everything the port reads from the install, fetched once: MW2.PRJ, MW2.EXE,
 * MW2.INI and the loose files beside them (the per-star BWD files the shell
 * writes, and the user mech variants in MEK\).
 */
import { ExeImage } from '../data/exe/ExeImage.ts';
import { IniFile } from '../data/config/ini.ts';
import { ProjectFile, readNameTable, TABL } from '../data/prj/ProjectFile.ts';
import { FetchSource } from './fetchSource.ts';

export interface GameData {
  prj: ProjectFile;
  exe: ExeImage;
  ini: IniFile;
  /** loose files by upper-case name ('USERSTAR.BWD', 'MEK/MDG00USR.MEK') */
  loose: Map<string, Uint8Array>;
}

export interface MissionEntry {
  /** the SCN1 stream name, e.g. AMY_SCN1 */
  stream: string;
  /** the prefix naming the mission's other streams, e.g. AMY_ */
  prefix: string;
  id: number;
  /** a briefing stream (…BRF1) exists for it */
  hasBriefing: boolean;
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
  const names = [...(await listDir('')).filter((n) => /\.BWD$/i.test(n)), ...(await listDir('MEK'))];
  for (const n of names) {
    progress(n);
    loose.set(n.toUpperCase(), await src.read(n));
  }
  return { prj, exe, ini, loose };
}

/** Every mission: the BWD streams whose name ends SCN1, from BWDTABLE. */
export function missionCatalog(prj: ProjectFile): MissionEntry[] {
  const all = readNameTable(prj, TABL.BWD);
  const names = new Set(all.map((e) => e.name.toUpperCase()));
  return all
    .filter((e) => /SCN1$/i.test(e.name))
    .map((e) => {
      const prefix = e.name.toUpperCase().replace(/SCN1$/, '');
      return { stream: e.name.toUpperCase(), prefix, id: e.id, hasBriefing: names.has(prefix + 'BRF1') };
    })
    .sort((a, b) => a.stream.localeCompare(b.stream));
}
