/**
 * Globals of the mech tick hooks: the player's cockpit requests, the MASC,
 * the feet-to-torso alignment, heat warnings and the latches the hooks keep.
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const mechRuntime = registerGlobals(
  'mechRuntime',
  {
    /** 0x9620c: the player is out of the fight - destroyed, or ejected and the ejection camera done */
    playerOut: 0,
    /** 0x961f8: the player's MASC is engaged */
    mascEngaged: 0,
    /** 0x96218: simTick of the last MASC malfunction roll */
    mascLastRollTick: 0,
    /** 0x982ec: FEET_TO_TORSO is turning the legs toward the torso */
    alignLegsToTorso: 0,
    /** 0x96214: the player's heading as of the previous tick */
    lastPlayerHeading: 0,
    /** 0x961ec: the player's jump fuel is not burnt */
    cheatInfiniteJumpjets: 0,
    /** 0x96210: -1 shut down, +1 power up (the reactor keys) */
    reactorRequest: 0,
    /** 0x961f0 */
    jettisonAmmoRequest: 0,
    /** 0x961f4 */
    mascToggleRequest: 0,
    /** 0x9831c, 0x98320: a debug hit on the player's mech (-1: none) */
    testDamageSlot: -1,
    testDamageLocation: -1,
    /** 0x961e0, 0xfb530: the player's 'Heat level critical' warning latch and when it was set */
    heatWarningLatch: 0,
    heatWarningTick: 0,
    /** 0x961d0 */
    autoEjectEnabled: 0,
    /** 0x96200: a pending weapon-cycle request; no writer in the exported C */
    dat00096200: 0,
    /** 0x96220: mech_std_tick_player's death latch */
    dat00096220: 0,
    /** 0x9621c: mech_std_tick_player's ejection latch */
    dat0009621c: 0,
    /** 0x96204, 0x96208: set on becoming airborne while 0x96208 is; neither is established */
    dat00096204: 0,
    dat00096208: 0,
    /** 0xfb534: the player has hit a wall since the last clean step (the collision sound and view kick fire once) */
    dat000fb534: 0,
  },
  () => {
    const r = mechRuntime;
    r.playerOut = imageI32(LABEL.playerOut, 0);
    r.mascEngaged = imageI32(LABEL.mascEngaged, 0);
    r.mascLastRollTick = imageI32(LABEL.mascLastRollTick, 0);
    r.alignLegsToTorso = imageI32(LABEL.alignLegsToTorso, 0);
    r.lastPlayerHeading = imageI32(LABEL.lastPlayerHeading, 0);
    r.cheatInfiniteJumpjets = imageI32(LABEL.cheatInfiniteJumpjets, 0);
    r.reactorRequest = imageI32(LABEL.reactorRequest, 0);
    r.jettisonAmmoRequest = imageI32(LABEL.jettisonAmmoRequest, 0);
    r.mascToggleRequest = imageI32(LABEL.mascToggleRequest, 0);
    r.testDamageSlot = imageI32(LABEL.testDamageSlot, -1);
    r.testDamageLocation = imageI32(LABEL.testDamageLocation, -1);
    r.heatWarningLatch = imageI32(LABEL.heatWarningLatch, 0);
    r.heatWarningTick = imageI32(LABEL.heatWarningTick, 0);
    r.autoEjectEnabled = imageI32(LABEL.autoEjectEnabled, 0);
    r.dat00096200 = imageI32(0x96200, 0);
    r.dat00096220 = imageI32(0x96220, 0);
    r.dat0009621c = imageI32(0x9621c, 0);
    r.dat00096204 = imageI32(0x96204, 0);
    r.dat00096208 = imageI32(0x96208, 0);
    r.dat000fb534 = imageI32(0xfb534, 0);
  },
);
