/**
 * The mech lab's design: the variant being browsed or edited, as the
 * shell keeps it in its data segment (designMaxMass .. designLocations,
 * mechlabUnplaced, designCriticals, the mek* record), and the rules every
 * CUSTOMIZE handler applies to it (decompiled/mw2shell/src/screens/
 * shell_2a5e0_part1.c and part2.c; README "Design rules the mech lab
 * enforces", "CUSTOMIZE: the summary and its component panels", "The MEK
 * file, as the shell reads and writes it").
 *
 * Everything lives at its own address in the shell's memory, so the
 * loader's memsets, the save's fwrites of whole records and the
 * out-of-range reads a malformed MEK causes behave as in the original.
 *
 * Masses are hundredths of a ton. Item codes: a weapon is type * 100 + n
 * (n = 1, 2 ... numbering that type's instances); its ammo 10000 + weapon *
 * 100 + k (k = 1..10); equipment 5000..9999 (5001 + n MASC, 5301.. actuators,
 * 5850 XL engine, 6001 + n heat sinks, 7001 + n jump jets, 8001.. Endo
 * Steel, 9001.. Ferro-Fibrous).
 */
import { SHELL_LABEL as L } from '../../generated/shell/labels.gen.ts';
import { cdiv, cmod } from '../../core/int/cint.ts';
import { x87MulTrunc, x87TruncStore } from '../../core/int/x87.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { strnicmp } from '../project.ts';
import { projectStreamLoad } from '../career/brf2.ts';
import { projectStreamRelease } from '../career/orders.ts';

/** designCriticals[location][slot]: 8 x 12 ints. */
const CRIT_ROW = 12 * 4;
const LOC = {
  size: structSize('DesignLocation'),
  internal: fieldOffset('DesignLocation', 'internal'),
  maxArmour: fieldOffset('DesignLocation', 'maxArmour'),
  armourFront: fieldOffset('DesignLocation', 'armourFront'),
  armourRear: fieldOffset('DesignLocation', 'armourRear'),
};
const UNPLACED = {
  size: structSize('UnplacedItem'),
  item: fieldOffset('UnplacedItem', 'item'),
  criticals: fieldOffset('UnplacedItem', 'criticals'),
};
/** mechlabUnplaced's capacity (78, the queue's `< 0x4e` test) */
export const UNPLACED_MAX = 0x4e;
const ENGINE = { size: structSize('EngineRow'), rating: fieldOffset('EngineRow', 'rating'), mass: fieldOffset('EngineRow', 'mass'), maker: fieldOffset('EngineRow', 'maker') };
export const ITEM = {
  size: structSize('ItemType'),
  heat: fieldOffset('ItemType', 'heat'),
  damage: fieldOffset('ItemType', 'damage'),
  range: fieldOffset('ItemType', 'range'),
  mass: fieldOffset('ItemType', 'mass'),
  criticals: fieldOffset('ItemType', 'criticals'),
  ammoPerTon: fieldOffset('ItemType', 'ammoPerTon'),
  name: fieldOffset('ItemType', 'name'),
};
export const SECTION = {
  size: structSize('MechSection'),
  armorFront: fieldOffset('MechSection', 'armorFront'),
  armorRear: fieldOffset('MechSection', 'armorRear'),
  internal: fieldOffset('MechSection', 'internal'),
  slots: fieldOffset('MechSection', 'slots'),
  numSlots: fieldOffset('MechSection', 'numSlots'),
  /** +0x26, MW2's flags: SAVE writes 1 (not a named field in the shell's schema yet) */
  flags: 0x26,
};
/** structureTable rows: {centre torso, side torso, arm, leg}, one per 5 t from 10 t */
const STRUCTURE_ROW = 0x10;

/** 0xa47f8 / 0xa47fc: the engine handlers write 0 / 7 (XL) and max - engine mass; nothing reads them. */
const DAT_A47F8 = 0xa47f8;
const DAT_A47FC = 0xa47fc;

// ---------------------------------------------------------------- accessors

/** @portOnly a design global */
export function g(addr: number): number {
  return mem().i32(addr);
}
/** @portOnly sets a design global */
export function s(addr: number, v: number): void {
  mem().setI32(addr, v);
}
/** @portOnly designCriticals[loc][slot]'s address */
export function critAt(loc: number, slot: number): number {
  return L.designCriticals + loc * CRIT_ROW + slot * 4;
}
/** @portOnly designCriticals[loc][slot] */
export function crit(loc: number, slot: number): number {
  return g(critAt(loc, slot));
}
/** @portOnly designLocations[loc].field */
export function locField(loc: number, f: keyof typeof LOC): number {
  return g(L.designLocations + loc * LOC.size + LOC[f]);
}
/** @portOnly sets designLocations[loc].field */
export function setLocField(loc: number, f: keyof typeof LOC, v: number): void {
  s(L.designLocations + loc * LOC.size + LOC[f], v);
}
/** @portOnly mechlabUnplaced[i].item */
export function unplacedItem(i: number): number {
  return g(L.mechlabUnplaced + i * UNPLACED.size + UNPLACED.item);
}
/** @portOnly mechlabUnplaced[i].criticals */
export function unplacedCriticals(i: number): number {
  return g(L.mechlabUnplaced + i * UNPLACED.size + UNPLACED.criticals);
}
function setUnplaced(i: number, item: number, criticals?: number): void {
  s(L.mechlabUnplaced + i * UNPLACED.size + UNPLACED.item, item);
  if (criticals !== undefined) s(L.mechlabUnplaced + i * UNPLACED.size + UNPLACED.criticals, criticals);
}
/** @portOnly itemTypes[type].field */
export function itemField(type: number, f: Exclude<keyof typeof ITEM, 'size' | 'name'>): number {
  return g(L.itemTypes + type * ITEM.size + ITEM[f]);
}
/** @portOnly itemTypes[type].name */
export function itemName(type: number): string {
  return mem().ptrStr(L.itemTypes + type * ITEM.size + ITEM.name) ?? '';
}
/** @portOnly engineTable[i] */
export function engineRow(i: number): { rating: number; mass: number; maker: string } {
  const a = L.engineTable + i * ENGINE.size;
  return { rating: g(a + ENGINE.rating), mass: g(a + ENGINE.mass), maker: mem().ptrStr(a + ENGINE.maker) ?? '' };
}
/** @portOnly designWeapons[i] (10) */
export function weapon(i: number): number {
  return g(L.designWeapons + i * 4);
}
function setWeapon(i: number, v: number): void {
  s(L.designWeapons + i * 4, v);
}
/** @portOnly designAmmo[i] (25) */
export function ammo(i: number): number {
  return g(L.designAmmo + i * 4);
}
function setAmmo(i: number, v: number): void {
  s(L.designAmmo + i * 4, v);
}
/** A double constant in the image (the handlers' x87 operands). */
function imageDouble(a: number): number {
  const b = mem().view(a, 8);
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
}

// ------------------------------------------------------------------- x87

/**
 * `fild i; fmul qword d1; fmul qword d2; call clib_fp_trunc; fistp`: each
 * product rounded to a double (the FPU runs at 53-bit precision, see
 * core/int/x87.ts), then truncated.
 *
 * @portOnly x87 arithmetic the mech lab's gyro and armour masses use
 */
