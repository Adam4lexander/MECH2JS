/**
 * The AIT rule VM. Each AI mech has three rule blocks (MechEntity.stateRules:
 * slot 0 its default table, slot 2 the table for its group's objective) and
 * a rule list for its current aiState (ruleSet, rebuilt on every state
 * change). ai_rules_run walks that list each think: a rule's condition
 * searches for something, its action runs when the search finds a handle,
 * and the first rule whose action accepts moves the mech into the rule's
 * next state, aimed at the rule's target.
 *
 * Operands and targets carry three sentinels: 0x40 '@' targetSecondary,
 * 0x2a '*' targetPrimary and 0x25 '%' - zero as an operand, and in a target
 * the handle the condition found. See listing/ai_rules.txt.
 */
import { AiRule, type MechEntity } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { i16, u16 } from '../../core/int/cint.ts';
import { unestablished } from '../../core/provenance.ts';
import { registerCode, resolveCode, type CodeFn } from '../../engine/codePtr.ts';
import { bootImage } from '../../engine/image.ts';
import { cacheLoadResource } from '../../engine/resources/cache.ts';
import { preloadLinks } from '../../engine/resources/preload.ts';
import { objectives } from '../../mission/objectives.ts';
import { groupCollectMembers, groupGetLeader, mechsSameAllegiance } from '../groups/groups.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { radioLanceMessage } from '../sound/sound.ts';
import { ai, RULE_LIST_SLOTS, type AiRuleBlock } from './aiGlobals.ts';
import { objectEngageRange, objectTestFlags, resolveTargetDesignator } from './handles.ts';
import { aiCycleNavpoint, aiValidateCurrentTarget } from './targeting.ts';
import { trackedObjectRemove } from './tracked.ts';
import { aiTryEnterState } from './states.ts';

const AI_RULE_SIZE = 12;

/**
 * An AIT payload as the rule VM reads it: the (aiState, ruleCount) index and
 * every whole 12-byte record after it.
 *
 * @portOnly the parse ai_rules_rebuild and mech_has_rules_for_state do in place
 */
export function aiRuleBlockFromBytes(resourceId: number, c: Uint8Array): AiRuleBlock {
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const n = dv.getInt16(0, true);
  const index: AiRuleBlock['index'] = [];
  for (let i = 0; i < n; i++) index.push({ aiState: dv.getInt16(2 + 4 * i, true), ruleCount: dv.getInt16(4 + 4 * i, true) });
  const rules: AiRule[] = [];
  for (let o = n * 4 + 2; o + AI_RULE_SIZE <= c.length; o += AI_RULE_SIZE) {
    const r = new AiRule();
    r.condition = dv.getUint16(o, true);
    r.operand1 = dv.getInt16(o + 2, true);
    r.operand2 = dv.getInt16(o + 4, true);
    r.action = dv.getUint8(o + 6);
    r.nextState = dv.getInt16(o + 7, true);
    r.targetOperand = dv.getInt16(o + 9, true);
    rules.push(r);
  }
  return { resourceId, index, rules };
}

/**
 * Loads AIT resources 1..9 into aiRuleTables[1..9]; slot 0 stays null.
 * Returns 1.
 *
 * @mw2 ai_rule_tables_load 0x000236e0
 * @fidelity exact
 */
export function aiRuleTablesLoad(): number {
  ai.aiRuleTables[0] = null;
  for (let id = 1; id <= 9; id++) {
    const c = cacheLoadResource(id, 'AIT');
    ai.aiRuleTables[id] = c ? aiRuleBlockFromBytes(id, c) : null;
  }
  return 1;
}

preloadLinks.aiRuleTablesLoad = aiRuleTablesLoad;

/** aiRuleSelectState* by gamepieceClass (class 8 reads class 5's); class 7 has none */
const RULE_SELECT: Record<number, number> = {
  1: LABEL.aiRuleSelectState1,
  2: LABEL.aiRuleSelectState2,
  3: LABEL.aiRuleSelectState3,
  4: LABEL.aiRuleSelectState4,
  5: LABEL.aiRuleSelectState5,
  6: LABEL.aiRuleSelectState6,
  8: LABEL.aiRuleSelectState5,
};

/**
 * Points stateRules[slot] at an AIT rule table: aiRuleTables[select[ruleIndex]
 * [leaderIndex != mech.index]], the select array by gamepieceClass (class 7,
 * doors, is left unchanged); ruleIndex -1 clears the block. A ruleIndex past
 * an array's 15 pairs reads on into the next array, as the C does.
 *
 * @mw2 ai_set_state_rule_block 0x00023d50
 * @fidelity exact
 */
