// Phase S4: the shell's screen music. The music-by-state tables as the port
// reads them from MW2SHELL.EXE against the README's table (decompiled/
// mw2shell/README.md, "Screen music"), and the GM set chosen through
// midiDriverSets for the port's General MIDI synth.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { mpackDbGetItemUnpacked, mpackDbOpen } from '../../src/data/formats/mpack.ts';
import { xmidiParse } from '../../src/data/formats/xmidi.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { mem } from '../../src/shell/memory.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

const STOP = 'stop';
const KEEP = 'keep';
/** README: state -> [Wolf, Jade Falcon, career 2]; '-' is 0 (keep) */
const README: Record<number, [string | number, string | number, string | number]> = {
  0: [37, 40, 35],
  1: [36, 39, KEEP],
  3: [KEEP, KEEP, KEEP],
  5: [36, 39, KEEP],
  7: [35, 35, 35],
  8: [STOP, STOP, STOP],
  9: [37, 40, 35],
  10: [STOP, STOP, STOP],
  0xb: [37, 40, KEEP],
  0xc: [36, 39, KEEP],
  0xd: [37, 40, 35],
  0xe: [38, 41, KEEP],
  0xf: [STOP, STOP, STOP],
  0x10: [STOP, STOP, STOP],
};

describe.runIf(hasGameData && hasShellData)('shell screen music', () => {
  let db: Uint8Array;
  beforeAll(async () => {
    startShellProcess(ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE')), new ProjectFile(await gameSource().read('MW2.PRJ')));
    db = await gameSource().read('DATABASE.MW2');
  });

  it('musicByState tables match the README', () => {
    const m = mem();
    const read = (table: number, state: number) => {
      const v = m.i32(table + state * 4);
      return v === 0 ? KEEP : v === 0x20000000 ? STOP : v;
    };
    for (const [state, want] of Object.entries(README)) {
      const s = Number(state);
      expect([read(SHELL_LABEL.musicByStateWolf, s), read(SHELL_LABEL.musicByStateJadeFalcon, s), read(SHELL_LABEL.musicByStateGrievance, s)], `state ${s}`).toEqual(want);
    }
  });

  it('a General MIDI driver (MPU401.MDI) picks the set at base + 32, and every song there is XMIDI', () => {
    const m = mem();
    let offset = 8;
    for (let i = 0; i < 14; i++) if (m.ptrStr(SHELL_LABEL.midiDriverSets + i * 8) === 'MPU401.MDI') offset = m.i32(SHELL_LABEL.midiDriverSets + i * 8 + 4);
    expect(offset).toBe(32);
    const archive = mpackDbOpen('DATABASE.MW2', db);
    for (let base = 35; base <= 41; base++) {
      const song = xmidiParse(mpackDbGetItemUnpacked(archive, base + offset)!);
      expect(song?.sequences.length, `item ${base + offset}`).toBeGreaterThan(0);
    }
  });
});
