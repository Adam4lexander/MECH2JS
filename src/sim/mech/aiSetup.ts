/**
 * The AI set-up every create hook ends with (mech_ai_setup): the GPS
 * chunk's think delay, ranges and skill for a local-AI mech, the reset of
 * its AI state, and its behaviour state and capability bits.
 *
 * Only the load-time part is ported here. What these functions call into
 * the AI proper - the rule tables (ai_set_state_rule_block's lookup,
 * ai_rules_rebuild, the per-mech rule list at 0xf44e8), the combat state
 * machine and the behaviour transition tables - is Phase 2 and marked where
 * it is skipped.
 *
 * These belong under src/ai; they live here because this cluster's files are
 * sim/mech and sim/groups.
 */
import type { MechEntity } from '../../generated/classes.gen.ts';
import { u8 } from '../../core/int/cint.ts';
import { divergence } from '../../core/provenance.ts';
import { groupGetLeader } from '../groups/groups.ts';
import { mechs } from './mechGlobals.ts';

/**
 * Clears the mech's weapon_fire control, then runs its aiState's exit
 * handling (states 2, 3, 5, 6, 7) and clears aiFlags bit 0x10.
 *
 * @mw2 ai_run_combat_state 0x00022a90
 * @fidelity partial
 * @divergence the state cases (2, 3, 5, 6, 7: object tests, radio messages, behaviour exit, waypoint reclaim) are Phase 2; only the default path, the one mech_ai_setup reaches with aiState 0, is ported
 */
export function aiRunCombatState(mech: MechEntity): void {
  mech.control!.weapon_fire = 0;
  switch (mech.aiState) {
    case 2:
    case 3:
    case 5:
    case 6:
    case 7:
      divergence(`ai_run_combat_state: aiState ${mech.aiState} is Phase 2 (AI)`, 'ai_run_combat_state');
      return;
    default:
      break;
  }
  // (aiFlags & ~0x10) | (byte)(param_4 & 0xffffff00): the OR adds nothing on this path
  mech.aiFlags = (mech.aiFlags & 0xffef) & 0xffff;
}

/**
 * Points stateRules[slot] at one of the nine AIT rule tables by
 * gamepieceClass, ruleIndex and whether the mech leads its group; a
 * ruleIndex of -1 clears the block.
 *
 * @mw2 ai_set_state_rule_block 0x00023d50
 * @fidelity partial
 * @divergence the table lookup (aiRuleSelectState*, aiRuleTables) is Phase 2: a non-(-1) ruleIndex leaves the block unchanged
 */
export function aiSetStateRuleBlock(mech: MechEntity, slot: number, ruleIndex: number, leaderIndex: number): void {
  if (((ruleIndex << 16) >> 16) === -1) {
    mech.stateRules[slot] = null;
    return;
  }
  void leaderIndex;
  divergence('ai_set_state_rule_block: rule tables are Phase 2 (AI)', 'ai_set_state_rule_block');
}

/**
 * Resets a mech's AI: combat state, targets, aiFlags, aiState (12 for a
 * local-AI mech, else 0), the three rule blocks, the pending counters, and
 * the 'none' return waypoint.
 *
 * @mw2 mech_ai_reset 0x00021a80
 * @fidelity partial
 * @divergence the active rule list (*ruleSet) and ai_rules_rebuild are Phase 2; returnWaypoint is compared as the ushort field, not the dword the C reads (its upper half is padding)
 */
export function mechAiReset(mech: MechEntity): void {
  aiRunCombatState(mech);
  mech.targetPrimary = 0;
  mech.targetSecondary = 0;
  mech.aiFlags = 0;
  mech.aiState = mech.controlSource === 2 ? 0xc : 0;
  for (let i = 0; i < 3; i++) aiSetStateRuleBlock(mech, i, -1, 0);
  // *mech->ruleSet = 0: the rule list at 0xf44e8 is Phase 2
  mech.pendingCount = 0;
  mech.leaderRequest = 0;
  mech.nextThinkTick = 0;
  if (mech.returnWaypoint === 0) {
    // tracked_object_remove(mech->index, 0): handle 0 has no 0x100 type bit, so it returns -1 at its guard
    mech.returnWaypoint = 0x1000;
  }
  divergence('ai_rules_rebuild is Phase 2 (AI): MechEntity.ruleSet is not filled', 'mech_ai_reset');
}