export function aiSetStateRuleBlock(mech: MechEntity, slot: number, ruleIndex: number, leaderIndex: number): void {
  ruleIndex = i16(ruleIndex);
  if (ruleIndex === -1) {
    mech.stateRules[slot] = null;
    return;
  }
  const base = RULE_SELECT[mech.gamepieceClass];
  if (base === undefined) return;
  const notLeader = i16(leaderIndex) !== mech.index ? 1 : 0;
  const exe = bootImage();
  if (!exe) {
    unestablished('ai_set_state_rule_block: no MW2.EXE image to read the rule selection from', 'ai_set_state_rule_block');
    return;
  }
  const tableSlot = exe.i16(base + notLeader * 2 + ruleIndex * 4);
  if (tableSlot < 0 || tableSlot >= ai.aiRuleTables.length) {
    unestablished(`ai_set_state_rule_block: rule table slot ${tableSlot} lies outside aiRuleTables`, 'ai_set_state_rule_block');
    return;
  }
  mech.stateRules[slot] = ai.aiRuleTables[tableSlot];
}

/**
 * 1 when any of the mech's three rule blocks indexes `state`.
 *
 * @mw2 mech_has_rules_for_state 0x00023260
 * @fidelity exact
 */
export function mechHasRulesForState(mech: MechEntity, state: number): number {
  const s = u16(state);
  for (let k = 0; k < 3; k++) {
    const b = mech.stateRules[k] as AiRuleBlock | null;
    if (!b) continue;
    for (const e of b.index) if (s === u16(e.aiState)) return 1;
  }
  return 0;
}

/** ruleSet[i] = rule, into the 0xf44e8 record (6 slots; the C would run into the next mech's). @portOnly */
function ruleListStore(mech: MechEntity, i: number, rule: AiRule | null): void {
  const list = mech.ruleSet!;
  if (i >= RULE_LIST_SLOTS) {
    unestablished(`ai_rules_rebuild: rule list entry ${i} runs past the mech's 6-slot record into the next mech's`, 'ai_rules_rebuild');
    return;
  }
  list[i] = rule;
}

/**
 * Refills ruleSet for the current aiState from stateRules[2], [1], [0] in
 * that order: each block's rules for the state - up to its ruleCount, stopping
 * at a condition of 0 - skipping any whose operand1 and condition match one
 * already listed. Null-terminated.
 *
 * @mw2 ai_rules_rebuild 0x00021770
 * @fidelity exact
 */
export function aiRulesRebuild(mech: MechEntity): void {
  const list = mech.ruleSet!;
  list[0] = null;
  for (let k = 2; k >= 0; k--) {
    const b = mech.stateRules[k] as AiRuleBlock | null;
    if (!b) continue;
    // the index walk: sum the ruleCounts before the matching state
    let found = false;
    let count = 0;
    let prior = 0;
    for (const e of b.index) {
      if (u16(e.aiState) === u16(mech.aiState)) {
        found = true;
        count = e.ruleCount;
        break;
      }
      prior = i16(prior + e.ruleCount);
    }
    if (!found) continue;
    for (let r = 0; r < count; r++) {
      const rule = b.rules[prior + r];
      if (!rule) {
        unestablished('ai_rules_rebuild: a state\'s rules run past the end of its AIT resource', 'ai_rules_rebuild');
        break;
      }
      if (rule.condition === 0) break;
      let dup = false;
      let n = 0;
      for (; !dup && n < RULE_LIST_SLOTS && list[n]; n++) {
        const have = list[n]!;
        if (have.operand1 === rule.operand1 && have.condition === rule.condition) dup = true;
      }
      if (!dup) {
        ruleListStore(mech, n, rule);
        ruleListStore(mech, n + 1, null);
      }
    }
  }
}

/** A rule operand through the sentinels: '@' targetSecondary, '*' targetPrimary, '%' 0. @portOnly */
function ruleOperand(mech: MechEntity, v: number, percent: number): number {
  const u = u16(v);
  if (u === 0x40) return mech.targetSecondary;
  if (u === 0x25) return percent;
  if (u === 0x2a) return mech.targetPrimary;
  return u;
}

