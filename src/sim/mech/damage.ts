/**
 * Damage and a mech's destruction: hit locations, armour and internal
 * structure, criticals and equipment slots, sections lost, collisions,
 * ejection and death. The originals sit in the decompilation's ai_group and
 * terrain modules, whose labels say nothing about them.
 *
 * Locations are 1-based throughout (1 head, 2 right torso, 3 centre torso,
 * 4 left torso, 5 right arm, 6 left arm, 7 right leg, 8 left leg - the names
 * debug_command_execute's messages give) and index sections[location - 1].
 * Damage is 16.16 armour points.
 */
import { fixedAtan2 } from '../../core/angle/trig.ts';
import { cdiv, i16 } from '../../core/int/cint.ts';
import { mulDiv64 } from '../../core/int/fx16.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import type { MechLoadout, MechSection, SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { logWrite } from '../../engine/logWrite.ts';
import { sceneNodeGetUserdata, sceneSubtreeFindLocation } from '../../engine/scene/sceneGraph.ts';
import { objectGetPosRadius, objectGetStateFlags, objectSetStateFlags } from '../../engine/scene/worldObject.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { effectSpawnAt } from '../effects/effects.ts';
import { simTables, statsWordAdd } from '../effects/simTables.ts';
import { groupElectLeader, groupGetLeader, groupRetargetSecondary, mechAllegiance } from '../groups/groups.ts';
import { net } from '../net/netplay.ts';
import { damageCalloutPlay, radioLanceMessage, soundCuePlay, soundPlay, soundPlayAt } from '../sound/sound.ts';
import { destructibleRegister, destructiblesRegisterSubtree } from '../things/destructibles.ts';
import { gamethingApplyDamage } from '../things/gameThingDamage.ts';
import { detailRecordReleaseNode, mechApplyDetailLevel } from '../world/detailRecords.ts';
import { lighting } from '../world/environment.ts';
import { collision } from '../world/collisionGlobals.ts';
import { mechAiReset } from './aiSetup.ts';
import { mechConfig } from './config.ts';
import { hudWidgetTable } from '../cockpit/hudWidgetTable.ts';
import { loadoutAmmo, loadoutSections, loadoutWeapons } from './loadout.ts';
import { mechs } from './mechGlobals.ts';
import { mechRuntime } from './mechRuntime.ts';

export const damageGlobals = registerGlobals(
  'damage',
  {
    /**
     * 0x96c28: a player hit on the head or centre torso that reached internal
     * structure, or an ammo explosion, asks for the damage flash; the cockpit
     * update (cockpit_status_sounds, Phase 4) consumes it
     */
    playerHitFlashPending: 0,
  },
  () => {
    damageGlobals.playerHitFlashPending = imageI32(LABEL.playerHitFlashPending, 0);
  },
);

// ---------------------------------------------------------------- mission tallies

/**
 * The kill and loss tallies are words at unaligned addresses inside the 80
 * bytes at 0xa5630 (simTables.dat000a5630), and missionEndCode is the byte
 * at 0xa564d among them. Which tally is which is recorded at each increment
 * by what the code tests, not by a reader (the debriefing is not ported).
 */
const STATS_BASE = 0xa5630;
const statInc = statsWordAdd;

/** 0xa564d: missionEndCode, a byte; 2 the player ejected, 4 the player died with ejection disabled */
export function missionEndCode(): number {
  return simTables.dat000a5630[0xa564d - STATS_BASE]!;
}

function setMissionEndCode(v: number): void {
  simTables.dat000a5630[0xa564d - STATS_BASE] = v & 0xff;
}

/** by allegiance 0, 1, 2 - anything else counts nothing */
function statByAllegiance(allegiance: number, a0: number, a1: number, a2: number): void {
  if (allegiance === 0) statInc(a0);
  else if (allegiance < 2) statInc(a1);
  else if (allegiance === 2) statInc(a2);
}

const viewerPos = () => cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
const isPlayer = (l: MechLoadout) => mechs.playerMechIndex === l.entity!.index;

/** the byte of MechSection.flags above bit 8, as the code tests it */
const flagsHi = (s: MechSection) => (s.flags >> 8) & 0xff;
const setFlagsHi = (s: MechSection, bits: number) => {
  s.flags = i16(s.flags | (bits << 8));
};

// ---------------------------------------------------------------- damage