export function x87MulMulTrunc(i: number, d1: number, d2: number): number {
  return x87TruncStore((i | 0) * d1 * d2);
}

// ------------------------------------------------------------- shared steps

/**
 * The tail every handler inlines after changing the design: designGyroMass
 * = designEngineRating * [c1] * [c2] (0.01 and 100, from each function's
 * own copies) rounded up to a whole ton; designStructureMass = max / 10, or
 * / 20 with Endo Steel; designCockpitMass = 300; designMass the sum of the
 * ten terms, designFreeMass = max - mass; walk = rating * 100 / max, run =
 * (walk * 3 + 2) / 2.
 *
 * @portOnly the recompute each handler repeats inline (its operands' addresses are the caller's)
 */
export function recompute(c1: number, c2: number): void {
  let gyro = x87MulMulTrunc(g(L.designEngineRating), imageDouble(c1), imageDouble(c2));
  if (cmod(gyro, 100) !== 0) gyro = (gyro + 100 - cmod(gyro, 100)) | 0;
  s(L.designGyroMass, gyro);
  const max = g(L.designMaxMass);
  s(L.designStructureMass, cdiv(max, g(L.designEndoSteel) === 0 ? 10 : 20));
  s(L.designCockpitMass, 300);
  const mass =
    (g(L.designEngineMass) + gyro + 300 + g(L.designHeatSinkMass) + g(L.designJumpJetMass) + g(L.designStructureMass) + g(L.designArmourMass) + g(L.designWeaponMass) + g(L.designAmmoMass) + g(L.designMascMass)) | 0;
  s(L.designMass, mass);
  s(L.designFreeMass, (max - mass) | 0);
  walkRun();
}

/** designWalkMP = rating * 100 / max; designRunMP = (walk * 3 + 2) / 2. @portOnly inlined everywhere */
function walkRun(): void {
  const walk = cdiv(Math.imul(g(L.designEngineRating), 100), g(L.designMaxMass));
  s(L.designWalkMP, walk);
  s(L.designRunMP, cdiv(Math.imul(walk, 3) + 2, 2));
}

/**
 * Queues an item as unplaced when it is positive and the list has room
 * (mechlabUnplaced[mechlabUnplacedCount++] = {item, criticals}).
 *
 * @portOnly the append every handler inlines
 */
export function queueUnplaced(item: number, criticals: number): void {
  const n = g(L.mechlabUnplacedCount);
  if (item > 0 && n < UNPLACED_MAX) {
    setUnplaced(n, item, criticals);
    s(L.mechlabUnplacedCount, n + 1);
  }
}

/**
 * Takes an item out of every slot of the grid; how many slots it held (0
 * for an item that is not positive).
 *
 * @portOnly the count-and-clear loop the handlers inline
 */
function pullItem(item: number): number {
  let n = 0;
  if (item < 1) return 0;
  for (let l = 0; l < 8; l++)
    for (let k = 0; k < 12; k++)
      if (crit(l, k) === item) {
        n++;
        s(critAt(l, k), 0);
      }
  return n;
}

/** pullItem, then back into the unplaced list with the slots it held. @portOnly inlined in the XL, criticals and equipment handlers */
function pullAndQueue(item: number): void {
  if (item <= 0) return;
  const n = pullItem(item);
  if (n !== 0) queueUnplaced(item, n);
}

/** designJumpJetUnitMass by chassis weight: 0.5 t up to 55 t, 1 t up to 85 t, else 2 t. @portOnly inlined */
function jumpJetUnit(): void {
  const max = g(L.designMaxMass);
  s(L.designJumpJetUnitMass, max < 0x157d ? 0x32 : max < 0x2135 ? 100 : 200);
}

/** Removes jump jets (7000 + MP, top first) while jump MP > walking MP. @portOnly inlined */
function trimJumpJets(): void {
  while (g(L.designWalkMP) < g(L.designJumpMP)) {
    mechlabRemoveItemSlots(g(L.designJumpMP) + 7000);
    s(L.designJumpMP, g(L.designJumpMP) - 1);
  }
}

/**
 * designSlottedHeatSinks = (heat-sink tons + 10) - rating / 25 (at least 0),
 * then heat-sink items 6000 + n removed from the top down to it, or
 * 6001 + n queued (designHeatSinkType slots each) up to it; `old` is the
 * count before (nothing happens when it was negative).
 *
 * @portOnly the rebalance the engine and heat-sink handlers inline
 */
function rebalanceHeatSinks(old: number): void {
  let slotted = (cdiv(g(L.designHeatSinkMass), 100) + 10 - cdiv(g(L.designEngineRating), 0x19)) | 0;
  if (slotted < 0) slotted = 0;
  s(L.designSlottedHeatSinks, slotted);
  if (old < 0 || old === slotted) return;
  while (old > g(L.designSlottedHeatSinks)) {
    mechlabRemoveItemSlots(old + 6000);
    old--;
  }
  let code = old + 6001;
  while (old < g(L.designSlottedHeatSinks)) {
    old++;
    queueUnplaced(code, g(L.designHeatSinkType));
    code++;
  }
}

/** designWeaponMass = the fitted weapons' itemTypes masses. @portOnly inlined */
function weaponMass(): void {
  let m = 0;
  for (let i = 0; i < 10; i++) if (weapon(i) !== -1) m = (m + itemField(cdiv(weapon(i), 100), 'mass')) | 0;
  s(L.designWeaponMass, m);
}

/** designAmmoMass = 1 t per ammo entry, up to the first -1. @portOnly inlined */
function ammoMass(): void {
  let m = 0;
  for (let i = 0; i < 25 && ammo(i) !== -1; i++) m += 100;
  s(L.designAmmoMass, m);
}

/** How many ammo items feed the weapon instance `w` (ammo / 100 == w + 100). @portOnly inlined */
function ammoCount(w: number): number {
  const key = cdiv(Math.imul(w, 100) + 10000, 100);
  let n = 0;
  for (let i = 0; i < 25 && ammo(i) !== -1; i++) if (cdiv(ammo(i), 100) === key) n++;
  return n;
}

/**
 * The next ammo code for weapon `w` - 10000 + w * 100 + 1, stepped past
 * every existing one with the same /100 - stored in the first free
 * designAmmo entry when its k is at most 10; 0 when it was not stored.
 *
 * @portOnly the insertion add_item_and_recompute, add_ammo and the loader inline
 */
function ammoInsert(first: number): number {
  let a = first;
  a = a - cmod(a, 100) + 1;
  for (let j = 0; j < 25; j++) {
    if (ammo(j) === -1) {
      if (cmod(a, 100) < 0xb) {
        setAmmo(j, a);
        return a;
      }
      return 0;
    }
    if (cdiv(ammo(j), 100) === cdiv(a, 100)) a++;
  }
  return 0;
}

// ------------------------------------------------------------------ the grid

/**
 * (location, item, slots): writes the item into the first `slots` empty (0)
 * slots of designCriticals[location] - any of the 12; -1 (past the
 * location's size) is not empty. 1 when all fit; otherwise what it wrote is
 * cleared again and 0 returned.
 *
 * @mw2shell mechlab_place_item 0x0002ae40
 * @fidelity exact
 */
