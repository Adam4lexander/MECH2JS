/**
 * Turning a MEK chassis record into a live loadout (mech_load_config, the
 * GPS chunk's last step) and loading a gamepiece's MGEO body constants
 * (res_load_mgeo, the MGDF chunk).
 *
 * The MEK record layout is data/formats/mek.ts's; this reads it the way the
 * loader does - at its offsets, from the loose MEK\<name>.MEK file when
 * there is one and otherwise from the MEK resource the GPS chunk names.
 */
import type { MechAmmoBin, MechLoadout } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { i16, u16 } from '../../core/int/cint.ts';
import { mulShr, sdivShl } from '../../core/int/i64.ts';
import { divergence, unestablished } from '../../core/provenance.ts';
import { systemError } from '../../core/systemError.ts';
import { log } from '../../core/log.ts';
import type { StreamRef } from '../../data/bwd/stream.ts';
import type { ExeImage } from '../../data/exe/ExeImage.ts';
import { readWeaponTypes, type WeaponType } from '../../data/exe/tables/weaponTypes.ts';
import { MEK_HEADER_SIZE, MEK_MAX_AMMO_BINS, MEK_MAX_WEAPONS, parseMek } from '../../data/formats/mek.ts';
import { MGEO_RECORD_SIZE, parseMgeo } from '../../data/formats/mgeo.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage, imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { mechAllegiance } from '../groups/groups.ts';
import { lighting } from '../world/environment.ts';
import { loadoutArrays } from './loadout.ts';
import { resLoadFile, screenshotSub04c4b0 } from './looseFiles.ts';
import { mechs } from './mechGlobals.ts';
import { resourceLoadRef } from './resourceRef.ts';

export const mechConfig = registerGlobals(
  'mechConfig',
  {
    /** 0x961d4: armour multiplier for enemy and neutral mechs, set per load from the difficulty */
    enemyArmorScale: 4,
    /** 0x961d8: armour multiplier for the player's mech (4 at every difficulty) */
    playerArmorScale: 4,
  },
  () => {
    mechConfig.enemyArmorScale = imageI32(LABEL.enemyArmorScale, 4);
    mechConfig.playerArmorScale = imageI32(LABEL.playerArmorScale, 4);
  },
);

/** 0x93828: "mek\" - the loose-file directory. */
const MEK_DIR = 'mek\\';
/** *0x9e9b8 (resExt_mek) */
const EXT_MEK = '.mek';
/** *0x9e99c (resExt_mgi) */
const EXT_MGI = '.mgi';
/** 0x4c6d0: equipmentRatingBuckets, 23 rows of {short threshold, value, count} (69 shorts, copied whole) */
const EQUIPMENT_RATING_BUCKETS = 0x4c6d0;
/** 0x9eb2c: weaponRatingValues, a short per weaponTypes index */
const WEAPON_RATING_VALUES = 0x9eb2c;

let configLog: ((line: string) => void) | null = null;
/**
 * Where mech_load_config's log_write lines go (each line as the C formats
 * it, leading newlines included); null, the default, drops them - as the
 * original does unless its log file is open.
 *
 * @portOnly stands in for log_write (0x49fa0) and its logEnabled / logStream
 */
export function setMechConfigLog(fn: ((line: string) => void) | null): void {
  configLog = fn;
}
const logWrite = (s: string): void => configLog?.(s);

let weaponCache: { exe: ExeImage; table: WeaponType[] } | null = null;
/** weaponTypes (0x9ee58, 31 rows), read from the boot image once. @portOnly */
export function weaponTypes(): WeaponType[] {
  const exe = bootImage();
  if (!exe) throw new Error('mech_load_config: no boot image (setBootImage)');
  if (weaponCache?.exe !== exe) weaponCache = { exe, table: readWeaponTypes(exe) };
  return weaponCache.table;
}
function weaponType(type: number): WeaponType {
  const w = weaponTypes()[type];
  if (!w) {
    unestablished(`weaponTypes[${type}]: past the 31-entry table`, 'mech_load_config');
    return { ...weaponTypes()[0]!, ammoPerTon: 0, shots: 0, damage: 0, heat: 0, heatOnHit: 0 };
  }
  return w;
}

const sec = (base: number, s: number): number => base + 0x18 + s * 0x28;

/**
 * The chassis rating MechEntity.loadoutRating holds: tons, then per section
 * the running (never reset) armour total, the equipment-bucket counts
 * weighted by value (times tons for a positive value), the running slot
 * count (doubled while the endo-steel row is non-empty) and the internal
 * structure; then weaponRatingValues per mount. The accumulators carry over
 * between sections, so earlier sections count again for every later one.
 *
 * Computed in 16 bits: the C accumulates in registers whose upper halves
 * start as the high bits of heap pointers (ebx enters holding the mounts
 * pointer; `mov bx, [chassis]` sets only its low word), but only adds and
 * multiplies follow and the caller keeps the low 16 bits, so the result
 * is exact.
 *
 * @mw2 mech_loadout_rating 0x0004cf20
 * @fidelity exact
 */
