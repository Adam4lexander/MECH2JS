/**
 * The AI's own globals: the rule tables and per-mech rule lists, the
 * behaviour transition sets, and the flags a few AI functions share.
 *
 * Object handles throughout the AI are (type << 8) | index - type 1 a
 * tracked object, 2 a mech, 4 a gamething - with 0x1000 the NONE bit, and
 * 0x2000 / 0x4000 marking a symbolic designator (targetDesignatorNames)
 * rather than an object (resolve_target_designator).
 */
import type { AiRule, BehaviourTransition } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { MECH_TABLE_SIZE } from '../mech/mechGlobals.ts';

/**
 * One AIT resource as ai_rules_rebuild and mech_has_rules_for_state read it:
 * the (aiState, ruleCount) index and, flat, every 12-byte record after it -
 * rules[k] is the record at payload offset index.length * 4 + 2 + k * 12, so
 * ai_rules_rebuild's (short)(N * 4 + 2 + prior * 12) is rules[prior].
 *
 * @portOnly the parsed form of an AIT payload (the C keeps the raw bytes)
 */
export interface AiRuleBlock {
  resourceId: number;
  index: { aiState: number; ruleCount: number }[];
  rules: AiRule[];
}

/**
 * An AiBehaviourSet with its rows resolved: rowCount BehaviourTransition rows
 * (stride 18) read from the EXE at the address ai_behaviour_init stores.
 *
 * @portOnly the AiBehaviourSet record with its rows pointer followed
 */
export interface BehaviourSet {
  rowCount: number;
  nonStartRows: number;
  rows: BehaviourTransition[];
  /** the rows' address in MW2.EXE, for the inspector */
  rowsAddress: number;
}

/** 0xf44e8: one 0x18-byte record per mech, the six AiRule pointers MechEntity.ruleSet points at */
export const RULE_LIST_SLOTS = 6;

function bootAi() {
  return {
    /** 0xf4a88: AIT resources 1..9 by id; slot 0 is zeroed and never filled (ai_rule_tables_load) */
    aiRuleTables: new Array<AiRuleBlock | null>(10).fill(null),
    /** 0xf44e8: the per-mech rule lists (ai_rules_rebuild writes them through MechEntity.ruleSet) */
    ruleLists: Array.from({ length: MECH_TABLE_SIZE }, () => new Array<AiRule | null>(RULE_LIST_SLOTS).fill(null)),
    /** 0x96600: 0 until ai_behaviour_init first fills the sets */
    aiBehaviourSetsReady: imageI32(LABEL.aiBehaviourSetsReady, 0),
    /** 0xfdf10: AiBehaviourSet[8] by gamepieceClass - 1 */
    aiBehaviourSets: new Array<BehaviourSet | null>(8).fill(null),
    /** 0xfdf50: the set for loadout->tons == 1 (the Elementals) */
    aiBehaviourSetElemental: null as BehaviourSet | null,
    /** 0x9600c: the lairdo cheat - agp_friendly then also takes any mech of allegiance 0 */
    cheatFriendlyAllies: imageI32(LABEL.cheatFriendlyAllies, 0),
    /** 0x96010: 1 in the image and never written - team_target and ai_state_target_unclaimed prefer an unclaimed target */
    aiTargetUnclaimedFirst: imageI32(LABEL.aiTargetUnclaimedFirst, 1),
    /**
     * 0x96018: set by group_apply_objective once the player's group gets an
     * objective other than type 0x10; from then on that function no longer
     * changes the player's lancemates' states. Unnamed: only these two uses
     * are established.
     */
    dat00096018: imageI32(0x96018, 0),
    /** 0xf4ab0: stamped with simTick (+0xb6 in some states) by ai_state_move and ai_apply_state; nothing in the decompiled source reads it */
    dat000f4ab0: 0,
    /** 0xf4ab4: zeroed by mech_ai_think for mech 0 and read nowhere in the decompiled source */
    dat000f4ab4: 0,
  };
}

export const ai = registerGlobals('ai', bootAi(), () => {
  Object.assign(ai, bootAi());
});