export function mechlabPlaceItem(loc: number, item: number, slots: number): number {
  if (item < 1) return 0;
  let k = 0;
  while (slots !== 0) {
    if (k > 0xb) break;
    if (crit(loc, k) === 0) {
      slots--;
      s(critAt(loc, k), item);
    }
    k++;
  }
  if (slots === 0) return 1;
  for (k = 0; k < 12; k++) if (crit(loc, k) === item) s(critAt(loc, k), 0);
  return 0;
}

/**
 * (item): clears the item from the grid and, for a weapon, the ammo that
 * feeds it; renumbers the later instances of its type (and their ammo);
 * the same in mechlabUnplaced (each removal lowering the count), which is
 * then packed, the tail set to -1. Nothing for an item that is not positive.
 *
 * @mw2shell mechlab_remove_item_slots 0x0002b0d0
 * @fidelity exact
 */
export function mechlabRemoveItemSlots(item: number): void {
  if (item <= 0) return;
  const type = cdiv(item, 100);
  const n = cmod(item, 100);
  /** the new code for c, or `gone` when it goes */
  const renumber = (c: number, gone: number): number => {
    if (c === item) return gone;
    if (c > 0 && (c < 5000 || c > 9999)) {
      if (cdiv(c, 100) === type && n < cmod(c, 100)) return c - 1;
      if (item < 5000 && c > 9999) {
        if (cdiv(c - 10000, 100) === item) return gone;
        if (cdiv(c - 10000, 10000) === type && n < cmod(cdiv(c, 100), 100)) return c - 100;
      }
    }
    return c;
  };
  for (let l = 0; l < 8; l++) for (let k = 0; k < 12; k++) s(critAt(l, k), renumber(crit(l, k), 0));
  let kept = 0;
  for (let i = 0; i < UNPLACED_MAX; i++) {
    let c = unplacedItem(i);
    const r = renumber(c, -1);
    if (r === -1 && c !== -1) s(L.mechlabUnplacedCount, g(L.mechlabUnplacedCount) - 1);
    c = r;
    setUnplaced(i, c);
    if (c !== -1) {
      setUnplaced(kept, c, unplacedCriticals(i));
      kept++;
    }
  }
  for (let i = kept; i < UNPLACED_MAX; i++) setUnplaced(i, -1);
}

/**
 * Turns designArmourMass into a budget - designArmourPoints = (mass * 16,
 * or * 16 * 1.2 with Ferro-Fibrous) / 100 rounded (+0x31) - sums the points
 * placed into designArmourAllocated (rear -1 skipped) and takes one point
 * at a time off the front, then the rear, of successive locations from
 * mechlabTrimLocation until they fit, leaving it where it stopped.
 *
 * @mw2shell mechlab_trim_armour_to_tonnage 0x0002bbd0
 * @fidelity exact
 */
export function mechlabTrimArmourToTonnage(): void {
  let loc = g(L.mechlabTrimLocation);
  let pts = Math.imul(g(L.designArmourMass), 16);
  // 0x76a68: 1.2
  if (g(L.designFerroFibrous) !== 0) pts = x87MulTrunc(pts, imageDouble(0x76a68));
  const budget = cdiv(pts + 0x31, 100);
  s(L.designArmourPoints, budget);
  let alloc = 0;
  for (let l = 0; l < 8; l++) {
    alloc += locField(l, 'armourFront');
    if (locField(l, 'armourRear') >= 0) alloc += locField(l, 'armourRear');
  }
  s(L.designArmourAllocated, alloc);
  while (g(L.designArmourAllocated) > g(L.designArmourPoints)) {
    if (locField(loc, 'armourFront') > 0) {
      setLocField(loc, 'armourFront', locField(loc, 'armourFront') - 1);
      s(L.designArmourAllocated, g(L.designArmourAllocated) - 1);
    }
    if (g(L.designArmourAllocated) <= g(L.designArmourPoints)) break;
    if (locField(loc, 'armourRear') > 0) {
      setLocField(loc, 'armourRear', locField(loc, 'armourRear') - 1);
      s(L.designArmourAllocated, g(L.designArmourAllocated) - 1);
    }
    loc++;
    if (loc > 7) loc = 0;
  }
  s(L.mechlabTrimLocation, loc);
}

// ------------------------------------------------------------- ENGINE panel

/** FASTER / SLOWER: the new engine at (walk + delta) * tons, taken only inside 10..400. */
function engineStep(delta: number, c1: number, c2: number): void {
  const old = g(L.designSlottedHeatSinks);
  let r = cdiv(Math.imul(Math.imul(g(L.designWalkMP) + delta, cdiv(g(L.designMaxMass), 100)), 5) + 4, 5);
  if (!(r > 9 && r < 0x191)) return;
  r = cdiv(r - 10, 5);
  if (g(L.designEngineIndex) > 9999) r += 10000;
  setEngine(r);
  rebalanceHeatSinks(old);
  walkRun();
  trimJumpJets();
  jumpJetUnit();
  s(L.designJumpJetMass, Math.imul(g(L.designJumpJetUnitMass), g(L.designJumpMP)));
  recompute(c1, c2);
}

/** designEngineRating / Mass from engineTable[index % 10000], halved for XL (index >= 10000); the two unread words. @portOnly inlined */
function setEngine(index: number): void {
  const e = engineRow(cmod(index, 10000));
  s(L.designEngineRating, e.rating);
  let mass = e.mass;
  if (index < 10000) s(DAT_A47F8, 0);
  else {
    mass = cdiv(mass, 2);
    s(DAT_A47F8, 7);
  }
  s(L.designEngineMass, mass);
  s(DAT_A47FC, (g(L.designMaxMass) - mass) | 0);
  s(L.designEngineIndex, index);
}

/**
 * FASTER: rating = (walking MP + 1) * tons, only inside 10..400 (the XL
 * flag kept); the heat sinks rebalanced, jump jets trimmed to the new
 * walking MP, the masses recomputed.
 *
 * @mw2shell mechlab_engine_faster 0x0002d130
 * @fidelity exact
 */
export function mechlabEngineFaster(): void {
  engineStep(1, 0x76c5c, 0x76c64);
}

/**
 * SLOWER: the same with walking MP - 1 (nothing at walk 0).
 *
 * @mw2shell mechlab_engine_slower 0x0002d490
 * @fidelity exact
 */
export function mechlabEngineSlower(): void {
  if (g(L.designWalkMP) === 0) return;
  engineStep(-1, 0x76c6c, 0x76c74);
}

/**
 * ENGINE Type: to XL, the items in the first two slots of each side torso
 * (left then right) go back to the unplaced list and those slots take 5850;
 * back to standard, the 5850s leave the side torsos. Then the engine row
 * and the masses.
 *
 * @mw2shell mechlab_toggle_xl_engine 0x0002d7f0
 * @fidelity exact
 */
export function mechlabToggleXlEngine(): void {
  const index = g(L.designEngineIndex);
  if (index < 10000) {
    s(L.designEngineIndex, index + 10000);
    for (const [l, k] of [
      [3, 0],
      [3, 1],
      [1, 0],
      [1, 1],
    ] as const)
      pullAndQueue(crit(l, k));
    for (const [l, k] of [
      [3, 0],
      [3, 1],
      [1, 0],
      [1, 1],
    ] as const)
      s(critAt(l, k), 0x16da);
  } else {
    s(L.designEngineIndex, index - 10000);
    for (let k = 0; k < 12; k++) {
      if (crit(1, k) === 0x16da) s(critAt(1, k), 0);
      if (crit(3, k) === 0x16da) s(critAt(3, k), 0);
    }
  }
  setEngine(g(L.designEngineIndex));
  recompute(0x76c7c, 0x76c84);
}

