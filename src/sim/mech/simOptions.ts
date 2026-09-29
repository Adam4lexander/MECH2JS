/**
 * The rule toggles: the 8-byte SimOptions record MW2.EXE reads from
 * mw2dif.cfg, which the shell's options panel (COMBAT VARIABLES) writes.
 * The file is on the port's own disk (engine/dosFiles.ts); SimRules is the
 * host's (and the tests') way of writing one.
 */
import { SimOptions } from '../../generated/classes.gen.ts';
import { divergence } from '../../core/provenance.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
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
 * The port's MW2DIF.CFG when its disk has none (simOptionsFileEnsure): the
 * full rules at difficulty 1 (MEDIUM). These are the shell's own boot
 * values (simOptions at 0x7d40c in MW2SHELL.EXE: 0,0,1,1,1,1,0,0) - what
 * its options panel writes when the file was missing
 * (test/sim/shellOptions.test.ts checks it).
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

/**
 * MW2DIF.CFG as MW2.EXE's main is about to open it. The port's disk always
 * holds one: a disk that lacks it (a first run, a test's disk) is given
 * DEFAULT_RULES, written into the port's own layer, first.
 *
 * @portOnly the port's first run, for sim_options_load's file
 */
export function simOptionsFileEnsure(): Uint8Array {
  const f = dosFileLoad('MW2DIF.CFG');
  if (f) return f;
  divergence("no MW2DIF.CFG on the disk: the port writes its own (the shell's boot simOptions) rather than MW2.EXE reading none - the original's all-off, EASY record - or the installer's copy", 'sim_options_load');
  const bytes = rulesToBytes(DEFAULT_RULES);
  dosFileWrite('MW2DIF.CFG', bytes);
  return bytes;
}