/**
 * Behaviour state and capabilities: behaviour 0xff, avoidance cleared,
 * aiSkillLevel forced into 1..4, and aiCapabilities bits 0..6 derived from
 * it (level 1 the most capable).
 *
 * @mw2 ai_behaviour_init 0x0002c5f0
 * @fidelity partial
 * @divergence the once-per-run fill of aiBehaviourSets (0xfdf10, the transition tables ai_choose_behaviour draws from) is Phase 2
 */
export function aiBehaviourInit(mech: MechEntity): void {
  mech.aiBehaviour = 0xff;
  mech.prevBehaviour = 0xff;
  mech.pendingBehaviour = 0;
  mech.avoidObstacle = null;
  mech.avoidTurnSign = 0;
  mech.avoidProbeScale = 1;
  mech.avoidNextCheck = 0;
  mech.behindSectorClaims.fill(0);
  if (mech.aiSkillLevel === 0 || 4 < mech.aiSkillLevel) mech.aiSkillLevel = 1;
  const lvl = mech.aiSkillLevel;
  const isMech = mech.gamepieceClass === 1;
  let bits = 0;
  if (lvl < 4) bits |= 1;
  if (lvl < 4) bits |= 2;
  if (lvl < 3) bits |= 4;
  if (isMech && lvl < 6) bits |= 8;
  if (lvl < 5) bits |= 0x10;
  if (isMech && lvl < 2) bits |= 0x20;
  if (lvl < 6) bits |= 0x40;
  // each bit is cleared in the low byte and ORed back in turn; the upper bits are kept
  mech.aiCapabilities = ((mech.aiCapabilities & ~0x7f) | bits) | 0;
}

/**
 * A mech's AI at creation: aiState 0, return waypoint 'none', mech_ai_reset,
 * engageEnabled unless in the player's group, and for a local-AI mech
 * (controlSource 2) the GPS values - think delay (0 read as 1, then + 1),
 * the three ranges in metres (0 read as 250) to centimetres, and the skill
 * level (0 read as 1) - then ai_behaviour_init.
 *
 * @mw2 mech_ai_setup 0x00021920
 * @fidelity partial
 * @divergence MechEntity.ruleSet is not pointed at its record at 0xf44e8 (the rule lists are Phase 2)
 */
export function mechAiSetup(mech: MechEntity): void {
  mech.aiState = 0;
  mech.returnWaypoint = 0x1000; // a dword store: the two pad bytes after it are zeroed too
  // mech->ruleSet = 0xf44e8 + index * 0x18: Phase 2
  mechAiReset(mech);
  mech.engageEnabled = mech.groupId !== mechs.mechTable[mechs.playerMechIndex]!.groupId ? 1 : 0;
  if (mech.controlSource === 2) {
    const leader = groupGetLeader(mech.groupId);
    aiSetStateRuleBlock(mech, 0, 0, (leader << 16) >> 16);
    mech.thinkDelay = u8(mech.gpsParams[0]!);
    if (mech.thinkDelay === 0) mech.thinkDelay = 1;
    mech.aiRangeOp4 = mech.gpsParams[1]!;
    if (mech.aiRangeOp4 === 0) mech.aiRangeOp4 = 0xfa;
    mech.aiRangeOp1 = mech.gpsParams[2]!;
    if (mech.aiRangeOp1 === 0) mech.aiRangeOp1 = 0xfa;
    mech.aiRangeOp2 = mech.gpsParams[3]!;
    if (mech.aiRangeOp2 === 0) mech.aiRangeOp2 = 0xfa;
    mech.aiSkillLevel = u8(mech.gpsParams[4]!);
    if (mech.aiSkillLevel === 0) mech.aiSkillLevel = 1;
    mech.thinkDelay = u8(mech.thinkDelay + 1);
    mech.aiRangeOp4 = Math.imul(mech.aiRangeOp4, 100);
    mech.aiRangeOp1 = Math.imul(mech.aiRangeOp1, 100);
    mech.aiRangeOp2 = Math.imul(mech.aiRangeOp2, 100);
  }
  aiBehaviourInit(mech);
}
