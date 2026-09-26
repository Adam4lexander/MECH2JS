/**
 * The gamepiece tables: mechTable (60 MechEntity pointers - every mech,
 * vehicle, turret, door and dropship is a "mech" to the engine), the 16
 * groups (stars/lances) and their formations.
 */
import { ControlState, MechGroup, SimOptions, StarFormation } from '../../generated/classes.gen.ts';
import type { MechEntity } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const MECH_TABLE_SIZE = 60;
export const GROUP_COUNT = 16;

export const mechs = registerGlobals(
  'mechs',
  {
    /** 0xf8a40 */
    mechTable: new Array<MechEntity | null>(MECH_TABLE_SIZE).fill(null),
    /** 0x961c8 */
    mechCount: 0,
    /** 0x95870 */
    playerMechIndex: 0,
    /** 0x9eb9c: the gamepiece the chunks that follow a GP apply to */
    currentGamepiece: null as MechEntity | null,
    /** 0xfb564 */
    groupTable: Array.from({ length: GROUP_COUNT }, () => new MechGroup()),
    /** 0xfb7c4 */
    formationTable: Array.from({ length: GROUP_COUNT }, () => new StarFormation()),
    /** 0x96294 */
    playerGroupIndex: 0,
    /** per affiliation (8): 0 the player's side, 1 enemy - set by GPS chunks */
    affiliationAllegiance: new Int8Array(8),
    /** 0x982c8 */
    netGameEnabled: 0,
    /**
     * 0x98344: the player's ControlState, which input fills and the player's
     * MechEntity.control points at (mech_spawn stores this address).
     */
    playerControls: new ControlState(),
    /**
     * *0x9586c: the SimOptions simOptions points at (mw2dif.cfg, loaded by
     * sim_options_load - the port's host supplies the record; the pointer is 0
     * in the image). mech_load_config reads difficulty from it.
     */
    simOptions: new SimOptions(),
    /** 0x9587c: the -R option; mech_std_create starts the player on autopilot when set */
    keepPlayerControls: 0,
    /**
     * 0x96eec: set to 1 by mech_std_create for the player's mech under
     * keepPlayerControls. Unnamed in the decompilation - what reads it is not
     * established.
     */
    DAT_00096eec: 0,
  },
  () => {
    const m = mechs;
    m.mechTable = new Array<MechEntity | null>(MECH_TABLE_SIZE).fill(null);
    m.mechCount = imageI32(LABEL.mechCount, 0);
    m.playerMechIndex = imageI32(LABEL.playerMechIndex, 0);
    m.currentGamepiece = null;
    m.groupTable = Array.from({ length: GROUP_COUNT }, () => new MechGroup());
    m.formationTable = Array.from({ length: GROUP_COUNT }, () => new StarFormation());
    m.playerGroupIndex = imageI32(LABEL.playerGroupIndex, 0);
    m.affiliationAllegiance = new Int8Array(8);
    m.netGameEnabled = imageI32(LABEL.netGameEnabled, 0);
    m.playerControls = new ControlState();
    m.simOptions = new SimOptions();
    m.keepPlayerControls = imageI32(LABEL.keepPlayerControls, 0);
    m.DAT_00096eec = imageI32(0x96eec, 0);
  },
);