/**
 * Applies damage (16.16 armour points) to one hit location. First the
 * mission tallies for a hit whose attacker killCreditMech records. Then,
 * offline or on the player's own mech, for damage > 0 and a location 1..8
 * (bit 0x8000 stripped): location 3 is re-rolled with random_range(2) - 0
 * moves it to 2, 1 keeps it on 3; the case sending it to 4 is unreachable.
 * Bit 0x8000 selects armorRear, for the torsos (2, 3, 4) only. The damage
 * comes off the armour (flags |= 0x8000); below 1 the section is breached
 * (0x4000, a sound the first time for the running player), the overflow
 * goes into internal and the armour is zeroed; internal below 1 destroys
 * the section. Otherwise up to four critical rolls: while random_range(5) >
 * k, random_range(100) below 20 in a section with slots is a critical -
 * exactly 12 destroys the section, else mech_damage_slot on a random slot.
 * Last, the section's damage level (15 - remaining / max, in the flags'
 * low nibbles' units) is raised on its geometry, and killCreditMech cleared.
 *
 * @mw2 mech_apply_damage 0x00026270
 * @fidelity exact
 */
export function mechApplyDamage(l: MechLoadout, points: number, location: number): void {
  const e = l.entity!;
  const m = mechs;
  let rear = 0;
  let level = 0;
  if (e.index === m.playerMechIndex && m.simOptions.invulnerability !== 0) return;
  const credit = simTables.killCreditMech;
  if (credit !== -1) {
    if (credit === m.playerMechIndex) statByAllegiance(mechAllegiance(e.index), 0xa5649, 0xa5645, 0xa5647);
    if (m.mechTable[credit]!.groupId === m.mechTable[m.playerMechIndex]!.groupId) {
      statByAllegiance(mechAllegiance(e.index), 0xa565c, 0xa5660, 0xa565e);
    }
    if (m.playerMechIndex === e.index) statInc(0xa564b);
    if (m.mechTable[m.playerMechIndex]!.groupId === e.groupId) statInc(0xa5662);
  }
  if (!(net.netRole === 0 || m.playerMechIndex === e.index) || points <= 0) return;
  const front = (location & 0x8000) === 0;
  let loc = front ? location : location & ~0x8000;
  if (loc <= 0 || loc >= 9) return;
  if (loc === 3) {
    const r = randomRange(2);
    if (r === 0) loc = 2;
    else if (r > 1) {
      // random_range(2) is table % 2 over rand() values: never above 1
      loc = r;
      if (r === 2) loc = 4;
    }
  }
  const s = loadoutSections(l)[loc - 1]!;
  let max: number;
  if (front || (loc !== 2 && loc !== 4 && loc !== 3)) {
    max = i16(s.flags & 0xf);
  } else {
    rear = 1;
    max = i16(s.flags & 0xf0) >> 4;
  }
  const armour = () => (rear ? s.armorRear : s.armorFront);
  const setArmour = (v: number) => {
    if (rear) s.armorRear = v | 0;
    else s.armorFront = v | 0;
  };
  setArmour(armour() - points);
  setFlagsHi(s, 0x80);
  if (armour() < 1) {
    if ((flagsHi(s) & 0x40) === 0 && m.playerMechIndex === e.index && l.status === 2) soundPlay(0xec, 100, 0x40, 5, 0x50);
    setFlagsHi(s, 0x40);
    s.internal = (s.internal + armour()) | 0;
    setArmour(0);
    if (m.playerMechIndex === e.index && (loc === 1 || loc === 3) && l.status !== 4 && 0x20000 < points) {
      damageGlobals.playerHitFlashPending = 1;
    }
    if (s.internal < 1) {
      // killCreditMech is left set on this path (mech_on_destroyed clears it on a kill)
      mechDestroySection(l, loc);
      return;
    }
    for (let k = 0; k < randomRange(5); k++) {
      const roll = randomRange(100);
      if (roll < 0x14 && s.numSlots > 0) {
        if (roll === 0xc) {
          mechDestroySection(l, loc);
          return;
        }
        mechDamageSlot(l, loc, randomRange(s.numSlots), 0);
      }
    }
  }
  if (max !== 0) {
    const scale = e.index === m.playerMechIndex ? mechConfig.playerArmorScale : mechConfig.enemyArmorScale;
    level = 0xf - cdiv(Math.imul(cdiv(armour(), scale) + s.internal, 3), max << 16);
  }
  sceneSubtreeRaiseDamageLevel(e.node!, level, loc);
  simTables.killCreditMech = -1;
}

