// Phase S7: the mech lab's MEK loader and SAVE record against the files
// MW2SHELL.EXE wrote into the install's MEK directory (read here only as
// expected output), and the construction rules the CUSTOMIZE handlers
// enforce (README "Design rules the mech lab enforces").
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { parseMek } from '../../src/data/formats/mek.ts';
import { setDosFiles, setOverlayFiles, setOwnFiles } from '../../src/engine/dosFiles.ts';
import { SHELL_LABEL as L } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { mem } from '../../src/shell/memory.ts';
import { projectOpen } from '../../src/shell/career/orders.ts';
import { chassisEntry } from '../../src/shell/handoff/starFiles.ts';
import {
  crit,
  g,
  locField,
  mechlabAddArmour,
  mechlabAddItemAndRecompute,
  mechlabAddJumpJet,
  mechlabArmourFrontUp,
  mechlabDeleteHeatSink,
  mechlabEngineFaster,
  mechlabEngineSlower,
  mechlabLoadMek,
  mechlabPackMek,
  mechlabPlaceUnplaced,
  mechlabUnplaceSlot,
  s,
  unplacedCriticals,
  unplacedItem,
} from '../../src/shell/mechlab/design.ts';
import { mechlabListVariants } from '../../src/shell/screens/mechlab.ts';
import { gameSource, hasGameData, hasShellData, installShellFixtures } from '../support/env.ts';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

describe.runIf(hasShellData && hasGameData)('shell mech lab: MEK records and design rules', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let meks: Map<string, Uint8Array>;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    meks = installShellFixtures(['MEK/*USR.MEK']);
  });
  beforeEach(() => {
    startShellProcess(exe, prj);
    projectOpen('MW2.PRJ');
    setDosFiles(new Map());
    setOwnFiles(meks);
    setOverlayFiles(null);
  });

  /** mechlab_load_mek of a name (put where the variant list keeps names) */
  function load(name: string): void {
    mem().fill(L.mechlabVariants, 0, 13);
    mem().strcpy(L.mechlabVariants, name);
    mechlabLoadMek(L.mechlabVariants);
  }

  it('every install MEK\\*USR.MEK loads and SAVE writes it back byte for byte', () => {
    expect(meks.size).toBeGreaterThan(0);
    for (const [key, bytes] of meks) {
      const name = key.slice(4, -4); // 'MEK/TBR00USR.MEK' -> 'TBR00USR'
      load(name);
      expect(mem().cstr(L.designTitle), key).toBe(parseMek(bytes)!.trailerText);
      expect(g(L.mechlabUnplacedCount), key).toBe(0);
      expect(hex(mechlabPackMek()), key).toBe(hex(bytes));
    }
  });

  it('the variant list finds the stock variants in MW2.PRJ and the user files by slot', () => {
    // the Mad Dog (mdg): the install has mdg00usr..mdg02usr
    mechlabListVariants('mdg');
    const at = (i: number) => mem().cstr(L.mechlabVariants + i * 13, 13);
    expect(at(0)).toBe('mdg00std');
    expect([at(100), at(101), at(102), at(103)]).toEqual(['MDG00USR', 'MDG01USR', 'MDG02USR', '']);
    for (let i = 1; i < 100; i++) if (at(i) !== '') expect(at(i)).toBe(`mdg${String(i).padStart(2, '0')}std`);
  });

  it('stock variants load as valid designs: nothing unplaced, within the chassis weight', () => {
    for (let c = 0; c < 15; c++) {
      const prefix = chassisEntry(c).prefix;
      mechlabListVariants(prefix);
      for (let v = 0; v < 100; v++) {
        const name = mem().cstr(L.mechlabVariants + v * 13, 13);
        if (name === '') continue;
        load(name);
        expect(g(L.designMaxMass), name).toBe(chassisEntry(c).tonnage * 100);
        expect(unplacedItem(0), name).toBe(-1);
        expect(g(L.designMass), name).toBeLessThanOrEqual(g(L.designMaxMass));
      }
    }
  });

  it('jump jets: not beyond walking MP, and only in the torsos and legs', () => {
    load('mdg00std');
    const walk = g(L.designWalkMP);
    s(L.designJumpMP, 0);
    for (let i = 0; i < walk + 3; i++) mechlabAddJumpJet();
    expect(g(L.designJumpMP)).toBe(walk);
    const jj = [...Array(78).keys()].find((i) => unplacedItem(i) - (unplacedItem(i) % 100) === 7000)!;
    s(L.mechlabLocation, 0); // the head
    expect(mechlabPlaceUnplaced(jj)).toBe('Jump Jets may only|be assigned to torso|or leg sections.#Ok');
    s(L.mechlabLocation, 4); // the right arm
    expect(mechlabPlaceUnplaced(jj)).toMatch(/^Jump Jets may only/);
  });

  it('an item that does not fit is refused; a fixed critical cannot be removed', () => {
    load('mdg00std');
    s(L.mechlabSelectedItem, 11 * 100); // the Gauss Rifle: many criticals
    mechlabAddItemAndRecompute();
    const gauss = [...Array(78).keys()].find((i) => ((unplacedItem(i) / 100) | 0) === 11)!;
    expect(unplacedCriticals(gauss)).toBeGreaterThan(1);
    s(L.mechlabLocation, 0); // the head is full
    expect(mechlabPlaceUnplaced(gauss)).toBe('Insufficient criticals|for item placement.#Ok');
    // the right arm's shoulder (5301) is fixed
    s(L.mechlabLocation, 4);
    expect(crit(4, 0)).toBe(5301);
    expect(mechlabUnplaceSlot(0)).toBe('Selected critical|can not be removed.#Ok');
  });

  it('heat sinks stop at the free ten; the engine stays within ratings 10..400; armour stops at maxArmour', () => {
    load('mdg00std');
    for (let i = 0; i < 40; i++) mechlabDeleteHeatSink();
    expect(g(L.designHeatSinkMass)).toBe(0);
    for (let i = 0; i < 40; i++) mechlabEngineFaster();
    expect(g(L.designEngineRating)).toBeLessThanOrEqual(400);
    for (let i = 0; i < 40; i++) mechlabEngineSlower();
    expect(g(L.designEngineRating)).toBeGreaterThanOrEqual(10);
    // plenty of armour, then the head's front up past its cap of 9
    for (let i = 0; i < 40; i++) mechlabAddArmour();
    s(L.mechlabLocation, 0);
    for (let i = 0; i < 30; i++) mechlabArmourFrontUp();
    expect(locField(0, 'armourFront')).toBe(locField(0, 'maxArmour'));
    expect(locField(0, 'maxArmour')).toBe(9);
  });
});