// -------------------------------------------------- HEAT SINKS and JUMP JETS

/**
 * JUMP JETS ADD: only while jump MP < walking MP - one more, its item
 * (7000 + the new MP) queued with 1 slot; then the masses.
 *
 * @mw2shell mechlab_add_jump_jet 0x0002dc90
 * @fidelity exact
 */
export function mechlabAddJumpJet(): void {
  if (g(L.designJumpMP) >= g(L.designWalkMP)) return;
  const jump = g(L.designJumpMP) + 1;
  s(L.designJumpMP, jump);
  queueUnplaced(jump + 7000, 1);
  jumpJetsChanged(0x76c8c, 0x76c94);
}

/** walk / run, the trim, the unit mass, designJumpJetMass and the recompute. */
function jumpJetsChanged(c1: number, c2: number): void {
  walkRun();
  trimJumpJets();
  jumpJetUnit();
  s(L.designJumpJetMass, Math.imul(g(L.designJumpJetUnitMass), g(L.designJumpMP)));
  recompute(c1, c2);
}

/**
 * JUMP JETS DELETE: the top jump jet's item leaves the grid, jump MP - 1
 * (not below 0); then the masses.
 *
 * @mw2shell mechlab_delete_jump_jet 0x0002deb0
 * @fidelity exact
 */
export function mechlabDeleteJumpJet(): void {
  if (g(L.designJumpMP) !== 0) {
    mechlabRemoveItemSlots(g(L.designJumpMP) + 7000);
    s(L.designJumpMP, g(L.designJumpMP) - 1);
  }
  jumpJetsChanged(0x76c9c, 0x76ca4);
}

/**
 * HEAT SINKS ADD: one more (no upper limit), the rebalance, the masses.
 *
 * @mw2shell mechlab_add_heat_sink 0x0002e0a0
 * @fidelity exact
 */
export function mechlabAddHeatSink(): void {
  const old = g(L.designSlottedHeatSinks);
  s(L.designHeatSinkMass, g(L.designHeatSinkMass) + 100);
  rebalanceHeatSinks(old);
  recompute(0x76cac, 0x76cb4);
}

/**
 * HEAT SINKS DELETE: one fewer unless at the free 10, the rebalance, the
 * masses.
 *
 * @mw2shell mechlab_delete_heat_sink 0x0002e270
 * @fidelity exact
 */
export function mechlabDeleteHeatSink(): void {
  const old = g(L.designSlottedHeatSinks);
  if (g(L.designHeatSinkMass) !== 0) s(L.designHeatSinkMass, g(L.designHeatSinkMass) - 100);
  rebalanceHeatSinks(old);
  recompute(0x76cbc, 0x76cc4);
}

/**
 * HEAT SINKS Type: single <-> double (type = 3 - type), the rebalance, then
 * every slotted heat sink out of the grid and queued again with the new
 * slot count.
 *
 * @mw2shell mechlab_toggle_heat_sink_type 0x0002e450
 * @fidelity exact
 */
export function mechlabToggleHeatSinkType(): void {
  const old = g(L.designSlottedHeatSinks);
  s(L.designHeatSinkType, 3 - g(L.designHeatSinkType));
  rebalanceHeatSinks(old);
  for (let i = 1; i <= g(L.designSlottedHeatSinks); i++) mechlabRemoveItemSlots(6000 + i);
  for (let i = 1; i <= g(L.designSlottedHeatSinks); i++) queueUnplaced(6000 + i, g(L.designHeatSinkType));
  recompute(0x76ccc, 0x76cd4);
}

// ------------------------------------------------ ARMOR and INTERNAL STRUCTURE

/**
 * ARMOR ADD: half a ton more, the trim (which recomputes the budget), the
 * masses.
 *
 * @mw2shell mechlab_add_armour 0x0002e6b0
 * @fidelity exact
 */
export function mechlabAddArmour(): void {
  s(L.designArmourMass, g(L.designArmourMass) + 0x32);
  mechlabTrimArmourToTonnage();
  recompute(0x76cdc, 0x76ce4);
}

/**
 * ARMOR DELETE: half a ton less unless none, the trim, the masses.
 *
 * @mw2shell mechlab_delete_armour 0x0002e7d0
 * @fidelity exact
 */
export function mechlabDeleteArmour(): void {
  if (g(L.designArmourMass) !== 0) s(L.designArmourMass, g(L.designArmourMass) - 0x32);
  mechlabTrimArmourToTonnage();
  recompute(0x76cec, 0x76cf4);
}

/** Seven one-slot items first..first+6: queued (on) or taken out of the grid (off). */
function sevenItems(on: boolean, first: number): void {
  for (let i = 0; i < 7; i++) {
    if (on) queueUnplaced(first + i, 1);
    else mechlabRemoveItemSlots(first + i);
  }
}

/**
 * ARMOR Type: Ferro-Fibrous on / off - seven one-slot items 9001..9007
 * queued or removed - then the trim and the masses.
 *
 * @mw2shell mechlab_toggle_ferro_fibrous 0x0002e900
 * @fidelity exact
 */
export function mechlabToggleFerroFibrous(): void {
  s(L.designFerroFibrous, 1 - g(L.designFerroFibrous));
  sevenItems(g(L.designFerroFibrous) !== 0, 0x2329);
  mechlabTrimArmourToTonnage();
  recompute(0x76cfc, 0x76d04);
}

/**
 * INTERNAL STRUCTURE Type: Endo Steel on / off with items 8001..8007, the
 * trim and the masses (the caller redraws the panels, which this does
 * too).
 *
 * @mw2shell mechlab_toggle_endo_steel 0x0002ebe0
 * @fidelity partial
 * @divergence the two widget_panel_redraw calls at its end are made by the registered click handler (shell/mechlab/panels.ts), which owns the widget engine
 */
export function mechlabToggleEndoSteel(): void {
  s(L.designEndoSteel, 1 - g(L.designEndoSteel));
  sevenItems(g(L.designEndoSteel) !== 0, 0x1f41);
  mechlabTrimArmourToTonnage();
  recompute(0x76d0c, 0x76d14);
}

// ------------------------------------------------------ WEAPONS AND AMMO

/**
 * ADD WEAPON (and a double click in the WEAPONS TABLE): the selected type
 * gets the next instance number and the first free designWeapons entry,
 * is queued with its criticals, and - for an ammo weapon - gets one ammo
 * item (1 slot); then the weapon and ammo masses and the rest. Nothing
 * with no selection or all 10 entries taken.
 *
 * @mw2shell mechlab_add_item_and_recompute 0x0002eee0
 * @fidelity exact
 */
