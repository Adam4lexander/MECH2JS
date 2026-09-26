/**
 * MechLoadouts: the 0x852-byte block every gamepiece class allocates in its
 * createLoadout (gamepieceClasses column 1). One allocation holds the
 * MechLoadout header (0x10e bytes) followed by its three arrays, which the
 * header reaches through pointers:
 *
 *   +0x10e  MechWeapon[10]    (0x68 each)  loadout->weapons  (+0x54)
 *   +0x51e  MechSection[8]    (0x28 each)  loadout->sections (+0x58)
 *   +0x65e  MechAmmoBin[0x19] (0x14 each)  loadout->ammo     (+0x5c)
 *
 * 0x10e + 0x410 + 0x140 + 0x1f4 = 0x852, mech_loadout_size.
 *
 * The generated MechLoadout class types those three pointers as pointers to
 * ONE element (the header declares them `struct MechWeapon *`), so the port
 * keeps the arrays beside the loadout (loadoutArrays) and stores element 0 in
 * the pointer fields, which is what the C pointers hold. Code that indexes
 * `loadout->weapons[i]` uses loadoutWeapons(l)[i].
 */
import { MechAmmoBin, MechLoadout, MechSection, MechWeapon } from '../../generated/classes.gen.ts';
import type { MechEntity } from '../../generated/classes.gen.ts';
import { registerCode } from '../../engine/codePtr.ts';

export const LOADOUT_SIZE = 0x852;
export const LOADOUT_WEAPONS = 10;
export const LOADOUT_SECTIONS = 8;
export const LOADOUT_AMMO_BINS = 0x19;

/** The three arrays that share a loadout's allocation. */
export interface LoadoutArrays {
  weapons: MechWeapon[];
  sections: MechSection[];
  ammo: MechAmmoBin[];
}

const arrays = new WeakMap<MechLoadout, LoadoutArrays>();

/**
 * The arrays of a loadout made by one of the createLoadout functions.
 *
 * @portOnly the C reaches them through loadout->weapons / sections / ammo, pointers into the same block
 */
export function loadoutArrays(l: MechLoadout): LoadoutArrays {
  const a = arrays.get(l);
  if (!a) throw new Error('MechLoadout was not made by a createLoadout function');
  return a;
}

/** loadout->weapons as an array. @portOnly */
export const loadoutWeapons = (l: MechLoadout): MechWeapon[] => loadoutArrays(l).weapons;
/** loadout->sections as an array. @portOnly */
export const loadoutSections = (l: MechLoadout): MechSection[] => loadoutArrays(l).sections;
/** loadout->ammo as an array. @portOnly */
export const loadoutAmmo = (l: MechLoadout): MechAmmoBin[] => loadoutArrays(l).ammo;

/**
 * static_malloc(0x852) and the three internal pointers, as every
 * createLoadout does before resetting records.
 *
 * @portOnly the allocation half the three createLoadout functions share
 * @divergence the port's records start zeroed; the original's hold whatever the arena did (static_malloc does not clear)
 */
function loadoutAllocate(): MechLoadout {
  const l = new MechLoadout();
  const a: LoadoutArrays = {
    weapons: Array.from({ length: LOADOUT_WEAPONS }, () => new MechWeapon()),
    sections: Array.from({ length: LOADOUT_SECTIONS }, () => new MechSection()),
    ammo: Array.from({ length: LOADOUT_AMMO_BINS }, () => new MechAmmoBin()),
  };
  arrays.set(l, a);
  l.weapons = a.weapons[0]!; // +0x10e
  l.sections = a.sections[0]!; // +0x51e
  l.ammo = a.ammo[0]!; // +0x65e
  return l;
}

/**
 * The size of a MechLoadout block.
 *
 * @mw2 mech_loadout_size 0x000287b0
 * @fidelity exact
 */
export function mechLoadoutSize(): number {
  return LOADOUT_SIZE;
}

/**
 * The standard classes' createLoadout (1, 2, 4, 5, 6, 8): allocates the
 * loadout, links it both ways with the entity, clears the eight section
 * nodes, and resets all ten weapons and all 0x19 ammo bins.
 *
 * @mw2 mech_std_create_loadout 0x00028690
 * @fidelity exact
 * @divergence MechEntity +0x24 (pad_024 in the header, no port field) is written 0x10e; nothing reads it
 */
export const mechStdCreateLoadout = registerCode('mech_std_create_loadout', 0x28690, (_mechIndex: number, entity: MechEntity): number => {
  entity.loadout = null;
  const l = loadoutAllocate();
  const a = loadoutArrays(l);
  l.entity = entity;
  l.sectionNodes.fill(null); // clib_sub_062c07(loadout + 0x68, 0, _, 8): a dword fill
  // entity +0x24 = 0x10e: no field in the port
  entity.loadout = l;
  for (const w of a.weapons) {
    w.slotState = -1;
    w.type = -1;
    w.fireState = -1;
    w.stateTick = 0;
    // +0x14 = 0: pad_014, no field in the port
    w.ammo = -1;
    w.fireGroup = 0;
    w.lockIndex = -1;
    w.lockType = 0;
    w.shotsLeft = 0;
    w.sectionIndex = -1;
    w.slotCode = 0;
    w.numBins = 0;
    w.originalIndex = 0;
  }
  for (const b of a.ammo) {
    b.field_0x0 = 0xffff;
    b.rounds = 0;
    b.weaponIndex = -1;
    b.slotCode = 0;
    // +0x08 = 0: pad, no field in the port
    b.damagePerRound = 0;
    b.field_0xc = 0;
    b.field_0x10 = 0;
  }
  return 1;
});

/**
 * The shared body of mech_alt_create_loadout and door_create_loadout: the
 * same allocation and links as the standard one, but only six fields of each
 * weapon are reset and the ammo bins not at all.
 */
function loadoutCreateShort(entity: MechEntity): number {
  entity.loadout = null;
  void mechLoadoutSize(); // both ask mech_loadout_size for the allocation size
  const l = loadoutAllocate();
  const a = loadoutArrays(l);
  l.entity = entity;
  l.sectionNodes.fill(null);
  // entity +0x24 = 0x10e: no field in the port
  entity.loadout = l;
  for (const w of a.weapons) {
    w.slotState = -1;
    w.type = -1;
    w.fireState = -1;
    w.stateTick = 0;
    // +0x14 = 0: pad_014, no field in the port
    w.ammo = -1;
  }
  return 1;
}

/**
 * Class 3's createLoadout (the artillery turrets).
 *
 * @mw2 mech_alt_create_loadout 0x0002ef30
 * @fidelity exact
 * @divergence MechEntity +0x24 (no port field) is written 0x10e; nothing reads it
 */
export const mechAltCreateLoadout = registerCode('mech_alt_create_loadout', 0x2ef30, (_mechIndex: number, entity: MechEntity): number =>
  loadoutCreateShort(entity),
);

/**
 * Class 7's createLoadout (GP_MW2DOOR); byte for byte the same as class 3's.
 *
 * @mw2 door_create_loadout 0x00033630
 * @fidelity exact
 * @divergence MechEntity +0x24 (no port field) is written 0x10e; nothing reads it
 */
export const doorCreateLoadout = registerCode('door_create_loadout', 0x33630, (_mechIndex: number, entity: MechEntity): number =>
  loadoutCreateShort(entity),
);