export function mechLoadoutRating(rec: Uint8Array, numWeapons: number): number {
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const img = bootImage();
  if (!img) throw new Error('mech_loadout_rating: no boot image');
  const at = (o: number, n: number): boolean => o >= 0 && o + n <= rec.length;
  const rd16 = (o: number): number => (at(o, 2) ? dv.getUint16(o, true) : 0);
  const rd32 = (o: number): number => (at(o, 4) ? dv.getInt32(o, true) : 0);
  const t = new Int16Array(69);
  for (let k = 0; k < 69; k++) t[k] = img.i16(EQUIPMENT_RATING_BUCKETS + k * 2);
  const tons = rd16(0);
  let acc = tons;
  let running = 0;
  let count = 0;
  for (let s = 0; s < 8; s++) {
    const b = sec(0, s);
    const n = i16(rd16(b + 0x24));
    for (let i = 0; i < n; i++) {
      running = (running + ((rd32(b) + rd32(b + 4)) | 0)) | 0;
      const slot = rd16(b + 0xc + i * 2); // index past 12 reads on through the record, as the C does
      for (let r = 0x16; r >= 0; r--) {
        if (slot > t[r * 3]!) {
          t[r * 3 + 2]!++;
          count++;
          break;
        }
      }
    }
    for (let r = 0x14; r >= 0; r--) {
      const c = t[r * 3 + 2]!;
      if (c !== 0) {
        const v = t[r * 3 + 1]!;
        if (v < 0) acc += Math.imul(-v, c);
        else acc += Math.imul(tons, Math.imul(c, v));
      }
    }
    acc += t[0x41] !== 0 ? count * 2 : count;
    acc += running + rd16(b + 8);
    acc &= 0xffff;
  }
  for (let w = 0; w < numWeapons && w < MEK_MAX_WEAPONS; w++) {
    const q = (rd32(MEK_HEADER_SIZE + w * 8) / 100) | 0;
    const a = WEAPON_RATING_VALUES + q * 2;
    if (q < 0 || q >= 0x20) unestablished(`weaponRatingValues[${q}]: outside the table`, 'mech_loadout_rating');
    acc += img.u16(a);
  }
  return acc & 0xffff;
}

/**
 * Builds a loadout from a chassis config: the MEK record (loose
 * mek\<config>.mek first, else the MEK resource mekId), eight sections with
 * their damage-level nibbles and the difficulty's armour scale (player 4;
 * enemy 1/3/4 and friendly 3/3/4 at difficulty 0/1/2) in 16.16, the
 * weapons with their ammo bins, top speed, heat dissipation by difficulty
 * and climate, and jump jets. Logs each part.
 *
 * @mw2 mech_load_config 0x0004c760
 * @fidelity exact
 * @divergence a record that cannot be loaded returns false after system_error 0x21 (the C carries on through an unset pointer); the resource's numWeapons is clamped in the parse, not written back into MW2.PRJ's bytes
 */