export function mechlabAddItemAndRecompute(): void {
  const sel = g(L.mechlabSelectedItem);
  if (sel < 0) return;
  let code = sel - cmod(sel, 100) + 1;
  let placed = false;
  for (let i = 0; i < 10; i++) {
    if (weapon(i) === -1) {
      setWeapon(i, code);
      placed = true;
      break;
    }
    if (cdiv(weapon(i), 100) === cdiv(code, 100)) code++;
  }
  if (!placed) code = 0;
  if (code === 0) return;
  queueUnplaced(code, itemField(cdiv(code, 100), 'criticals'));
  if (ammoCount(code) >= 10) return;
  if (itemField(cdiv(code, 100), 'ammoPerTon') !== 0) queueUnplaced(ammoInsert(Math.imul(code, 100) + 10000), 1);
  weaponMass();
  ammoMass();
  recompute(0x76d1c, 0x76d24);
}

/**
 * DELETE WEAPON (and a double click on a fitted weapon): the selected
 * instance leaves designWeapons (packed; later instances of its type
 * renumbered), its ammo leaves designAmmo (the later instances' ammo
 * renumbered), and the grid (mechlab_remove_item_slots); the first
 * weapon becomes the selection; then the masses.
 *
 * @mw2shell mechlab_remove_item_and_recompute 0x0002f230
 * @fidelity exact
 */
export function mechlabRemoveItemAndRecompute(): void {
  const sel = g(L.mechlabSelectedItem);
  if (sel < 0 || cmod(sel, 100) === 0) return;
  const n = cmod(sel, 100);
  const type = cdiv(sel, 100);
  let j = 0;
  for (let i = 0; i < 10; i++) {
    if (weapon(i) === sel) setWeapon(i, -1);
    if (weapon(i) === -1) continue;
    if (weapon(j) === -1) {
      setWeapon(j, weapon(i));
      setWeapon(i, -1);
    }
    if (cdiv(weapon(j), 100) === type && n < cmod(weapon(j), 100)) setWeapon(j, weapon(j) - 1);
    j++;
  }
  const a = Math.imul(sel, 100) + 0x2711;
  const a100 = cdiv(a, 100);
  j = 0;
  for (let i = 0; i < 25; i++) {
    if (cdiv(ammo(i), 100) === a100) setAmmo(i, -1);
    const v = ammo(i);
    if (v === -1) continue;
    if (ammo(j) === -1) {
      setAmmo(j, v);
      setAmmo(i, -1);
    }
    if (cdiv(ammo(j), 10000) === cdiv(a, 10000) && cmod(a100, 100) < cmod(cdiv(ammo(j), 100), 100)) setAmmo(j, ammo(j) - 100);
    j++;
  }
  mechlabRemoveItemSlots(g(L.mechlabSelectedItem));
  s(L.mechlabSelectedItem, weapon(0));
  weaponMass();
  ammoMass();
  recompute(0x76d2c, 0x76d34);
}

/**
 * ADD AMMO: for a selected weapon instance of an ammo type with fewer than
 * 10 ammo items, one more (queued with 1 slot); then the masses.
 *
 * @mw2shell mechlab_add_ammo 0x0002f590
 * @fidelity exact
 */
export function mechlabAddAmmo(): void {
  const sel = g(L.mechlabSelectedItem);
  if (sel < 0 || cmod(sel, 100) === 0) return;
  if (ammoCount(sel) >= 10 || itemField(cdiv(sel, 100), 'ammoPerTon') === 0) return;
  queueUnplaced(ammoInsert(Math.imul(sel, 100) + 10000), 1);
  ammoMass();
  recompute(0x76d3c, 0x76d44);
}

/**
 * DELETE AMMO: the selected weapon's last ammo item leaves designAmmo
 * (packed, renumbered) and the grid; then the masses.
 *
 * @mw2shell mechlab_delete_ammo 0x0002f820
 * @fidelity exact
 */
export function mechlabDeleteAmmo(): void {
  const sel = g(L.mechlabSelectedItem);
  if (sel < 0 || cmod(sel, 100) === 0) return;
  const count = ammoCount(sel);
  if (count === 0) return;
  const target = count + Math.imul(sel, 100) + 10000;
  let j = 0;
  for (let i = 0; i < 25; i++) {
    if (ammo(i) === target) setAmmo(i, -1);
    if (ammo(i) === -1) continue;
    if (ammo(j) === -1) {
      setAmmo(j, ammo(i));
      setAmmo(i, -1);
    }
    if (cdiv(ammo(j), 100) === cdiv(target, 100) && cmod(target, 100) < cmod(ammo(j), 100)) setAmmo(j, ammo(j) - 1);
    j++;
  }
  mechlabRemoveItemSlots(Math.imul(g(L.mechlabSelectedItem), 100) + 10000 + count);
  ammoMass();
  recompute(0x76d4c, 0x76d54);
}

// --------------------------------------------------------------- CRITICALS

/**
 * The result of placing an unplaced entry: what message_box to show, or
 * null.
 *
 * @portOnly the non-blocking half of mechlab_click_unplaced (the handler shows the message)
 */
export function mechlabPlaceUnplaced(entry: number): string | null {
  const item = unplacedItem(entry);
  const loc = g(L.mechlabLocation);
  if (item < 0 || loc < 0) return null;
  if (item - cmod(item, 100) === 7000 && (loc === 0 || loc === 4 || loc === 5)) {
    // 0x76d5c
    return 'Jump Jets may only|be assigned to torso|or leg sections.#Ok';
  }
  let ok = 0;
  if (item >= 1) {
    ok = mechlabPlaceItem(loc, item, unplacedCriticals(entry));
    if (ok !== 0) {
      let j = 0;
      for (let i = 0; i < UNPLACED_MAX; i++) {
        if (unplacedItem(i) === item) {
          setUnplaced(i, -1);
          s(L.mechlabUnplacedCount, g(L.mechlabUnplacedCount) - 1);
        }
        if (unplacedItem(i) === -1) continue;
        if (unplacedItem(j) === -1) {
          setUnplaced(j, unplacedItem(i), unplacedCriticals(i));
          setUnplaced(i, -1);
        }
        j++;
      }
      ok = 1;
    }
  }
  // 0x76d98
  return ok !== 0 ? null : 'Insufficient criticals|for item placement.#Ok';
}

/**
 * The non-blocking half of mechlab_click_slot: a placed item (not 5300..5999)
 * goes back to the unplaced list from every slot it holds; the message for
 * a fixed one, or null.
 *
 * @portOnly the handler shows the message
 */
export function mechlabUnplaceSlot(slot: number): string | null {
  const loc = g(L.mechlabLocation);
  if (loc < 0) return null;
  const item = crit(loc, slot);
  if (item < 0) return null;
  // 0x76dc6
  if (item >= 0x14b4 && item <= 5999) return 'Selected critical|can not be removed.#Ok';
  pullAndQueue(item);
  return null;
}

/**
 * front +: while points are free, +1 up to maxArmour (front + rear), and
 * at the cap a point moves over from the rear; with none free, a point
 * still moves over from the rear.
 *
 * @mw2shell mechlab_armour_front_up 0x0002fd90
 * @fidelity exact
 */