/**
 * Raises the damage level (the WorldObject state nibble at bits 4..7) of
 * every object of `location` in a subtree, stopping at any node whose own
 * level is already `level` or more. Levels outside 1..15 do nothing.
 *
 * @mw2 scene_subtree_raise_damage_level 0x0001e7e0
 * @fidelity exact
 */
export function sceneSubtreeRaiseDamageLevel(node: SceneNode, level: number, location: number): void {
  let state: number;
  if (node.userData) state = objectGetStateFlags(node.userData);
  else {
    // the C reads node->userData->flags with no null test
    unestablished('scene_subtree_raise_damage_level: a node without an object reads flags through a null pointer; taken as 0', 'scene_subtree_raise_damage_level');
    state = 0;
  }
  if (level > 0 && level < 0x10 && ((state & 0xf0) >> 4) < level) {
    const o = node.userData;
    if (o && o.hitLocation === location) objectSetStateFlags(o, level << 4);
    for (let c = node.firstChild; c; c = c.nextSibling) sceneSubtreeRaiseDamageLevel(c, (level << 4) >> 4, location);
  }
}

/**
 * Destroys one equipment slot of sections[location - 1] and removes it from
 * the slot list. The item code's code / 100 picks the path: under 50 a
 * weapon (it stops firing for good), over 100 an ammo bin (its rounds leave
 * the weapon and, unless quiet, cook off: effect 7, rounds * damagePerRound
 * of structure, and status 5 with mech_on_destroyed for an AI mech or with
 * auto-eject), and the range between is equipment, whose codes rounded to
 * tens cost speed, jump jets, cooling or the mech itself. `quiet` silences
 * the player's callouts; with it clear an Endo Steel / Ferro-Fibrous slot
 * (8000, 9000) passes the hit to a random slot and survives.
 *
 * @mw2 mech_damage_slot 0x00025960
 * @fidelity exact
 */
export function mechDamageSlot(l: MechLoadout, location: number, slotIndex: number, quiet: number): void {
  if (!l.sections) return;
  const s = loadoutSections(l)[location - 1]!;
  const numSlots = s.numSlots;
  if (numSlots <= slotIndex || slotIndex < 0) return;
  const code = s.slots[slotIndex]!;
  const hundreds = (code / 100) | 0;
  const player = isPlayer(l);
  const running = () => l.status === 2;
  const hitSound = () => {
    if (running()) soundPlay(0xd0, 100, 0x40, 5, 0x50);
  };
  if (hundreds < 0x32) {
    const weapons = loadoutWeapons(l);
    for (let i = 0; i < 10; i++) {
      const w = weapons[i]!;
      if (w.type > -1 && code === w.slotCode) {
        if (quiet === 0 && player && w.slotState !== 0) {
          const callout = weaponCallout(hundreds);
          if (callout >= 0) damageCalloutPlay(callout);
          hitSound();
          damageCalloutPlay(0);
        }
        w.slotState = 0;
        w.fireState = -1;
        break;
      }
    }
  } else if (hundreds > 100) {
    const weapons = loadoutWeapons(l);
    const bins = loadoutAmmo(l);
    for (let b = 0; b < l.numAmmo; b++) {
      const bin = bins[b]!;
      if (bin.slotCode === code) {
        const w = weapons[bin.weaponIndex]!;
        w.ammo = (w.ammo - bin.rounds) | 0;
        if (w.ammo === 0) {
          w.fireState = -1;
          w.slotState = 0;
        }
        if (quiet === 0 && bin.rounds !== 0) {
          const e = l.entity!;
          if (player) {
            hitSound();
            const v = viewerPos();
            damageGlobals.playerHitFlashPending = 1;
            soundPlayAt(e.posX - v.posX, e.posY - v.posY, e.posZ - v.posZ, 0xbc, cameraGlobals.cockpitViewActive);
            damageCalloutPlay(1);
          }
          let at = sceneSubtreeFindLocation(e.node!, location);
          if (!at) at = sceneSubtreeFindLocation(e.node!, 3);
          if (at) {
            const p = objectGetPosRadius(sceneNodeGetUserdata(at)!);
            effectSpawnAt(7, p.x, p.y, p.z, p.x, p.y, p.z);
          }
          s.internal = (s.internal + Math.imul(Math.imul(bin.rounds, bin.damagePerRound), -0x10000)) | 0;
          if (s.internal < 0) {
            s.internal = 0;
            s.slots[slotIndex] = 0;
            mechDestroySection(l, location);
          }
          if (mechRuntime.autoEjectEnabled !== 0 || !player) {
            l.status = 5;
            mechOnDestroyed(l);
          }
        }
        bin.rounds = 0;
      }
    }
  } else {
    if (hundreds === 100) {
      quirk('mech_damage_slot: an LRM20 ammo bin (code / 100 == 100) takes the equipment path and is only removed', 'mech_damage_slot');
    }
    if (equipmentSlot(l, location, (((code / 10) | 0) * 10) | 0, quiet, numSlots, player, hitSound) === 'returned') return;
    if (l.throttleScale !== 0 && l.throttleScale < 0x6666) l.throttleScale = 0x6666;
  }
  // the slot leaves the list; numSlots is re-read, so a section destroyed
  // above (numSlots already 0) ends at -1
  let i = slotIndex;
  for (; i < s.numSlots - 1; i++) s.slots[i] = s.slots[i + 1]!;
  s.slots[i] = 0;
  s.numSlots = i16(s.numSlots - 1);
}

