/**
 * The rule toggles: the 8-byte SimOptions record. The original reads it from
 * mw2dif.cfg, which the shell's options screen writes; the port does not
 * depend on the install's config files, so the host supplies the record
 * (its own settings) and the loader is otherwise the original's.
 */
import { SimOptions } from '../../generated/classes.gen.ts';
import { mechs } from './mechGlobals.ts';

/** The SimOptions bytes the port's host sets: see SimOptions in mw2_types.h for each. */
export interface SimRules {
  unlimitedAmmo: boolean;
  invulnerability: boolean;
  splashDamage: boolean;
  collisionDamage: boolean;
  heatTracking: boolean;
  /** 0 to 2: mech_load_config's armour scaling (enemy armour x1 / x3 / x4) */
  difficulty: number;
}

/** The port's default: the full rules - the values the net-game override forces - at difficulty 1. */
export const DEFAULT_RULES: SimRules = {
  unlimitedAmmo: false,
  invulnerability: false,
  splashDamage: true,
  collisionDamage: true,
  heatTracking: true,
  difficulty: 1,
};

/**
 * main's sim_options_load("mw2dif.cfg", &simOptions): the loaded record, or
 * a zeroed one (calloc(8, 1)) when there is none - every option off,
 * difficulty 0. In a net game the six known bytes are forced to the full
 * rules at the hardest level.
 *
 * @mw2 sim_options_load 0x0004c2c0
 * @fidelity partial
 * @divergence the record is the host's rules, not the file mw2dif.cfg
 */
export function simOptionsLoad(rules: SimRules | null): number {
  const o = new SimOptions();
  if (rules) {
    o.unlimitedAmmo = rules.unlimitedAmmo ? 1 : 0;
    o.invulnerability = rules.invulnerability ? 1 : 0;
    o.splashDamage = rules.splashDamage ? 1 : 0;
    o.collisionDamage = rules.collisionDamage ? 1 : 0;
    o.heatTracking = rules.heatTracking ? 1 : 0;
    o.difficulty = Math.max(0, Math.min(2, rules.difficulty | 0));
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