export function mechLoadConfig(loadout: MechLoadout, chassisName: string, mekId: number, configName: string): boolean {
  const cfg = mechConfig;
  const difficulty = mechs.simOptions.difficulty & 0xff;
  let friendlyArmorScale = 1;
  if (difficulty === 0) {
    cfg.enemyArmorScale = 1;
    friendlyArmorScale = 3;
    cfg.playerArmorScale = 4;
  } else if (difficulty === 1) {
    cfg.enemyArmorScale = 3;
    friendlyArmorScale = 3;
    cfg.playerArmorScale = 4;
  } else if (difficulty === 2) {
    cfg.enemyArmorScale = 4;
    friendlyArmorScale = 4;
    cfg.playerArmorScale = 4;
  } else {
    // the local is left uninitialised for any other difficulty
    unestablished(`difficulty ${difficulty}: the friendly armour scale is an uninitialised local`, 'mech_load_config');
  }

  let path = MEK_DIR + configName;
  if (!path.includes('.')) path += EXT_MEK;
  let rec = resLoadFile(screenshotSub04c4b0(path));
  let fromCache = false;
  if (!rec) {
    rec = mekId < 1 ? null : cacheLoadResource(mekId, 'MEK');
    if (!rec) {
      systemError(0x21, `${path} ID ${mekId}`);
      divergence('mech_load_config: no MEK record - returns failure where the C reads an unset pointer', 'mech_load_config');
      return false;
    }
    fromCache = true;
  }
  const mek = parseMek(rec);
  if (!mek) {
    unestablished(`MEK record of ${rec.length} bytes: shorter than its 0x158-byte header`, 'mech_load_config');
    return false;
  }
  const ch = mek.chassis;
  const numWeapons = mek.numWeaponsLoaded; // `if (10 < n) n = 10`, written into the record in C

  logWrite(`\n\n chassis: ${chassisName}  config: ${configName}  `);
  logWrite(`\n  tons wt: ${ch.tons} `);
  logWrite(`\n  move: ${ch.moveSpeed}  jump: ${ch.jump}  heat: ${ch.heatSinks}  `);

  const e = loadout.entity!;
  e.loadoutRating = u16(mechLoadoutRating(rec, numWeapons));

  const { weapons, sections, ammo } = loadoutArrays(loadout);
  // memcpy(loadout->sections, record + 0x18, 0x140)
  for (let s = 0; s < 8; s++) {
    const from = ch.sections[s]!;
    const to = sections[s]!;
    to.armorFront = from.armorFront;
    to.armorRear = from.armorRear;
    to.internal = from.internal;
    for (let k = 0; k < 12; k++) to.slots[k] = from.slots[k]!;
    to.numSlots = from.numSlots;
    to.flags = from.flags;
  }
  for (let s = 0; s < 8; s++) {
    const p = sections[s]!;
    logWrite(`\n\npiece ${s}- armor: ${p.armorFront}f ${p.armorRear}r int: ${p.internal} flags:${p.flags}\n`);
    for (let k = 0; k < 12; k++) {
      const code = p.slots[k]!;
      if (code >= 5000 && code < 0x13ba) loadout.flags = (loadout.flags | 0x10) & 0xffff;
      logWrite(String(code).padStart(3) + ' ');
    }
    let v = ((p.internal + p.armorFront) / 5) | 0;
    p.flags = i16(p.flags & 0xff00); // the low byte cleared
    v = v > 0xf ? 0xf : v < 1 ? 0 : v;
    p.flags = i16(p.flags | v);
    let r = ((p.internal + p.armorRear) / 5) | 0;
    r = r > 0xf ? 0xf : r < 1 ? 0 : r;
    p.flags = i16(p.flags | (r << 4));
    let scale: number;
    if (e.index === mechs.playerMechIndex) scale = cfg.playerArmorScale;
    else if (mechAllegiance(e.index) !== 0) scale = cfg.enemyArmorScale;
    else scale = friendlyArmorScale;
    p.armorFront = Math.imul(p.armorFront, scale);
    p.armorRear = Math.imul(p.armorRear, scale);
    p.armorFront = p.armorFront << 16;
    p.armorRear = p.armorRear << 16;
    p.internal = p.internal << 16;
  }

  let binNext = 0; // local_20: bins made so far, and the index of the next
  let wi = 0; // local_18
  if (numWeapons > 0) {
    do {
      const mount = mek.weapons[wi] ?? unreadMount(wi);
      const w = weapons[wi]!;
      const code = mount.slotCode | 0;
      w.type = (code / 100) | 0;
      w.slotState = 1;
      w.fireState = 1;
      w.stateTick = 0;
      // +0x14 = 0: pad_014, no port field
      w.fireGroup = 0;
      w.numBins = 0;
      w.binCursor = 0;
      w.slotCode = mount.slotCode >>> 0;
      w.bin = binAt(ammo, binNext);
      w.ammo = (weaponType(w.type).ammoPerTon !== -1 ? 1 : 0) - 1;
      let own = 0; // local_30
      for (let a = 0; a < ch.numAmmo && binNext < MEK_MAX_AMMO_BINS; a++) {
        const src = mek.ammo[a] ?? unreadBin(a);
        if (src.weaponCode >>> 0 === mount.slotCode >>> 0) {
          const b = ammo[binNext]!;
          b.field_0x0 = u16(((src.weaponCode | 0) / 100) | 0);
          const wt = weaponType(b.field_0x0);
          b.rounds = i16(Math.imul(wt.ammoPerTon, wt.shots));
          b.weaponIndex = i16(wi);
          b.slotCode = i16(src.binCode);
          b.damagePerRound = i16(wt.damage);
          b.field_0x10 = wt.heat;
          b.field_0xc = wt.heatOnHit;
          w.ammo = (w.ammo + b.rounds) | 0;
          if (own < 10) w.binIndices[own] = binNext;
          else unestablished(`weapon ${wi}: bin ${own} past binIndices[10] (writes over originalIndex..bin in C)`, 'mech_load_config');
          own++;
          binNext++;
          w.numBins++;
        }
      }
      if (mount.location > -1) w.sectionIndex = mount.location;
      else {
        for (let s = 0; s < 8; s++) {
          for (let k = 0; k < 12; k++) {
            if (ch.sections[s]!.slots[k]! === mount.slotCode >>> 0) w.sectionIndex = s === 6 ? 1 : s === 7 ? 3 : s;
          }
        }
      }
      logWrite(`\nweapon ${wi}- type ${w.type}  ammo: ${w.ammo}  `);
      wi++;
    } while (wi < numWeapons && wi < MEK_MAX_WEAPONS);
  }
  for (let a = 0; a < ch.numAmmo; a++) {
    const src = mek.ammo[a] ?? unreadBin(a);
    logWrite(`\nammo ${a} - class ${src.binCode | 0} wpn ${src.weaponCode | 0} `);
  }

  loadout.speed = (mulShr(ch.moveSpeed, 0x697e98, 16) + ((Math.imul(ch.moveSpeed, 0x697e98) >>> 15) & 1)) | 0;
  loadout.tons = ch.tons;
  loadout.numWeapons = numWeapons;
  loadout.numAmmo = ch.numAmmo;

  const t = lighting.ambientTemperature;
  const cold = t < -0x1e;
  const hot = 0x32 < t;
  let rate = 0x32;
  if (e.index === mechs.playerMechIndex) {
    if (difficulty === 0) rate = cold ? 0x8c : 0x46;
    else if (difficulty === 1) rate = cold ? 0x64 : hot ? 0x2d : 0x32;
    else if (difficulty === 2) rate = cold ? 0x43 : hot ? 0x24 : 0x2d;
  } else rate = cold ? 0x64 : hot ? 0x2d : 0x32;
  loadout.heatDissipation = Math.imul(rate, ch.heatSinks);

  if (ch.jump === 0) {
    loadout.jumpFuel = -2;
    loadout.jumpCapacity = 0;
    loadout.jetDeltaY = 0;
  } else if (ch.jump < 0) {
    loadout.jumpFuel = -1;
    loadout.jumpCapacity = 0;
    loadout.jetDeltaY = 0;
  } else {
    loadout.jumpFuel = 0x71c;
    loadout.jumpCapacity = ch.jump;
    const q = sdivShl(ch.jump, 16, ch.moveSpeed);
    loadout.jetDeltaY = (mulShr(q, 0x1e50, 16) + ((Math.imul(q, 0x1e50) >>> 15) & 1)) | 0;
  }
  logWrite(`\njet ddy: ${loadout.jetDeltaY}`);
  if (fromCache) cacheUnlock(mekId, 'MEK'); // else free(record)
  return true;
}

