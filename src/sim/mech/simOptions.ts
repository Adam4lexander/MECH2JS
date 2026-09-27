/**
 * The rule toggles: the 8-byte SimOptions record MW2.EXE reads from
 * mw2dif.cfg, which the shell's options screen writes. The file is on the
 * port's own disk (engine/dosFiles.ts); SimRules is the host's way of
 * writing one.
 */
import { SimOptions } from '../../generated/classes.gen.ts';
import { mechs } from './mechGlobals.ts';

/** The SimOptions bytes, as booleans: see SimOptions in mw2_types.h for each. */
export interface SimRules {
  unlimitedAmmo: boolean;
  invulnerability: boolean;
  splashDamage: boolean;
  collisionDamage: boolean;
  heatTracking: boolean;
  /** 0 to 2: mech_load_config's armour scaling (enemy armour x1 / x3 / x4) */
  difficulty: number;
}

/**
 * The port's default: the full rules - the values the net-game override
 * forces - at difficulty 1. These are also the shell's own boot values
 * (simOptions at 0x7d40c in MW2SHELL.EXE: 0,0,1,1,1,1).
 */
export const DEFAULT_RULES: SimRules = {
  unlimitedAmmo: false,
  invulnerability: false,
  splashDamage: true,
  collisionDamage: true,
  heatTracking: true,
  difficulty: 1,
};

/** @portOnly the 8 bytes of mw2dif.cfg for a set of rules */
export function rulesToBytes(rules: SimRules): Uint8Array {
  return new Uint8Array([
    rules.unlimitedAmmo ? 1 : 0,
    rules.invulnerability ? 1 : 0,
    rules.splashDamage ? 1 : 0,
    rules.collisionDamage ? 1 : 0,
    rules.heatTracking ? 1 : 0,
    Math.max(0, Math.min(2, rules.difficulty | 0)),
    0,
    0,
  ]);
}

/**
 * main's sim_options_load("mw2dif.cfg", &simOptions): the file's record, or
 * a zeroed one (calloc(8, 1)) when there is none - every option off,
 * difficulty 0. In a net game the six known bytes are forced to the full
 * rules at the hardest level.
 *
 * @mw2 sim_options_load 0x0004c2c0
 * @fidelity exact
 */
export function simOptionsLoad(file: Uint8Array | null): number {
  const o = new SimOptions();
  if (file) {
    o.unlimitedAmmo = file[0] ?? 0;
    o.invulnerability = file[1] ?? 0;
    o.splashDamage = file[2] ?? 0;
    o.collisionDamage = file[3] ?? 0;
    o.heatTracking = file[4] ?? 0;
    o.difficulty = file[5] ?? 0;
  }
  mechs.simOptions = o;
  if (mechs.netGameEnabled !== 0) {
    o.unlimitedAmmo = 0;
    o.invulnerability = 0;
    o.splashDamage = 1;
    o.collisionDamage = 1;
    o.heatTracking = 1;
    o.difficulty = 2;
  }
  return 1;
}
