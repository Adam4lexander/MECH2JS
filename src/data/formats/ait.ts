/**
 * AIT resources - the nine AI rule tables ai_rule_tables_load (0x236e0) loads
 * into aiRuleTables slots 1..9 - and the static tables in MW2.EXE that give
 * their numbers meaning.
 *
 * LAYOUT, as ai_rules_rebuild (0x21770) walks it (mech_has_rules_for_state
 * reads the same index):
 *   +0     short N                 states with rules in this table
 *   +2     N x {short aiState, short ruleCount}
 *   then   the rules, 12 bytes each (AiRule in mw2_types.h). A state's rules
 *          start at (short)(N * 4 + 2 + prior * 12), prior being the (short)
 *          sum of the ruleCounts of the pairs BEFORE it. The walk takes at
 *          most ruleCount rules and stops early at a rule whose condition is 0.
 *
 * tools/dump_ai_rules.py walks the rules sequentially instead, so after a rule
 * with condition 0 it would start the next state one rule early. The loader
 * wins: parseAit places every state by the loader's arithmetic. No shipped
 * table stops early, so the two agree on the data.
 *
 * Bytes past the last counted rule are never reached (several tables carry
 * some; stale editor data by the look of it, which is not established).
 */

import { i16 } from '../../core/int/cint.ts';
import { bytesMemory, readStruct } from '../../engine/schema/read.ts';
import type { RawAiRule } from '../../generated/structs.gen.ts';
import type { ExeImage } from '../exe/ExeImage.ts';

export const AI_RULE_SIZE = 12;

export interface AitStateBlock {
  aiState: number;
  ruleCount: number;
  /** payload offset of this state's first rule, by the loader's arithmetic */
  rulesOffset: number;
  /**
   * The rules the walk reads: up to ruleCount, INCLUDING a terminating rule
   * with condition 0 when there is one (the walk stops on it without using
   * it; see stoppedAtZero).
   */
  rules: RawAiRule[];
  /** the walk stopped on a rule whose condition is 0 */
  stoppedAtZero: boolean;
  /** a rule ran past the end of the payload */
  truncated: boolean;
}

export interface AitTable {
  stateCount: number;
  states: AitStateBlock[];
  /** 2 + 4N + 12 * sum(ruleCount): the end of the counted rules */
  extent: number;
  /** payload bytes after extent (never reached) */
  trailing: number;
}

/**
 * Parses an AIT payload into its per-state rule blocks.
 *
 * @portOnly the parse half of ai_rules_rebuild (0x21770); building MechEntity.ruleSet is AI work
 */
export function parseAit(c: Uint8Array): AitTable {
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const mem = bytesMemory(c);
  const n = dv.getInt16(0, true);
  const states: AitStateBlock[] = [];
  let prior = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const aiState = dv.getInt16(2 + 4 * i, true);
    const ruleCount = dv.getInt16(4 + 4 * i, true);
    const rulesOffset = i16(n * 4 + 2 + Math.imul(prior, 0xc));
    const rules: RawAiRule[] = [];
    let stoppedAtZero = false;
    let truncated = false;
    for (let r = 0; r < ruleCount; r++) {
      const o = rulesOffset + r * AI_RULE_SIZE;
      if (o + AI_RULE_SIZE > c.length) {
        truncated = true;
        break;
      }
      const rule = readStruct<RawAiRule>(mem, 'AiRule', o);
      rules.push(rule);
      if (rule.condition === 0) {
        stoppedAtZero = true;
        break;
      }
    }
    states.push({ aiState, ruleCount, rulesOffset, rules, stoppedAtZero, truncated });
    prior = i16(prior + ruleCount);
    total += ruleCount;
  }
  const extent = 2 + 4 * n + AI_RULE_SIZE * total;
  return { stateCount: n, states, extent, trailing: c.length - extent };
}

// --- static tables in MW2.EXE --------------------------------------------