/**
 * The mech's rules, after mech_retaliate: for each listed rule (operands
 * resolved), the condition aiRuleConditions[condition](mech, op1, op2); a
 * non-zero handle calls aiRuleActions[action](mech, rule), and an accepting
 * action ends the walk by entering nextState (ai_try_enter_state, no push)
 * with the rule's target - '%' the handle the condition found. Returns 1 when
 * a rule fired, 0 when none did.
 *
 * A rule whose condition and resolved operand1 equal the mech's
 * leaderRequest / leaderRequestArg clears the request and from then on - that
 * rule and every later one - the condition is NOT called: the action runs
 * as if it had found operand1 (0x216a4..0x216cf).
 *
 * @mw2 ai_rules_run 0x000215f0
 * @fidelity exact
 */
export function aiRulesRun(mech: MechEntity): number {
  mechRetaliate(mech);
  let skipConditions = 0;
  const list = mech.ruleSet!;
  for (let i = 0; ; i++) {
    const rule = i < RULE_LIST_SLOTS ? list[i] : null;
    if (!rule) return 0;
    let found = ruleOperand(mech, rule.operand1, 0);
    const op2 = ruleOperand(mech, rule.operand2, 0);
    if (u16(mech.leaderRequest) === rule.condition && i16(found) === u16(mech.leaderRequestArg)) {
      mech.leaderRequest = 0;
      skipConditions = 1;
    }
    if (skipConditions === 0) {
      const cond = aiRuleCondition(rule.condition);
      found = cond ? (cond(mech, i16(found), i16(op2)) as number) : 0;
      if ((found & 0xffff) === 0) continue;
    }
    const act = aiRuleAction(rule.action);
    if (!act || (act(mech, rule) as number) === 0) continue;
    const target = ruleOperand(mech, rule.targetOperand, found & 0xffff);
    aiTryEnterState(mech, rule.nextState, i16(target), 0);
    return 1;
  }
}

/** aiRuleConditions[i] (0x96050, 8 slots) as ported functions. @portOnly the table lookup */
function aiRuleCondition(i: number): CodeFn | null {
  const exe = bootImage();
  const f = exe ? resolveCode(exe.u32(LABEL.aiRuleConditions + i * 4)) : null;
  if (!f) unestablished(`aiRuleConditions[${i}] is not a ported function`, 'ai_rules_run');
  return f;
}

/** aiRuleActions[i] (0x96070, 5 slots). @portOnly the table lookup */
function aiRuleAction(i: number): CodeFn | null {
  const exe = bootImage();
  const f = exe ? resolveCode(exe.u32(LABEL.aiRuleActions + i * 4)) : null;
  if (!f) unestablished(`aiRuleActions[${i}] is not a ported function`, 'ai_rules_run');
  return f;
}

// --- conditions: (mech, operand1, operand2) -> a handle, 0 for none ----------

/**
 * Condition 4: the first operand itself.
 *
 * @mw2 ai_rule_cond_literal 0x00021de0
 * @fidelity exact
 */
export const aiRuleCondLiteral = registerCode('ai_rule_cond_literal', 0x21de0, (_mech: MechEntity, operand1: number): number => operand1);

/**
 * Condition 5: never.
 *
 * @mw2 ai_rule_cond_never 0x00021df0
 * @fidelity exact
 */
export const aiRuleCondNever = registerCode('ai_rule_cond_never', 0x21df0, (): number => 0);

/**
 * Condition 1: the nearest candidate of operand1 that is not destroyed and
 * validates, within operand2 * 100 (-3: no limit); 0 when none.
 * Each candidate is left in targetHandle while it is judged.
 *
 * @mw2 ai_rule_cond_nearest_valid 0x00021f90
 * @fidelity exact
 */
export const aiRuleCondNearestValid = registerCode('ai_rule_cond_nearest_valid', 0x21f90, (mech: MechEntity, operand1: number, operand2: number): number => {
  let best = -1;
  let h = -1;
  const limit = i16(operand2) === -3 ? 100000000 : Math.imul(i16(operand2), 100);
  let nearest = limit;
  for (;;) {
    h = resolveTargetDesignator(mech, i16(operand1), h & 0xffff);
    if (i16(h) === -1) break;
    if (objectTestFlags(h & 0xffff, 2, 0) === 0) {
      mech.targetHandle = i16(h);
      if (0 < aiValidateCurrentTarget(mech) && mech.targetDistance < nearest) {
        nearest = mech.targetDistance;
        best = h;
      }
    }
  }
  return nearest < limit && i16(best) !== -1 ? i16(best) : 0;
});

