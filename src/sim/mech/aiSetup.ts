/**
 * The AI set-up every create hook ends with (mech_ai_setup): the mech's rule
 * list, the reset of its AI state, the GPS chunk's think delay, ranges and
 * skill for a local-AI mech, and its behaviour state and capability bits.
 * The AI itself is in src/sim/ai.
 */
import type { MechEntity } from '../../generated/classes.gen.ts';
import { u8 } from '../../core/int/cint.ts';
import { ai } from '../ai/aiGlobals.ts';
import { aiBehaviourInit } from '../ai/behaviours.ts';
import { aiRulesRebuild, aiSetStateRuleBlock } from '../ai/rules.ts';
import { aiRunCombatState } from '../ai/states.ts';
import { trackedObjectRemove } from '../ai/tracked.ts';
import { groupGetLeader } from '../groups/groups.ts';
import { mechs } from './mechGlobals.ts';

/**
 * Resets a mech's AI: the exit of its current state, targets, aiFlags,
 * aiState (12 for a local-AI mech, else 0), the three rule blocks, the rule
 * list, the pending counters, the 'none' return waypoint, and a rebuild of
 * the (now empty) rule list.
 *
 * @mw2 mech_ai_reset 0x00021a80
 * @fidelity exact
 */
export function mechAiReset(mech: MechEntity): void {
  aiRunCombatState(mech);
  mech.targetPrimary = 0;
  mech.targetSecondary = 0;
  mech.aiFlags = 0;
  mech.aiState = mech.controlSource === 2 ? 0xc : 0;
  for (let i = 0; i < 3; i++) aiSetStateRuleBlock(mech, i, -1, 0);
  mech.ruleSet![0] = null;
  mech.pendingCount = 0;
  mech.leaderRequest = 0;
  mech.nextThinkTick = 0;
  if (mech.returnWaypoint === 0) {
    // handle 0 has no 0x100 type bit, so this returns -1 at its guard
    trackedObjectRemove(mech.index, 0);
    mech.returnWaypoint = 0x1000;
  }
  aiRulesRebuild(mech);
}

/**
 * A mech's AI at creation: aiState 0, return waypoint 'none', its rule list
 * (the mech's 0xf44e8 record), mech_ai_reset, engageEnabled unless in the
 * player's group, and for a local-AI mech (controlSource 2) its default rule
 * block and the GPS values - think delay (0 read as 1, then + 1), the three
 * ranges in metres (0 read as 250) to centimetres, and the skill level (0
 * read as 1) - then ai_behaviour_init.
 *
 * @mw2 mech_ai_setup 0x00021920
 * @fidelity exact
 */
export function mechAiSetup(mech: MechEntity): void {
  mech.aiState = 0;
  mech.returnWaypoint = 0x1000; // a dword store: the two pad bytes after it are zeroed too
  mech.ruleSet = ai.ruleLists[mech.index]!;
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
