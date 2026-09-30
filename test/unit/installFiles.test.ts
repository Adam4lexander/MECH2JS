import { describe, expect, it } from 'vitest';
import { indexInstall, listInstallDir } from '../../src/data/source/installFiles.ts';

const paths = (ps: string[]) => ps.map((p) => [p, p] as const);

describe('a dropped install', () => {
  it('is the shallowest folder holding MW2.PRJ, with its content and none of its saved files', () => {
    const index = indexInstall(
      paths([
        'games/readme.txt',
        'games/mech2/mw2.prj',
        'games/mech2/MW2.EXE',
        'games/mech2/mw2shell.exe',
        'games/mech2/Database.mw2',
        'games/mech2/MECH2_16B.BIN',
        'games/mech2/mech2_16b.cue',
        'games/mech2/giddi/keyboard.dll',
        'games/mech2/giddi/config00.cpc',
        'games/mech2/userstar.bwd',
        'games/mech2/mw2reg.cfg',
        'games/mech2/input.map',
        'games/mech2/mek/mdg00usr.mek',
        'games/mech2/smk/mintro.smk',
        'games/mech2/backup/mw2.prj',
        'games/mech2/backup/mw2.exe',
      ]),
    );
    expect(index?.root).toBe('games/mech2/');
    expect([...index!.files].sort()).toEqual([
      ['DATABASE.MW2', 'games/mech2/Database.mw2'],
      ['GIDDI/KEYBOARD.DLL', 'games/mech2/giddi/keyboard.dll'],
      ['MECH2_16B.BIN', 'games/mech2/MECH2_16B.BIN'],
      ['MECH2_16B.CUE', 'games/mech2/mech2_16b.cue'],
      ['MW2.EXE', 'games/mech2/MW2.EXE'],
      ['MW2.PRJ', 'games/mech2/mw2.prj'],
      ['MW2SHELL.EXE', 'games/mech2/mw2shell.exe'],
      ['SMK/MINTRO.SMK', 'games/mech2/smk/mintro.smk'],
    ]);
  });

  it('can be the files themselves', () => {
    expect(indexInstall(paths(['MW2.PRJ', 'MW2.EXE']))?.root).toBe('');
  });

  it('is not there without MW2.PRJ', () => {
    expect(indexInstall(paths(['mech2/MW2.EXE', 'mech2/MW2SHELL.EXE']))).toBeNull();
  });

  it('lists one directory as the dev server does', () => {
    const keys = ['MW2.PRJ', 'MECH2_16B.CUE', 'GIDDI/KEYBOARD.DLL', 'GIDDI/MOUSE.DLL', 'SMK/MINTRO.SMK'];
    expect(listInstallDir(keys, '')).toEqual(['MW2.PRJ', 'MECH2_16B.CUE']);
    expect(listInstallDir(keys, 'giddi')).toEqual(['GIDDI/KEYBOARD.DLL', 'GIDDI/MOUSE.DLL']);
    expect(listInstallDir(keys, 'KEATING')).toEqual([]);
  });
});