/**
 * Condition 2: the most distant candidate that is not destroyed and
 * validates, beyond a minimum: operand2 -3 none, -4 aiRangeOp4, -2
 * aiRangeOp2, 0 the operand's engage range, else operand2 * 100.
 *
 * @mw2 ai_rule_cond_farthest_valid 0x00022040
 * @fidelity exact
 */
export const aiRuleCondFarthestValid = registerCode('ai_rule_cond_farthest_valid', 0x22040, (mech: MechEntity, operand1: number, operand2: number): number => {
  let h = -1;
  let best = -1;
  const o2 = i16(operand2);
  let far: number;
  if (o2 === -3) far = 0;
  else if (o2 === -4) far = mech.aiRangeOp4;
  else if (o2 === -2) far = mech.aiRangeOp2;
  else if (o2 === 0) far = objectEngageRange(i16(operand1));
  else far = Math.imul(o2, 100);
  const minimum = far;
  for (;;) {
    h = resolveTargetDesignator(mech, i16(operand1), h & 0xffff);
    if (i16(h) === -1) break;
    if (objectTestFlags(h & 0xffff, 2, 0) === 0) {
      mech.targetHandle = i16(h);
      if (0 < aiValidateCurrentTarget(mech) && far < mech.targetDistance) {
        far = mech.targetDistance;
        best = h;
      }
    }
  }
  return minimum < far && i16(best) !== -1 ? i16(best) : 0;
});

/**
 * Condition 3: the nearest valid candidate within operand2 * 100 - or, with
 * operand2 0, within the operand's engage range, and then a navpoint answer
 * (type bit 0x100) moves targetPrimary on to the next navpoint, skipping
 * returnWaypoint (patrol, state 7, wraps once more from navpoint 0 when the
 * step runs out).
 *
 * @mw2 ai_rule_cond_navpoint 0x00021e00
 * @fidelity exact
 */
export const aiRuleCondNavpoint = registerCode('ai_rule_cond_navpoint', 0x21e00, (mech: MechEntity, operand1: number, operand2: number): number => {
  const o1 = i16(operand1);
  if (i16(operand2) !== 0) return aiRuleCondNearestValid(mech, o1, i16(operand2));
  const found = aiRuleCondNearestValid(mech, o1, i16((objectEngageRange(o1) / 100) | 0));
  if (i16(found) === 0 || (operand1 & 0x100) === 0) return found;
  if (o1 === mech.returnWaypoint && mech.returnWaypoint === 0) {
    // dead: returnWaypoint is never 0 after mech_ai_setup
    trackedObjectRemove(mech.index, 0);
    mech.returnWaypoint = 0x1000;
  }
  const step = () => {
    aiCycleNavpoint(mech, 1, 1);
    if (mech.targetHandle >>> 0 === mech.returnWaypoint) aiCycleNavpoint(mech, 1, 1);
  };
  mech.targetHandle = o1;
  step();
  if (mech.aiState === 7) {
    mech.targetPrimary = u16(mech.targetHandle);
    if ((mech.targetHandle & 0x1000) === 0) return found;
    mech.targetHandle = 0x100;
    step();
  }
  mech.targetPrimary = u16(mech.targetHandle);
  return found;
});

/**
 * Condition 7, the lance's: nothing while aiFlags bits 0-1 are set;
 * otherwise ai_find_target_unclaimed within operand2 (-1 aiRangeOp1, -2
 * aiRangeOp2, 0 the engage range - each / 100 - else as given), answering
 * the unclaimed candidate (aiTargetUnclaimedFirst, always 1) or the nearest.
 *
 * @mw2 ai_rule_cond_team_target 0x000223d0
 * @fidelity exact
 */
export const aiRuleCondTeamTarget = registerCode('ai_rule_cond_team_target', 0x223d0, (mech: MechEntity, operand1: number, operand2: number): number => {
  if ((mech.aiFlags & 3) !== 0) return 0;
  let range = i16(operand2);
  let r: number | null = null;
  if (range === -2) r = mech.aiRangeOp2;
  else if (range === -1) r = mech.aiRangeOp1;
  else if (range === 0) r = objectEngageRange(i16(operand1));
  if (r !== null) range = i16((r / 100) | 0);
  const out = { unclaimed: 0, nearest: 0 };
  aiFindTargetUnclaimed(mech, i16(operand1), range, out);
  return ai.aiTargetUnclaimedFirst === 0 ? out.nearest : out.unclaimed;
});

