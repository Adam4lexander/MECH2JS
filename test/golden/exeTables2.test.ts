// Behaviour of two small MW2.EXE routines the port reads its tables with:
// cheat_match against the decoded cheat codes, and the MW2.INI reader.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { IniFile } from '../../src/data/config/ini.ts';
import { cheatMatch, readCheatCodes } from '../../src/data/exe/tables/cheats.ts';
import { gameSource, hasGameData } from '../support/env.ts';

describe.runIf(hasGameData)('EXE tables 2', () => {
  let exe: ExeImage;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
  });

  it('cheat_match compares the newest keystrokes against the decoded code', () => {
    const blorb = readCheatCodes(exe).find((c) => c.typed === 'blorb')!;
    const keys = (s: string) => Array.from(s, (ch) => ch.charCodeAt(0));
    expect(cheatMatch(blorb.stored, keys('xxblorb'))).toBe(true);
    expect(cheatMatch(blorb.stored, keys('blorbx'))).toBe(false);
    expect(cheatMatch(blorb.stored, keys('lorb'))).toBe(false);
    expect(cheatMatch('', keys(''))).toBe(true);
  });

  it('ini_find_section / ini_get_value edge cases', () => {
    const ini = new IniFile(new TextEncoder().encode('; x\r\n\r\n  [Sect] trailing\r\nK=v1\r\nkey = no\r\nKEY=v2 \r\n[Next]\r\nlast=abc'));
    expect(ini.iniFindSection('sect')).toBe(0);
    expect(ini.iniGetValue('k')).toBe('v1');
    expect(ini.iniGetValue('key')).toBe('v2 ');
    expect(ini.iniGetValue('last')).toBe('');
    expect(ini.iniFindSection('next')).toBe(0);
    expect(ini.iniGetValue('last')).toBe('ab'); // no line end: the last character goes
    expect(ini.iniFindSection('none')).toBe(0x39);
    expect(ini.iniGetValue('k')).toBe('');
    expect(new IniFile(null).iniFindSection('x')).toBe(0x34);
  });
});