/** The C walks MechLoadout.ammo by pointer; one past the 0x19 bins is memory after the loadout. */
function binAt(ammo: MechAmmoBin[], i: number): MechAmmoBin | null {
  if (i < ammo.length) return ammo[i]!;
  unestablished(`MechWeapon.bin: ammo[${i}], past the loadout's 0x19 bins`, 'mech_load_config');
  return null;
}
function unreadMount(i: number): { slotCode: number; location: number } {
  unestablished(`weapon mount ${i}: past the end of the MEK record`, 'mech_load_config');
  return { slotCode: 0, location: 0 };
}
function unreadBin(i: number): { binCode: number; weaponCode: number } {
  unestablished(`ammo bin ${i}: past the end of the MEK record`, 'mech_load_config');
  return { binCode: 0, weaponCode: 0 };
}

/**
 * The MGDF chunk: loads the MGEO record a reference names (a loose
 * <name8>.mgi when the project has none) and copies its seven dwords into
 * the loadout - rideHeight, eyeOffsetY, mgeoWord2..4, torsoPanLimit and
 * radius (tons, between the last two, is skipped). Returns 1, or 0 having
 * logged "Couldn't load ID=%s Type=%s".
 *
 * @mw2 res_load_mgeo 0x0004bb80
 * @fidelity exact
 * @divergence the failure line goes to the log channel 'symlog' rather than symlog.txt
 */
export function resLoadMgeo(ref: StreamRef, loadout: MechLoadout): number {
  const r = resourceLoadRef(ref, 'MGEO', EXT_MGI, 5);
  if (!r) {
    log('symlog', `Couldn't load ID=${ref.name} Type=MGEO`);
    return 0;
  }
  const g = parseMgeo(r.data);
  if (!g) {
    unestablished(`MGEO record of ${r.data.length} bytes: the loader reads ${MGEO_RECORD_SIZE} regardless`, 'res_load_mgeo');
    return 0;
  }
  loadout.rideHeight = g.rideHeight;
  loadout.eyeOffsetY = g.eyeOffsetY;
  loadout.mgeoWord2 = g.mgeoWord2;
  loadout.mgeoWord3 = g.mgeoWord3;
  loadout.mgeoWord4 = g.mgeoWord4;
  loadout.torsoPanLimit = g.torsoPanLimit;
  loadout.radius = g.radius;
  if (ref.id !== -1) cacheUnlock(ref.id, 'MGEO'); // else free
  return 1;
}