/**
 * Condition 6: operand1 when it is destroyed (radioing the player's lance
 * message 5 when the mech's leader is the player), else 0.
 *
 * @mw2 ai_rule_cond_target_destroyed 0x00022480
 * @fidelity exact
 */
export const aiRuleCondTargetDestroyed = registerCode('ai_rule_cond_target_destroyed', 0x22480, (mech: MechEntity, operand1: number): number => {
  if (objectTestFlags(operand1 & 0xffff, 2, 0) === 0) return 0;
  if (groupGetLeader(mech.groupId) === mechs.playerMechIndex) radioLanceMessage(5, mech.starSlot);
  return operand1;
});

// --- actions: (mech, rule) -> non-zero to fire -------------------------------

/**
 * Action 0: accept.
 *
 * @mw2 ai_rule_nop 0x000226b0
 * @fidelity exact
 */
export const aiRuleNop = registerCode('ai_rule_nop', 0x226b0, (): number => 1);

/**
 * Action 1: forget the saved state (pendingCount 0); accept.
 *
 * @mw2 ai_rule_clear_queue 0x000226c0
 * @fidelity exact
 */
export const aiRuleClearQueue = registerCode('ai_rule_clear_queue', 0x226c0, (mech: MechEntity): number => {
  mech.pendingCount = 0;
  return 1;
});

/**
 * Action 2: save (targetSecondary << 16 | aiState) in stateStack[0],
 * pendingCount at least 1; accept.
 *
 * @mw2 ai_rule_push_state 0x000226e0
 * @fidelity exact
 */
export const aiRulePushState = registerCode('ai_rule_push_state', 0x226e0, (mech: MechEntity): number => {
  const saved = ((mech.targetSecondary << 16) | (mech.aiState & 0xffff)) >>> 0;
  if (mech.pendingCount === 0) mech.pendingCount = 1;
  mech.stateStack[0] = saved;
  return 1;
});

/**
 * Action 3: pop the saved state and target back in (ai_try_enter_state, no
 * push); accepts only when there was nothing to pop.
 *
 * @mw2 ai_rule_pop_state 0x00022740
 * @fidelity exact
 */
export const aiRulePopState = registerCode('ai_rule_pop_state', 0x22740, (mech: MechEntity): number => {
  const n = mech.pendingCount;
  if (n !== 0) {
    mech.pendingCount = u16(n - 1);
    const e = mech.stateStack[u16(n - 1)]!;
    aiTryEnterState(mech, e & 0xffff, e >>> 16, 0);
  }
  return n === 0 ? 1 : 0;
});

/**
 * Action 4: post the rule's condition and the mech's targetHandle to its
 * group leader's leaderRequest pair, if the leader has none pending; declines.
 *
 * @mw2 ai_rule_post_to_leader 0x00023720
 * @fidelity exact
 */
export const aiRulePostToLeader = registerCode('ai_rule_post_to_leader', 0x23720, (mech: MechEntity, rule: AiRule): number => {
  const leader = i16(groupGetLeader(mech.groupId));
  if (leader !== -1) {
    const l = mechs.mechTable[leader]!;
    if (l.leaderRequest === 0) {
      l.leaderRequest = i16(rule.condition);
      l.leaderRequestArg = u16(mech.targetHandle);
    }
  }
  return 0;
});

// --- target arbitration ------------------------------------------------------

/**
 * The enumerate-and-validate search with the lance in mind: `out.nearest` the
 * nearest validated candidate, `out.unclaimed` the nearest no squadmate has
 * claimed (a member in state 2 or 3 with it as targetSecondary; claims count
 * for nothing while the group's objective type is 4). Both are re-checked
 * through ai_rule_cond_nearest_valid at `range` and zeroed if they fail.
 * Returns the squadmate holding the claim on the nearest candidate, or null.
 * Nothing at all is searched while the group has no current objective.
 * targetHandle is left on the last candidate judged.
 *
 * @mw2 ai_find_target_unclaimed 0x000221c0
 * @fidelity exact
 */