export const AI_STATE_NAMES = 0x95bd0;
export const TARGET_DESIGNATOR_NAMES = 0x95cb0;
/** lookup_name_by_value's count for targetDesignatorNames (ai_state.c) */
export const TARGET_DESIGNATOR_COUNT = 7;
export const AI_RULE_CONDITIONS = 0x96050;
export const AI_RULE_CONDITION_COUNT = 8;
export const AI_RULE_ACTIONS = 0x96070;
export const AI_RULE_ACTION_COUNT = 5;
/** [gamepieceClass, address] - ai_set_state_rule_block's switch; class 8 reads class 5's array */
export const AI_RULE_SELECT: ReadonlyArray<readonly [number, number]> = [
  [1, 0x95ea2],
  [2, 0x95f56],
  [3, 0x95ede],
  [4, 0x95f92],
  [5, 0x95fce],
  [6, 0x95f1a],
];
/** each array runs to the next one in memory: 0x3c bytes, 15 [leader, follower] pairs */
export const AI_RULE_SELECT_PAIRS = 15;

export interface NameValue {
  name: string;
  value: number;
}

/**
 * A {char *name, int value} table of the kind lookup_name_by_value searches:
 * `count` records, or up to the first null name pointer when count is omitted.
 *
 * @portOnly reader for lookup_name_by_value's table shape
 */
export function readNameValueTable(exe: ExeImage, addr: number, count?: number): NameValue[] {
  const out: NameValue[] = [];
  for (let i = 0; count === undefined ? i < 256 : i < count; i++) {
    const p = exe.u32(addr + 8 * i);
    if (p === 0) {
      if (count === undefined) break;
      continue;
    }
    out.push({ name: exe.cstrAt(p, 32), value: exe.i32(addr + 8 * i + 4) });
  }
  return out;
}

/**
 * aiState names: 13 {name, value} pairs terminated by a null pointer.
 *
 * @mw2data aiStateNames 0x00095bd0
 * @fidelity exact
 */
export function readAiStateNames(exe: ExeImage): NameValue[] {
  return readNameValueTable(exe, AI_STATE_NAMES);
}

/**
 * The symbolic target designators (agp_home 0x2100 ... agp_enemy 0x4201).
 *
 * @mw2data targetDesignatorNames 0x00095cb0
 * @fidelity exact
 */
export function readTargetDesignatorNames(exe: ExeImage): NameValue[] {
  return readNameValueTable(exe, TARGET_DESIGNATOR_NAMES, TARGET_DESIGNATOR_COUNT);
}

/**
 * The rule condition function pointers (0 = empty slot), as code addresses.
 *
 * @mw2data aiRuleConditions 0x00096050
 * @fidelity exact
 */
export function readAiRuleConditions(exe: ExeImage): number[] {
  return Array.from({ length: AI_RULE_CONDITION_COUNT }, (_, i) => exe.u32(AI_RULE_CONDITIONS + 4 * i));
}

/**
 * The rule action function pointers (0 = empty slot), as code addresses.
 *
 * @mw2data aiRuleActions 0x00096070
 * @fidelity exact
 */
export function readAiRuleActions(exe: ExeImage): number[] {
  return Array.from({ length: AI_RULE_ACTION_COUNT }, (_, i) => exe.u32(AI_RULE_ACTIONS + 4 * i));
}

/**
 * One selection array: [ruleIndex] -> [slot when this mech leads its group,
 * slot when it does not], each an aiRuleTables index (0 = none).
 *
 * @mw2data aiRuleSelectState1 0x00095ea2
 * @mw2data aiRuleSelectState2 0x00095f56
 * @mw2data aiRuleSelectState3 0x00095ede
 * @mw2data aiRuleSelectState4 0x00095f92
 * @mw2data aiRuleSelectState5 0x00095fce
 * @mw2data aiRuleSelectState6 0x00095f1a
 * @fidelity exact
 */
export function readAiRuleSelect(exe: ExeImage, addr: number): Array<[number, number]> {
  return Array.from({ length: AI_RULE_SELECT_PAIRS }, (_, i) => [exe.i16(addr + 4 * i), exe.i16(addr + 4 * i + 2)] as [number, number]);
}