export function mechlabArmourFrontUp(): void {
  const l = g(L.mechlabLocation);
  const front = locField(l, 'armourFront');
  const rear = locField(l, 'armourRear');
  const max = locField(l, 'maxArmour');
  if (g(L.designArmourAllocated) < g(L.designArmourPoints)) {
    if (rear < 0) {
      if (front < max) {
        setLocField(l, 'armourFront', front + 1);
        s(L.designArmourAllocated, g(L.designArmourAllocated) + 1);
      }
    } else if (front + rear < max) {
      setLocField(l, 'armourFront', front + 1);
      s(L.designArmourAllocated, g(L.designArmourAllocated) + 1);
    } else if (rear !== 0) {
      setLocField(l, 'armourFront', front + 1);
      setLocField(l, 'armourRear', rear - 1);
    }
  } else if (rear > 0) {
    setLocField(l, 'armourFront', front + 1);
    setLocField(l, 'armourRear', rear - 1);
  }
}

/**
 * front -: a point back to the pool.
 *
 * @mw2shell mechlab_armour_front_down 0x0002fe20
 * @fidelity exact
 */
export function mechlabArmourFrontDown(): void {
  const l = g(L.mechlabLocation);
  if (locField(l, 'armourFront') > 0) {
    setLocField(l, 'armourFront', locField(l, 'armourFront') - 1);
    s(L.designArmourAllocated, g(L.designArmourAllocated) - 1);
  }
}

/**
 * rear + (locations with rear armour): +1 while a point is free and under
 * the cap, else a point moves over from the front.
 *
 * @mw2shell mechlab_armour_rear_up 0x0002fe50
 * @fidelity exact
 */
export function mechlabArmourRearUp(): void {
  const l = g(L.mechlabLocation);
  const front = locField(l, 'armourFront');
  const rear = locField(l, 'armourRear');
  if (rear < 0) return;
  if (g(L.designArmourAllocated) < g(L.designArmourPoints)) {
    if (front + rear < locField(l, 'maxArmour')) {
      setLocField(l, 'armourRear', rear + 1);
      s(L.designArmourAllocated, g(L.designArmourAllocated) + 1);
    } else if (front !== 0) {
      setLocField(l, 'armourFront', front - 1);
      setLocField(l, 'armourRear', rear + 1);
    }
  } else if (front > 0) {
    setLocField(l, 'armourFront', front - 1);
    setLocField(l, 'armourRear', rear + 1);
  }
}

/**
 * rear -: a point back to the pool.
 *
 * @mw2shell mechlab_armour_rear_down 0x0002fed0
 * @fidelity exact
 */
export function mechlabArmourRearDown(): void {
  const l = g(L.mechlabLocation);
  if (locField(l, 'armourRear') > 0) {
    setLocField(l, 'armourRear', locField(l, 'armourRear') - 1);
    s(L.designArmourAllocated, g(L.designArmourAllocated) - 1);
  }
}

/**
 * An EQUIPMENT row: flips its flag (*value) and by the code in extra -
 * MASC (5000): designMascTons items 5001.. queued (on, masc mass = tons *
 * 100) or removed (off, mass 0), then the masses; a lower-arm or hand
 * actuator (5401 5451 in the right arm's slots 2 / 3, 5402 5452 the left
 * arm's): on, whatever held that slot goes back to the unplaced list and
 * the actuator takes it; off, it leaves the grid.
 *
 * @mw2shell mechlab_toggle_equipment 0x0002ff00
 * @fidelity exact
 */
export function mechlabToggleEquipment(flag: number, code: number): void {
  const was = g(flag);
  s(flag, was === 0 ? 1 : 0);
  const u = code >>> 0;
  if (was !== 0) {
    if (u === 0x1388) {
      for (let i = 1; i <= g(L.designMascTons); i++) mechlabRemoveItemSlots(0x1388 + i);
      s(L.designMascMass, 0);
      recompute(0x76def, 0x76df7);
    } else if (u === 0x1519 || u === 0x151a || u === 0x154b || u === 0x154c) mechlabRemoveItemSlots(code);
    return;
  }
  const slotFor: Record<number, [number, number]> = { 0x1519: [4, 2], 0x151a: [5, 2], 0x154b: [4, 3], 0x154c: [5, 3] };
  if (u === 0x1388) {
    for (let i = 1; i <= g(L.designMascTons); i++) queueUnplaced(0x1388 + i, 1);
    s(L.designMascMass, Math.imul(g(L.designMascTons), 100));
    recompute(0x76def, 0x76df7);
  } else if (slotFor[u]) {
    const [l, k] = slotFor[u]!;
    pullAndQueue(crit(l, k));
    s(critAt(l, k), code);
  }
}

// ---------------------------------------------------------------- the MEK

/** A MEK record's bytes: the PRJ resource, or mekFileBuffer for a loose file. */
interface MekSource {
  i32(off: number): number;
  u8(off: number): number;
}

/**
 * (name): loads a variant into the design. A name whose letters 5..7 are
 * 'std' is MW2.PRJ's MEK resource (TABL 6); any other is the loose file
 * 'mek\<name>' (+ '.mek' when the name has no '.'), read into mekFileBuffer
 * (0x800 bytes at most). Nothing happens when neither opens. The record
 * (README "The MEK file") goes into the mek* globals: the header, eight
 * sections, at most 10 weapons, at most 25 ammo bins from +0x158 +
 * numWeapons * 8 (the UNCLAMPED count), the 50-byte title from past all
 * of them. The design block (0xa45e0, 0x7a8 bytes) is saved to
 * designBackup and cleared, then derived: the weapon list, the ammo items
 * (one per bin, numbered per weapon), the critical grid (ammo bins mapped
 * to ammo items, -1 past a section's size), the title, max mass, heat-sink
 * mass, the engine (rating tons * walk in 10..400, XL when the right torso
 * holds 5850), Endo Steel (8001), Ferro-Fibrous (9001), the armour points
 * and mass (points / 16 or / 19.2, to the nearest half ton), the structure
 * from structureTable, MASC (5001), the arm actuators (the fixed ones
 * rewritten, whatever they displaced placed elsewhere in the arm or
 * queued; the optional ones counted into designEquip*), jump jets trimmed
 * to walking MP, and the masses. designHeatSinkType is 2 whenever any slot
 * holds 6001 - the second search that is meant to decide it repeats the
 * first over the MEK record, which still has the slot - and otherwise 2
 * only when the design is over weight with 10+ heat-sink tons divisible
 * by two, halving the heat-sink mass (less 5 t).
 *
 * @mw2shell mechlab_load_mek 0x00030db0
 * @fidelity exact
 * @divergence the loose file comes off the port's virtual disk (engine/dosFiles.ts) and the stock record from the port's MW2.PRJ reader
 */