/** damageCallouts index for a weapon, by weaponTypes index (code / 100); -1 for none (20 FLAMER and above 27) */
function weaponCallout(type: number): number {
  if (type <= 3) return 0x16;
  if (type <= 6) return 0x17;
  if (type <= 9) return 0x18;
  if (type === 10) return 0x19;
  if (type === 11) return 0x1a;
  if (type <= 15) return 0x1b;
  if (type <= 19) return 0x1c;
  if (type >= 0x15 && type <= 0x1b) return 0x1d + (type - 0x15);
  return -1;
}

function equipmentSlot(
  l: MechLoadout,
  location: number,
  item: number,
  quiet: number,
  numSlots: number,
  player: boolean,
  hitSound: () => void,
): 'returned' | undefined {
  const callout = (id: number) => {
    if (quiet === 0 && player) {
      hitSound();
      damageCalloutPlay(id);
    }
  };
  const speedLoss = () => {
    l.throttleScale = (l.throttleScale - 0x199a) | 0;
    if (l.throttleScale < 0) l.throttleScale = 0;
  };
  switch (item) {
    case 5300: // shoulder, announced as sensors
      callout(9);
      soundResSub032f70(l, 0);
      break;
    case 5350: // upper arm, lower arm, hand actuator
    case 5400:
    case 5450:
      callout(0xc);
      soundResSub032f70(l, 0);
      break;
    case 5500: // hip
      callout(0xb);
      speedLoss();
      break;
    case 5550: // upper leg, lower leg, foot actuator
    case 5600:
    case 5650:
      callout(10);
      speedLoss();
      break;
    case 5700: // sensors
      callout(9);
      soundResSub032f70(l, 1);
      break;
    case 5750: // cockpit: no callout
      mechOnDestroyed(l);
      break;
    case 5800: // gyro
      callout(8);
      speedLoss();
      l.jumpFuel = -2;
      l.jetDeltaY = 0;
      l.jumpCapacity = 0;
      break;
    case 5850: // engine
      callout(7);
      speedLoss();
      break;
    case 5900: // life support
      callout(6);
      if (lighting.ejectDisabled !== 0) mechOnDestroyed(l);
      break;
    case 6000: // heat sinks 1..9 only (6010.. round to 6010 and match nothing)
      if (quiet === 0 && player && l.heatDissipation !== 0) {
        hitSound();
        damageCalloutPlay(5);
      }
      if (l.heatDissipation < 1) l.heatDissipation = 0;
      else l.heatDissipation = (l.heatDissipation - 0x32) | 0;
      break;
    case 7000: // jump jet
      if (quiet === 0 && player && l.jumpFuel !== 2) {
        hitSound();
        damageCalloutPlay(4);
      }
      if (l.jumpCapacity < 1) l.jetDeltaY = 0;
      else l.jetDeltaY = (l.jetDeltaY - cdiv(l.jetDeltaY, l.jumpCapacity)) | 0;
      if (l.jumpCapacity > 0) l.jumpCapacity = (l.jumpCapacity - 1) | 0;
      if (l.jumpCapacity === 0) l.jumpFuel = -2;
      break;
    case 8000: // Endo Steel
    case 9000: // Ferro-Fibrous
      if (quiet === 0) {
        mechDamageSlot(l, location, randomRange(numSlots), 1);
        return 'returned';
      }
      break;
  }
  return undefined;
}

