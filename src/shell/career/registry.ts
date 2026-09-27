/**
 * MW2REG.CFG, the pilot registry: 20 PilotRecords of 0x3c at pilotRegistry
 * (0x91198), read and written whole (decompiled/mw2shell/src/career/career.c).
 * Slots 0..9 start in the Wolf career, 10..19 in Jade Falcon.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';

export const PILOT_COUNT = 0x14;
const SIZE = structSize('PilotRecord');

/** @portOnly the address of pilot slot i */
export function pilotRecord(i: number): number {
  return SHELL_LABEL.pilotRegistry + i * SIZE;
}

/**
 * Reads MW2REG.CFG into the registry; with no file, resets all 20 slots
 * (zeroes, an empty name, career 1 for slots 10..19). Either way +0x38 is
 * then cleared in every record.
 *
 * @mw2shell career_registry_load 0x0001da70
 * @fidelity exact
 */
export function careerRegistryLoad(): void {
  const m = mem();
  const f = dosFileLoad('MW2REG.CFG');
  if (!f) {
    for (let i = 0; i < PILOT_COUNT; i++) {
      const a = pilotRecord(i);
      for (const k of ['inUse', 'selected', 'missionIndex', 'rank', 'careerHonor', 'killTally', 'enemyMechHits', 'shotsFired', 'pad_024']) m.setI32(a + fieldOffset('PilotRecord', k), 0);
      m.setI32(a + fieldOffset('PilotRecord', 'career'), i > 9 ? 1 : 0);
      // strcpy from the empty string at 0x734c6
      m.strcpy(a + fieldOffset('PilotRecord', 'pilotName'), '');
    }
  } else {
    // fread(registry, 0x3c, 0x14): whole records only
    const n = Math.min(PILOT_COUNT, Math.floor(f.length / SIZE)) * SIZE;
    m.view(SHELL_LABEL.pilotRegistry, n).set(f.subarray(0, n));
  }
  for (let i = 0; i < PILOT_COUNT; i++) m.setI32(pilotRecord(i) + fieldOffset('PilotRecord', 'pad_038'), 0);
}

/**
 * Writes the registry to MW2REG.CFG.
 *
 * @mw2shell career_registry_save 0x0001db50
 * @fidelity exact
 */
export function careerRegistrySave(): void {
  dosFileWrite('MW2REG.CFG', mem().view(SHELL_LABEL.pilotRegistry, PILOT_COUNT * SIZE));
}