export function mechlabLoadMek(nameAddr: number): void {
  const m = mem();
  const name = m.cstr(nameAddr, 13);
  const tail = m.cstr(nameAddr + 5, 8);
  // 0x76e10 'std'
  const stock = strnicmp(tail, 'std', 3) === 0;
  let src: MekSource | null = null;
  if (stock) {
    // 0x76e21 'MEK'
    const data = projectStreamLoad(name, 6, 'MEK');
    if (data) {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      src = {
        i32: (o) => (o + 4 <= data.length ? dv.getInt32(o, true) : (unestablished('mechlab_load_mek: a read past the MEK resource', 'mechlab_load_mek'), 0)),
        u8: (o) => (o < data.length ? data[o]! : 0),
      };
    }
  } else {
    // 0x76e14 'mek\', 0x76e19 '.mek' when the name has no '.'
    const path = 'mek\\' + name + (name.includes('.') ? '' : '.mek');
    const file = dosFileLoad(path);
    if (file) {
      const n = Math.min(file.length, 0x800);
      m.view(L.mekFileBuffer, n).set(file.subarray(0, n));
      src = { i32: (o) => m.i32(L.mekFileBuffer + o), u8: (o) => m.u8(L.mekFileBuffer + o) };
    }
  }
  if (!src) return;
  const BLOCK = L.mechlabChassisTitle;
  m.copy(L.designBackup, BLOCK, 0x7a8);
  m.fill(L.mekTons, 0, 0x18);
  m.fill(L.mekSections, 0, 0x140);
  m.fill(L.mekWeapons, 0, 0x50);
  m.fill(L.mekAmmoBins, 0, 200);
  m.fill(L.mekTitle, 0, 0x32);
  for (let i = 0; i < 6; i++) m.setI32(L.mekTons + i * 4, src.i32(i * 4));
  for (let i = 0; i < 0x50; i++) m.setI32(L.mekSections + i * 4, src.i32(0x18 + i * 4));
  const numWeapons = g(L.mekNumWeapons);
  const nW = numWeapons > 9 ? 10 : numWeapons;
  for (let i = 0; i < ((Math.imul(nW, 8) >>> 0) >>> 2); i++) m.setI32(L.mekWeapons + i * 4, src.i32(0x158 + i * 4));
  const numAmmo = g(L.mekNumAmmo);
  const nA = numAmmo > 0x18 ? 0x19 : numAmmo;
  const ammoAt = 0x158 + Math.imul(numWeapons, 8);
  for (let i = 0; i < ((Math.imul(nA, 8) >>> 0) >>> 2); i++) m.setI32(L.mekAmmoBins + i * 4, src.i32(ammoAt + i * 4));
  const titleAt = ammoAt + Math.imul(numAmmo, 8);
  for (let i = 0; i < 0x32; i++) m.setU8(L.mekTitle + i, src.u8(titleAt + i));
  // 0x76e25 'std', 0x76e29 'MEK'
  if (stock) projectStreamRelease(name, 6);

  m.fill(BLOCK, 0, 0x7a8);
  for (let i = 0; i < UNPLACED_MAX; i++) setUnplaced(i, -1);
  for (let i = 0; i < 10; i++) setWeapon(i, i < g(L.mekNumWeapons) ? g(L.mekWeapons + i * 8) : -1);
  for (let i = 0; i < 25; i++) setAmmo(i, -1);
  for (let i = 0; i < g(L.mekNumAmmo); i++) {
    ammoInsert(Math.imul(g(L.mekAmmoBins + i * 8 + 4), 100) + 0x2711);
    s(L.designAmmoMass, g(L.designAmmoMass) + 100);
  }
  const sec = (i: number) => L.mekSections + i * SECTION.size;
  for (let i = 0; i < 8; i++) {
    const numSlots = m.i16(sec(i) + SECTION.numSlots);
    for (let k = 0; k < 12; k++) {
      if (k >= numSlots) {
        s(critAt(i, k), -1);
        continue;
      }
      let v = m.u16(sec(i) + SECTION.slots + k * 2);
      if (v >= 10000) {
        for (let b = 0; b < 25; b++)
          if (v === m.u32(L.mekAmmoBins + b * 8)) {
            v = ammo(b);
            break;
          }
      }
      s(critAt(i, k), v);
    }
  }
  m.strcpy(L.designTitle, m.cstr(L.mekTitle));
  const tons = g(L.mekTons);
  s(L.designMaxMass, Math.imul(tons, 100));
  s(L.designHeatSinkMass, Math.imul(g(L.mekHeatSinks) - 10, 100));
  let rating = cdiv(Math.imul(Math.imul(tons, g(L.mekWalkMP)), 5) + 4, 5);
  if (rating < 10) rating = 10;
  if (rating > 400) rating = 400;
  s(L.designEngineRating, rating);
  let index = cdiv(rating - 10, 5);
  /** any of sections [from, to)'s first numSlots slots holds `code` */
  const anySlot = (code: number, from = 0, to = 8): { sec: number; slot: number } | null => {
    for (let i = from; i < to; i++) for (let k = 0; k < m.i16(sec(i) + SECTION.numSlots); k++) if (m.u16(sec(i) + SECTION.slots + k * 2) === code) return { sec: i, slot: k };
    return null;
  };
  if (anySlot(0x16da, 1, 2)) index += 10000;
  s(L.designEngineIndex, index);
  if (anySlot(0x1f41)) s(L.designEndoSteel, 1);
  const ferro = anySlot(0x2329) !== null;
  s(L.designJumpMP, g(L.mekJumpMP));
  s(L.designWalkMP, g(L.mekWalkMP));
  if (ferro) s(L.designFerroFibrous, 1);
  let points = 0;
  for (let i = 0; i < 8; i++) points = (points + m.i32(sec(i) + SECTION.armorFront) + m.i32(sec(i) + SECTION.armorRear)) | 0;
  s(L.designArmourPoints, points);
  // 0x76e3d 1/19.2 with Ferro-Fibrous, 0x76e2d 1/16; 0x76e35 100
  let am = x87MulMulTrunc(points, imageDouble(g(L.designFerroFibrous) === 1 ? 0x76e3d : 0x76e2d), imageDouble(0x76e35));
  const twice = Math.imul(am, 2) + 0x32;
  am = cdiv(twice - cmod(twice, 100), 2);
  s(L.designArmourMass, am);
  s(L.designArmourAllocated, points);
  const row = L.structureTable + cdiv(cdiv(g(L.designMaxMass), 100) - 10, 5) * STRUCTURE_ROW;
  const [ct, side, arm, leg] = [m.i32(row), m.i32(row + 4), m.i32(row + 8), m.i32(row + 12)];
  const internal = [3, side, ct, side, arm, arm, leg, leg];
  for (let i = 1; i < 8; i++) {
    setLocField(i, 'internal', internal[i]!);
    setLocField(i, 'maxArmour', internal[i]! * 2);
  }
  setLocField(0, 'maxArmour', 9);
  s(L.designMascTons, cdiv(cdiv(g(L.designMaxMass), 0x19) + 0x32, 100));
  const masc = anySlot(0x1389) !== null;
  for (let i = 0; i < 8; i++) {
    setLocField(i, 'armourFront', m.i32(sec(i) + SECTION.armorFront));
    setLocField(i, 'armourRear', i >= 1 && i <= 3 ? m.i32(sec(i) + SECTION.armorRear) : -1);
  }
  setLocField(0, 'internal', 3);
  s(L.mechlabLocation, 0);
  if (masc) s(L.designMascMass, Math.imul(g(L.designMascTons), 100));
  s(L.designEquipMasc, masc ? 1 : 0);
  /** zeroes every slot holding `code`, and how many there were */
  const clear = (code: number): number => {
    let n = 0;
    for (let i = 0; i < 8; i++)
      for (let k = 0; k < 12; k++)
        if (crit(i, k) === code) {
          n++;
          s(critAt(i, k), 0);
        }
    return n;
  };
  clear(0x14b5);
  clear(0x14e7);
  s(L.designEquipRightLowerArm, clear(0x1519));
  s(L.designEquipRightHand, clear(0x154b));
  clear(0x14b6);
  clear(0x14e8);
  s(L.designEquipLeftLowerArm, clear(0x151a));
  s(L.designEquipLeftHand, clear(0x154c));
  /** the actuator into its slot; what it displaced placed elsewhere in the arm, or queued */
  const fit = (l: number, k: number, code: number) => {
    const item = crit(l, k);
    const n = item !== 0 ? pullItem(item) : 0;
    s(critAt(l, k), code);
    if (mechlabPlaceItem(l, item, n) === 0 && item > 0) queueUnplaced(item, n);
  };
  fit(4, 0, 0x14b5);
  fit(4, 1, 0x14e7);
  if (g(L.designEquipRightLowerArm) !== 0) fit(4, 2, 0x1519);
  if (g(L.designEquipRightHand) !== 0) fit(4, 3, 0x154b);
  fit(5, 0, 0x14b6);
  fit(5, 1, 0x14e8);
  if (g(L.designEquipLeftLowerArm) !== 0) fit(5, 2, 0x151a);
  if (g(L.designEquipLeftHand) !== 0) fit(5, 3, 0x154c);
  setEngine(g(L.designEngineIndex));
  walkRun();
  trimJumpJets();
  jumpJetUnit();
  s(L.designJumpJetMass, Math.imul(g(L.designJumpJetUnitMass), g(L.designJumpMP)));
  weaponMass();
  // 0x76e45 0.01, 0x76e35 100
  recompute(0x76e45, 0x76e35);
  s(L.designHeatSinkType, 0);
  const hs = anySlot(0x1771);
  if (hs) {
    s(critAt(hs.sec, hs.slot), 0);
    quirk('mechlab_load_mek: the second search for a 6001 slot reads the MEK record again, not the grid it just cleared, so any slotted heat sink makes the type double', 'mechlab_load_mek');
    s(L.designHeatSinkType, (anySlot(0x1771) ? 1 : 0) + 1);
    s(critAt(hs.sec, hs.slot), 0x1771);
  }
  if (g(L.designHeatSinkType) === 0) {
    const hsMass = g(L.designHeatSinkMass);
    s(L.designHeatSinkType, g(L.designMaxMass) < g(L.designMass) && hsMass >= 1000 && cmod(cdiv(hsMass, 2), 100) === 0 ? 2 : 1);
  }
  if (g(L.designHeatSinkType) === 2) {
    s(L.designHeatSinkMass, cdiv(g(L.designHeatSinkMass), 2) - 500);
    recompute(0x76e45, 0x76e35);
  }
  let slotted = (cdiv(g(L.designHeatSinkMass), 100) + 10 - cdiv(g(L.designEngineRating), 0x19)) | 0;
  if (slotted < 0) slotted = 0;
  s(L.designSlottedHeatSinks, slotted);
}