/**
 * For the player only: for each of the 24 HUD widgets, a random_range(10)
 * roll below 2 (below 5 when `sensors` is set) calls the widget's method 9
 * with its +6 value + 1 - the display damage a destroyed arm or sensor
 * slot does. Called from mech_damage_slot for the 5300..5450 codes (0) and
 * 5700 (1).
 *
 * @mw2 sound_res_sub_032f70 0x00032f70
 * @fidelity exact
 */
export function soundResSub032f70(l: MechLoadout, sensors: number): void {
  if (mechs.playerMechIndex !== l.entity!.index) return;
  const odds = sensors === 0 ? 2 : 5;
  for (let i = 0; i < 0x18; i++) {
    if (randomRange(10) < odds) {
      const w = hudWidgetTable[i]!;
      w.methods[9]!(w, (w.field_0x6 + 1) | 0);
    }
  }
}

/**
 * Destroys section `location` once (flags 0x2000 latches it): internal to
 * 0, all its slots destroyed quietly, then the skeleton's cascade - a side
 * torso takes its arm and clears its own 0x2000 again; an arm detaches; the
 * first leg detaches and stops the mech (throttleScale 0, flags 0x20); the
 * second leg takes head and centre torso; the centre torso takes both arms,
 * both side torsos and the head. Head, centre torso and the second leg end
 * in the death path: detach, then mech_on_destroyed unless already dead or
 * ejecting.
 *
 * @mw2 mech_destroy_section 0x00025740
 * @fidelity exact
 */
export function mechDestroySection(l: MechLoadout, location: number): void {
  if (location === 0) return;
  const sections = loadoutSections(l);
  const s = sections[location - 1]!;
  if ((flagsHi(s) & 0x20) !== 0) return;
  s.internal = 0;
  setFlagsHi(s, 0x20);
  const n = s.numSlots;
  for (let i = 0; i < n; i++) mechDamageSlot(l, location, 0, 1);
  const clearOwn = () => {
    s.flags = i16(s.flags & ~0x2000);
    quirk('mech_destroy_section: a side torso clears its own destroyed bit (0x2000) again', 'mech_destroy_section');
  };
  switch (location) {
    case 2:
      mechDestroySection(l, 5);
      clearOwn();
      return;
    case 3:
      mechDestroySection(l, 5);
      mechDestroySection(l, 2);
      mechDestroySection(l, 4);
      mechDestroySection(l, 6);
      mechDestroySection(l, 1);
      break;
    case 4:
      mechDestroySection(l, 6);
      clearOwn();
      return;
    case 5:
    case 6:
      mechDetachSectionGeometry(l.entity!.node, location);
      return;
    case 7:
    case 8:
      if ((l.flags & 0x20) === 0) {
        mechDetachSectionGeometry(l.entity!.node, location);
        l.throttleScale = 0;
        l.flags = (l.flags | 0x20) & 0xffff;
        return;
      }
      mechDestroySection(l, 1);
      mechDestroySection(l, 3);
      break;
  }
  mechDetachSectionGeometry(l.entity!.node, location);
  if (l.status !== 4 && l.status !== 5) mechOnDestroyed(l);
}

/**
 * Finds the first node of `location` in a subtree - searching each node's
 * later siblings before its children - and turns it and everything below
 * it into destructible debris.
 *
 * @mw2 mech_detach_section_geometry 0x0001e850
 * @fidelity exact
 */
export function mechDetachSectionGeometry(node: SceneNode | null, location: number): void {
  for (;;) {
    if (!node) return;
    mechDetachSectionGeometry(node.nextSibling, location);
    if (node.userData && node.userData.hitLocation === location) break;
    node = node.firstChild;
  }
  destructiblesRegisterSubtree(node.firstChild, detailRecordReleaseNode, location);
  destructibleRegister(node, detailRecordReleaseNode, location);
}

// ---------------------------------------------------------------- collisions