export function aiFindTargetUnclaimed(mech: MechEntity, designator: number, range: number, out: { unclaimed: number; nearest: number }): MechEntity | null {
  let claimer: MechEntity | null = null;
  out.nearest = 0;
  out.unclaimed = 0;
  let nearest = 100000000;
  let h = -1;
  const members: MechEntity[] = [];
  const count = groupCollectMembers(mech.groupId, members, 1);
  if (count === 0) return null;
  const cur = objectives.groupCurrentObjective[mech.groupId]!;
  if (cur === -1) return null;
  const objectiveType = objectives.objectiveTables[mech.groupId]!.objectives[cur]!.type & 0xffff;
  for (;;) {
    h = resolveTargetDesignator(mech, i16(designator), h & 0xffff);
    const s = i16(h);
    if (s === -1) break;
    let isNearest = false;
    mech.targetHandle = s;
    if (0 < aiValidateCurrentTarget(mech)) {
      if (mech.targetDistance >>> 0 < nearest >>> 0) {
        nearest = mech.targetDistance;
        out.nearest = s;
        isNearest = true;
        if ((h & 0x200) === 0) out.unclaimed = s;
      }
      if ((h & 0x200) !== 0) {
        for (let k = 0; k < count; k++) {
          const m = members[k]!;
          if (mech.index === m.index || (m.flags & 0x16) !== 0) continue;
          if ((m.targetSecondary & 0xf000) !== 0) continue;
          if (m.targetSecondary === s && (m.aiState === 3 || m.aiState === 2) && isNearest && i16(objectiveType) !== 4) {
            isNearest = false;
            claimer = m;
            break;
          }
        }
        if (isNearest) out.unclaimed = s;
      }
    }
  }
  if (out.unclaimed !== 0 && i16(aiRuleCondNearestValid(mech, out.unclaimed, i16(range))) === 0) out.unclaimed = 0;
  if (out.nearest !== 0 && i16(aiRuleCondNearestValid(mech, out.nearest, i16(range))) === 0) out.nearest = 0;
  return claimer;
}

/**
 * The target a new state brings: a concrete handle as it is; a designator
 * (0xf000 bits) resolved with ai_find_target_unclaimed, no range limit - to
 * the NEAREST candidate, except that a mech leaving state 2 takes the
 * unclaimed one, and when there is none, 0 (aiTargetUnclaimedFirst, always 1;
 * the nearest otherwise).
 *
 * @mw2 ai_state_target_unclaimed 0x00021d80
 * @fidelity exact
 */
export function aiStateTargetUnclaimed(mech: MechEntity, target: number): number {
  if ((i16(target) & 0xf000) === 0) return target;
  const out = { unclaimed: 0, nearest: 0 };
  aiFindTargetUnclaimed(mech, i16(target), -3, out);
  if (mech.aiState !== 2) return out.nearest;
  if (out.unclaimed !== 0) return out.unclaimed;
  return ai.aiTargetUnclaimedFirst !== 0 ? 0 : out.nearest;
}

/**
 * A live mech attacking this one - in state 3 with this mech as
 * targetSecondary, not on its side - as index | 0x200, or -1.
 *
 * @mw2 mech_find_attacker 0x00022790
 * @fidelity exact
 */
export function mechFindAttacker(mech: MechEntity): number {
  const me = mech.index & 0xffff;
  for (let i = 0; i < mechs.mechCount; i++) {
    const m = mechs.mechTable[i];
    if (!m || (m.flags & 6) !== 0) continue;
    if (m.targetSecondary !== i16(me | 0x200)) continue;
    if (mechsSameAllegiance(m.index, i16(me)) !== 0) continue;
    if (m.aiState === 3) return (m.index | 0x200) & 0xffff;
  }
  return -1;
}

/**
 * Before any rule: unless aiFlags bit 0 is set, turn on an attacker (state
 * 2, pushing the current state) unless already on it. A squadmate that has
 * claimed the attacker keeps it when its aiFlags has 0x40 (then this mech
 * does not retaliate), otherwise it is sent to state 0 and this mech goes.
 *
 * @mw2 mech_retaliate 0x00021b40
 * @fidelity exact
 */
export function mechRetaliate(mech: MechEntity): void {
  if ((mech.aiFlags & 1) !== 0) return;
  let t = u16(mechFindAttacker(mech));
  if (t === 0xffff) return;
  if (mech.targetSecondary === mech.returnWaypoint && mech.aiState === 8) return;
  if ((mech.aiState === 2 || mech.aiState === 3) && mech.targetSecondary === i16(t)) return;
  const claimer = aiFindTargetUnclaimed(mech, i16(t), -3, { unclaimed: 0, nearest: 0 });
  if (claimer) {
    if ((claimer.aiFlags & 0x40) === 0) aiTryEnterState(claimer, claimer.aiFlags & 0x40, 0, 0);
    else t = 0xffff;
  }
  if (t !== 0xffff) aiTryEnterState(mech, 2, t, 1);
}