/**
 * SAVE's record: the design written into the mek* globals and returned as
 * the bytes screen_mechlab fwrites - the header (0x18), the eight sections
 * (0x140), numWeapons x 8, numAmmo x 8 and the 50-byte title. Weapons get
 * location -1; each ammo item becomes a bin {type * 100 + 10001 stepped
 * past the bins before it, its weapon}; each section numSlots 12 (6 once
 * any slot is -1), flags 1, its slots with ammo items replaced by their
 * bins' codes; internal and armour as 16-bit values; tons = (max + 50) /
 * 100; heatSinks = (heat-sink tons + 10) x designHeatSinkType.
 *
 * @portOnly the SAVE branch of screen_mechlab (0x339e0), from its memsets to its fwrites
 */
export function mechlabPackMek(): Uint8Array {
  const m = mem();
  m.fill(L.mekTons, 0, 0x18);
  m.fill(L.mekSections, 0, 0x140);
  m.fill(L.mekWeapons, 0, 0x50);
  m.fill(L.mekAmmoBins, 0, 200);
  m.fill(L.mekTitle, 0, 0x32);
  let n = 0;
  for (let i = 0; i < 10 && weapon(i) !== -1; i++, n++) {
    s(L.mekWeapons + i * 8, weapon(i));
    s(L.mekWeapons + i * 8 + 4, -1);
  }
  s(L.mekNumWeapons, n);
  n = 0;
  for (let i = 0; i < 25 && ammo(i) !== -1; i++, n++) {
    let code = Math.imul(cdiv(ammo(i) - 10000, 10000), 100) + 0x2711;
    for (let j = 0; j < 25; j++) {
      const bin = g(L.mekAmmoBins + j * 8);
      if (bin === 0) break;
      if (code === bin) code = bin + 1;
    }
    s(L.mekAmmoBins + i * 8, code);
    s(L.mekAmmoBins + i * 8 + 4, cdiv(ammo(i) - 10000, 100));
  }
  s(L.mekNumAmmo, n);
  const sec = (i: number) => L.mekSections + i * SECTION.size;
  for (let i = 0; i < 8; i++) {
    m.setI16(sec(i) + SECTION.flags, 1);
    m.setI16(sec(i) + SECTION.numSlots, 0xc);
    for (let k = 0; k < 12; k++) {
      const c = crit(i, k);
      const at = sec(i) + SECTION.slots + k * 2;
      if (c === -1) {
        m.setI16(sec(i) + SECTION.numSlots, 6);
        m.setI16(at, 0);
      } else if (c < 10000) m.setI16(at, c);
      else
        for (let b = 0; b < 25; b++)
          if (ammo(b) === c) {
            m.setI16(at, m.i32(L.mekAmmoBins + b * 8));
            break;
          }
    }
  }
  const lo16 = (a: number) => m.i16(a);
  for (let i = 0; i < 8; i++) {
    s(sec(i) + SECTION.internal, lo16(L.designLocations + i * LOC.size + LOC.internal));
    s(sec(i) + SECTION.armorFront, lo16(L.designLocations + i * LOC.size + LOC.armourFront));
  }
  for (let i = 1; i <= 3; i++) s(sec(i) + SECTION.armorRear, lo16(L.designLocations + i * LOC.size + LOC.armourRear));
  s(L.mekTons, cdiv(g(L.designMaxMass) + 0x32, 100));
  s(L.mekWalkMP, g(L.designWalkMP));
  s(L.mekJumpMP, g(L.designJumpMP));
  s(L.mekHeatSinks, Math.imul(cdiv(g(L.designHeatSinkMass) + 0x32, 100) + 10, g(L.designHeatSinkType)));
  m.strcpy(L.mekTitle, m.cstr(L.designTitle));
  const parts = [m.view(L.mekTons, 0x18), m.view(L.mekSections, 0x140), m.view(L.mekWeapons, Math.imul(g(L.mekNumWeapons), 8)), m.view(L.mekAmmoBins, Math.imul(g(L.mekNumAmmo), 8)), m.view(L.mekTitle, 0x32)];
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * fopen('mek\<name>', 'wb') - creating the mek directory when that fails -
 * and the record's fwrites; 1 on success.
 *
 * @portOnly the file half of screen_mechlab's SAVE
 * @divergence the virtual disk has no directories, so the first open never fails and the mkdir('mek') retry is not reached
 */
export function mechlabWriteMek(fileName: string, bytes: Uint8Array): number {
  // 0x76dff 'mek\%s', 0x76e06 'wb'
  dosFileWrite('mek\\' + fileName, bytes);
  return 1;
}