/** octagonal length of a vector, (4 * max + mid + min) >> 2 */
function octLength(x: number, y: number, z: number): number {
  let a = Math.abs(x) | 0;
  let b = Math.abs(y) | 0;
  let c = Math.abs(z) | 0;
  let hi = a;
  if (a < b) {
    hi = b;
    b = a;
  }
  a = hi;
  if (hi < c) {
    a = c;
    c = hi;
  }
  return (Math.imul(a, 4) + b + c) >> 2;
}

/** 3 armour points per 1300000 of speed above 200000 */
const impactDamage = (speed: number) => Math.imul(mulDiv64(speed - 200000, 0x10000, 1300000), 3);

/**
 * Mech-on-mech impact: the closing speed (octagonal length of the two
 * stepVelocity vectors' difference) above 200000 damages this mech through
 * collision_damage_apply. Only with simOptions.collisionDamage.
 *
 * @mw2 mech_collision_damage 0x00020890
 * @fidelity exact
 */
export function mechCollisionDamage(l: MechLoadout, other: MechLoadout | null): void {
  if (mechs.simOptions.collisionDamage === 0) return;
  // the original dereferences other with no test; mech_std_tick_terrain passes the struck mech's loadout
  const o = other!;
  const speed = octLength(l.stepVelocityX - o.stepVelocityX, l.stepVelocityY - o.stepVelocityY, l.stepVelocityZ - o.stepVelocityZ);
  if (200000 < speed) collisionDamageApply(l, o, impactDamage(speed));
}

/**
 * Places collision damage by the contact normal (rayHitNormal): from above
 * the head, scaled up by the other mech's tonnage; from below half to each
 * leg; from the side an arm or side torso by bearing relative to heading
 * and torso twist.
 *
 * @mw2 collision_damage_apply 0x00020930
 * @fidelity exact
 */
export function collisionDamageApply(l: MechLoadout, other: MechLoadout | null, damage: number): void {
  const c = collision;
  let location: number;
  if (c.rayHitNormalY < -0xddb4) {
    let d = damage;
    if (other) {
      const scaled = mulDiv64(Math.imul(damage, 4), other.tons, l.tons);
      if (!(scaled < damage)) d = scaled;
    }
    damage = d;
    location = 1;
  } else if (c.rayHitNormalY < 0xb506) {
    const e = l.entity!;
    let b = (fixedAtan2(-c.rayHitNormalX | 0, -c.rayHitNormalZ | 0) - e.heading - e.aimAngle) | 0;
    if (b < -0xb40000) b = (b + 0x1680000) | 0;
    else if (0xb40000 < b) b = (b - 0x1680000) | 0;
    if (b > 0) {
      mechApplyDamage(l, damage, 0x2cffff < b && b < 0x870001 ? 5 : 2);
      return;
    }
    if (-0x2d0000 < b || b < -0x870000) {
      mechApplyDamage(l, damage, 4);
      return;
    }
    location = 6;
  } else {
    damage >>= 1;
    mechApplyDamage(l, damage, 7);
    location = 8;
  }
  mechApplyDamage(l, damage, location);
}

/**
 * Mech-on-obstacle impact: the mech's own step speed above 200000 damages
 * it as mech_collision_damage does (no tonnage scaling), and a gamething it
 * hit (type bit 0x200) takes the damage >> 16 in whole points at its
 * position. Only with simOptions.collisionDamage.
 *
 * @mw2 obstacle_collision_damage 0x00020a50
 * @fidelity exact
 */
export function obstacleCollisionDamage(l: MechLoadout, hit: WorldObject | null): void {
  if (mechs.simOptions.collisionDamage === 0) return;
  const speed = octLength(l.stepVelocityX, l.stepVelocityY, l.stepVelocityZ);
  if (200000 < speed) {
    const d = impactDamage(speed);
    collisionDamageApply(l, null, d);
    if (!hit) {
      quirk('obstacle_collision_damage: no object was recorded for the hit; the original reads its type through a null pointer (taken as no gamething)', 'obstacle_collision_damage');
      return;
    }
    if ((hit.type & 0x200) !== 0) gamethingApplyDamage(hit, d >> 16, hit.posX, hit.posY, hit.posZ);
  }
}

// ---------------------------------------------------------------- death and ejection

