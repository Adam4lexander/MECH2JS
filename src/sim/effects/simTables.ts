/**
 * The two pre-built pools the mission stream stocks: projectiles[175] (the
 * BTHG chunk gives slots a kind and a scene node, projectileSlotFill being
 * its cursor) and simSlots[256], the effects (the XPLO chunk pre-builds them,
 * xploSlotFill its cursor). In the original the two tables are exactly
 * adjacent; sim_tables_reset clears both.
 *
 * Neither cursor is ever reset (label notes): each pool is stocked once per
 * run of MW2.EXE.
 */
import { Projectile, SimSlot } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const PROJECTILE_COUNT = 0xaf;
export const SIM_SLOT_COUNT = 0x100;

function bootSimTables() {
  return {
    /** Projectile[175], zero in the image */
    projectiles: Array.from({ length: PROJECTILE_COUNT }, () => new Projectile()),
    /** SimSlot[256], zero in the image */
    simSlots: Array.from({ length: SIM_SLOT_COUNT }, () => new SimSlot()),
    /** 0x9ebb8: the next projectiles[] slot a BTHG chunk stocks; refused at 0xaf */
    projectileSlotFill: imageI32(LABEL.projectileSlotFill, 0),
    /** 0x9ebbc: the next simSlots entry an XPLO chunk fills; refused at 0x100 */
    xploSlotFill: imageI32(LABEL.xploSlotFill, 0),
    /**
     * 0x153924: the missile camera's pose, seven dwords {x, y, z, yaw, pitch,
     * roll, valid}; projectile_update writes it for the followed missile and
     * sim_tables_reset zeroes it
     */
    missileCamPose: new Int32Array(7),
    /**
     * 0xa5630..0xa567f: 80 bytes sim_tables_reset zeroes. Code in the ai_group
     * module increments words at unaligned offsets inside it (0xa5637,
     * 0xa5639, 0xa563b, 0xa564e ...); what they count is NOT established.
     */
    dat000a5630: new Uint8Array(0x50),
  };
}

export const simTables = registerGlobals('simTables', bootSimTables(), () => {
  Object.assign(simTables, bootSimTables());
});

/**
 * Empties both pools: every projectile gets id -1, no node and
 * projectile_clear; every sim slot no node, no sprite (-1), type -1 and zero
 * position, time, active and light ownership. Also zeroes missileCamPose and
 * the 80 bytes at 0xa5630.
 *
 * @mw2 sim_tables_reset 0x00050540
 * @fidelity exact
 */
export function simTablesReset(): void {
  const t = simTables;
  for (let i = 0; i < PROJECTILE_COUNT; i++) {
    const p = t.projectiles[i]!;
    p.id = -1;
    p.node = null;
    projectileClear(i);
  }
  for (const s of t.simSlots) {
    s.node = null;
    s.bitmapSlot = -1;
    s.typeIndex = -1;
    s.z = 0;
    s.timeLeft = 0;
    s.active = 0;
    s.ownsLight = 0;
    s.y = s.z;
    s.x = s.z;
  }
  t.missileCamPose.fill(0);
  t.dat000a5630.fill(0);
}

/**
 * Zeroes one projectile's motion, timers, damage, heat, homing target,
 * active, motionHeld and missileCam, and sets its effect bytes to 0xff. id,
 * node and attackerMechIndex are left alone.
 *
 * @mw2 projectile_clear 0x00050660
 * @fidelity exact
 * @divergence the dword at +0x28 (pad_028, zeroed here) has no field in the live Projectile class
 */
export function projectileClear(slot: number): void {
  const p = simTables.projectiles[slot]!;
  p.velZ = 0;
  p.accelZ = 0;
  p.timeLeft = 0;
  p.effectIndex = 0xff;
  p.impactFlags = 0xff;
  p.effectHigh = 0xffff;
  p.targetIndex = 0;
  p.targetType = 0;
  p.active = 0;
  p.motionHeld = 0;
  p.heatOnHit = 0;
  p.missileCam = 0;
  p.velY = p.velZ;
  p.velX = p.velZ;
  p.accelY = p.accelZ;
  p.accelX = p.accelZ;
  p.age = p.timeLeft;
  p.damage = p.heatOnHit;
}
