/**
 * The AI behaviour tables ai_choose_behaviour (0x2c880) draws from.
 *
 * aiBehaviourNames (0x95e30): the game's own {char *name; int value} names
 * for aiBehaviour, 14 records - the count ai_debug passes to
 * lookup_name_by_value. Names are six characters, blank-padded; -1 is blank.
 *
 * The transition rows are BehaviourTransition records (18 bytes: from,
 * choiceCount, choices[7]) in five runs. aiBehaviourSets (0xfdf10) is BSS that
 * ai_behaviour_init fills once per run, so which run serves which gamepiece
 * class, and the row counts, are that function's constants (confirmed in its
 * disassembly at 0x2c7ba..0x2c849), not data - BEHAVIOUR_SETS below.
 */
import type { ExeImage } from '../ExeImage.ts';
import { readArray } from '../../../engine/schema/read.ts';
import type { RawBehaviourTransition } from '../../../generated/structs.gen.ts';

export const AI_BEHAVIOUR_NAMES = 0x95e30;
export const AI_BEHAVIOUR_NAME_COUNT = 0xe;

export type BehaviourTransition = RawBehaviourTransition;

export interface BehaviourName {
  /** as stored, blank padding included ('asrp  ') */
  name: string;
  value: number;
}

export interface BehaviourSetInfo {
  label: string;
  rows: number;
  rowCount: number;
  /** rows at the end whose 'from' cannot be the first behaviour */
  nonStartRows: number;
  /** the gamepiece classes ai_behaviour_init gives it (index class - 1 in aiBehaviourSets) */
  classes: number[];
  /** true for aiBehaviourSetElemental, used instead of class 1's set when loadout->tons == 1 */
  elemental: boolean;
}

/** ai_behaviour_init's constants (0x2c5f0), in the order the listing prints them. */
export const BEHAVIOUR_SETS: readonly BehaviourSetInfo[] = [
  { label: 'behaviourTransitionsMech', rows: 0x963f4, rowCount: 13, nonStartRows: 7, classes: [1], elemental: false },
  { label: 'behaviourTransitionsElemental', rows: 0x96514, rowCount: 13, nonStartRows: 7, classes: [], elemental: true },
  { label: 'behaviourTransitionsHelicopter', rows: 0x964f0, rowCount: 1, nonStartRows: 0, classes: [5], elemental: false },
  { label: 'behaviourTransitionsTransport', rows: 0x96502, rowCount: 1, nonStartRows: 0, classes: [8], elemental: false },
  { label: 'behaviourTransitionsIdle', rows: 0x964de, rowCount: 1, nonStartRows: 0, classes: [2, 3, 4, 6, 7], elemental: false },
];

/**
 * @mw2data aiBehaviourNames 0x00095e30
 * @fidelity exact
 */
export function readBehaviourNames(exe: ExeImage): BehaviourName[] {
  const out: BehaviourName[] = [];
  for (let i = 0; i < AI_BEHAVIOUR_NAME_COUNT; i++) {
    const a = AI_BEHAVIOUR_NAMES + i * 8;
    out.push({ name: exe.strPtr(a) ?? '', value: exe.i32(a + 4) });
  }
  return out;
}

/**
 * The rows of one set.
 *
 * @mw2data behaviourTransitionsMech 0x000963f4
 * @mw2data behaviourTransitionsIdle 0x000964de
 * @mw2data behaviourTransitionsHelicopter 0x000964f0
 * @mw2data behaviourTransitionsTransport 0x00096502
 * @mw2data behaviourTransitionsElemental 0x00096514
 * @fidelity exact
 */
export function readBehaviourTransitions(exe: ExeImage, set: BehaviourSetInfo): BehaviourTransition[] {
  return readArray<BehaviourTransition>(exe, 'BehaviourTransition', set.rows, set.rowCount);
}