/**
 * Everything that happens when a mech goes down: the ejection outcome for
 * the player (missionEndCode 2, or 4 and dead with ejection disabled), the
 * kill credit and the kill / loss tallies, the enemy-destroyed cue, entity
 * flags |= 6 and status 4, the AI reset, a new group leader, the lance
 * radio call, and the wreck (detail level 1). Nothing for an invulnerable
 * player or a mech already destroyed or gone.
 *
 * @mw2 mech_on_destroyed 0x00025340
 * @fidelity exact
 */
export function mechOnDestroyed(l: MechLoadout): void {
  const m = mechs;
  let e = l.entity!;
  if (m.playerMechIndex === e.index && m.simOptions.invulnerability !== 0) return;
  if ((e.flags & 2) !== 0 || (e.flags & 4) !== 0) return;
  if (l.status === 5) {
    if (lighting.ejectDisabled === 0) {
      if (m.playerMechIndex === e.index) {
        setMissionEndCode(2);
        soundCuePlay(0xc, -1);
      }
    } else {
      if (m.playerMechIndex === e.index) {
        setMissionEndCode(4);
        soundCuePlay(0x20, -1);
      }
      l.status = 4;
    }
  }
  const credit = simTables.killCreditMech;
  if (credit !== -1) {
    e = l.entity!;
    if (credit === m.playerMechIndex && ((e.flags >> 8) & 0x14) !== 0) {
      if (e.gamepieceClass === 1) statByAllegiance(mechAllegiance(e.index), 0xa563b, 0xa5637, 0xa5639);
      else statByAllegiance(mechAllegiance(e.index), 0xa5678, 0xa5674, 0xa5676);
    }
    simTables.killCreditMech = -1;
  }
  e = l.entity!;
  if (((e.flags >> 8) & 0x14) !== 0) {
    if (e.gamepieceClass === 1) statByAllegiance(mechAllegiance(e.index), 0xa5652, 0xa564e, 0xa5650);
    else statByAllegiance(mechAllegiance(e.index), 0xa567e, 0xa567a, 0xa567c);
  }
  if (e.groupId === m.mechTable[m.playerMechIndex]!.groupId) statInc(l.status === 5 ? 0xa5666 : 0xa5664);
  if (net.netRole !== 0 && m.playerMechIndex !== e.index) return;
  if (mechAllegiance(e.index) === 1) {
    let cue = -1;
    switch (e.gamepieceClass) {
      case 1:
        cue = 0x15; // enemy mech destroyed
        break;
      case 2:
      case 4:
        cue = 0x16;
        break;
      case 3:
        cue = 0x19;
        break;
      case 5:
      case 8:
        cue = 0x17;
        break;
    }
    if (cue !== -1) soundCuePlay(cue, -1);
  }
  e.flags = (e.flags | 6) & 0xffff;
  l.stateTimer = 0;
  l.torsoNode = null;
  l.weaponAimNode = null;
  if (m.netGameEnabled === 0) {
    if (l.status !== 5 || m.playerMechIndex !== e.index) l.status = 4;
    mechAiReset(e);
    if (groupGetLeader(e.groupId) === e.index) {
      const leader = groupElectLeader(e.groupId);
      groupRetargetSecondary(e.groupId, e.index, leader);
      logWrite(`${String(clock.simTick).padStart(6, ' ')} : New leader for group ${e.groupId} : ${leader}\n`);
    }
  } else {
    l.status = 4;
  }
  if (m.playerMechIndex !== e.index && groupGetLeader(e.groupId) === m.playerMechIndex) radioLanceMessage(6, e.starSlot);
  mechApplyDetailLevel(e.index, 1);
}

/**
 * The eject / self-destruct request. Nothing once dead (4) or ejecting (5).
 * With `commit` for the player: status 5 and the ejection sound, or - with
 * ejection disabled - cue 0x20 and no change. Without it, the player hears
 * cue 4. Every path then runs mech_on_destroyed, which for an AI mech (and
 * for an uncommitted player) destroys it where it stands.
 *
 * @mw2 mech_eject 0x000265f0
 * @fidelity exact
 */
export function mechEject(l: MechLoadout, commit: number): void {
  if (l.status === 4 || l.status === 5) return;
  const player = isPlayer(l);
  if (commit === 0 || !player) {
    if (player) soundCuePlay(4, -1);
  } else if (lighting.ejectDisabled === 0) {
    l.status = 5;
    soundPlay(0xc5, 100, 0x40, 5, 0x32);
  } else {
    soundCuePlay(0x20, -1);
  }
  mechOnDestroyed(l);
}
