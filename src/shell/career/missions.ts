/**
 * The campaign tables and the pilot records as the career screens read
 * them in the shell's memory: careerMissionTables (0x7f04c) -> 17 nine-byte
 * CareerMission rows {scenario, isTrial, title} per career, rankTitles,
 * the registry's PilotRecords and currentPilot (README "Careers").
 *
 * @portOnly accessors over the shell's static data
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';

const MISSION = structSize('CareerMission');

/** PilotRecord field offsets. */
export const PILOT = {
  inUse: fieldOffset('PilotRecord', 'inUse'),
  selected: fieldOffset('PilotRecord', 'selected'),
  career: fieldOffset('PilotRecord', 'career'),
  missionIndex: fieldOffset('PilotRecord', 'missionIndex'),
  rank: fieldOffset('PilotRecord', 'rank'),
  careerHonor: fieldOffset('PilotRecord', 'careerHonor'),
  killTally: fieldOffset('PilotRecord', 'killTally'),
  enemyMechHits: fieldOffset('PilotRecord', 'enemyMechHits'),
  shotsFired: fieldOffset('PilotRecord', 'shotsFired'),
  /** +0x24: only ever zeroed */
  field24: fieldOffset('PilotRecord', 'pad_024'),
  pilotName: fieldOffset('PilotRecord', 'pilotName'),
  /** +0x38: screen_register keeps the slot's name label here (cleared by every load) */
  field38: fieldOffset('PilotRecord', 'pad_038'),
} as const;

/** @portOnly currentPilot: a PilotRecord's address, or 0 */
export function currentPilot(): number {
  return mem().u32(SHELL_LABEL.currentPilot);
}

/** @portOnly sets currentPilot (0 for none) */
export function setCurrentPilot(pilot: number): void {
  mem().setI32(SHELL_LABEL.currentPilot, pilot);
}

/** @portOnly an int field of a pilot record */
export function pilotField(pilot: number, f: Exclude<keyof typeof PILOT, 'pilotName'>): number {
  return mem().i32(pilot + PILOT[f]);
}

/** @portOnly sets an int field of a pilot record */
export function setPilotField(pilot: number, f: Exclude<keyof typeof PILOT, 'pilotName'>, v: number): void {
  mem().setI32(pilot + PILOT[f], v);
}

/** @portOnly a pilot record's name */
export function pilotName(pilot: number): string {
  return mem().cstr(pilot + PILOT.pilotName, 16);
}

/** @portOnly the address of careerMissionTables[career][index] */
export function careerMissionAt(career: number, index: number): number {
  return mem().u32(SHELL_LABEL.careerMissionTables + career * 4) + index * MISSION;
}

/** @portOnly careerMissionTables[career][index]: its scenario (null in the Retired row), trial flag and title */
export function careerMission(career: number, index: number): { scenario: string | null; isTrial: number; title: string } {
  const m = mem();
  const a = careerMissionAt(career, index);
  return {
    scenario: m.ptrStr(a + fieldOffset('CareerMission', 'scenario')),
    isTrial: m.u8(a + fieldOffset('CareerMission', 'isTrial')),
    title: m.ptrStr(a + fieldOffset('CareerMission', 'title')) ?? '',
  };
}

/** @portOnly rankTitles[rank] */
export function rankTitle(rank: number): string {
  return mem().ptrStr(SHELL_LABEL.rankTitles + rank * 4) ?? '';
}
