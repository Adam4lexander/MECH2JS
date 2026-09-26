/**
 * Weapons: the per-weapon fireState machine, the triggers, group and chain
 * fire, firing a round, and the missile lock. The originals sit in the
 * decompilation's cockpit and weapons modules (0x52020..0x53410).
 *
 * MechWeapon.fireState: -1 out of ammo (terminal), 0 cooling down, 1 ready,
 * 2 mid-burst, 3 auto-repeat reload. Times are 182 Hz ticks; the stats are
 * weaponTypes rows (listing/weapons.txt).
 */
import { fixedAsin, fixedAtan2 } from '../../core/angle/trig.ts';
import { cdiv, cmod } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import { Ray } from '../../generated/classes.gen.ts';
import type { MechEntity, MechLoadout, MechWeapon, SceneNode } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { clock } from '../../engine/clock.ts';
import { raySetLength, vec3Normalise } from '../../engine/collision/ray.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';
import {
  sceneNodeGetWorldPos,
  sceneNodeRemoveSubtreeFromWorld,
  sceneNodeSetEuler,
  sceneNodeSetOrigin,
  sceneNodeTranslate,
  sceneNodeWalk,
  sceneSubtreeMoveToWorldList,
} from '../../engine/scene/sceneGraph.ts';
import { aiBearingToTarget, mechCanJump, mechHeadingError, mechProbeRay } from '../ai/aiGeometry.ts';
import { viewerProjectPoint } from '../camera/projection.ts';
import { cameraGlobals } from '../camera/viewer.ts';
import { messagePost } from '../cockpit/messages.ts';
import { effectSpawnOnMount } from '../effects/effects.ts';
import { PROJECTILE_COUNT, simTables, statsWordAdd } from '../effects/simTables.ts';
import { weaponTypes } from '../mech/config.ts';
import { loadoutAmmo, loadoutWeapons } from '../mech/loadout.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { soundCuePlay, soundPlay, soundPlayAt, soundPlayDelayed } from '../sound/sound.ts';
import { planet } from '../world/planet.ts';
import { worldRaycast } from '../world/collision.ts';
import { mechAimRange, mechUpdateAimRange, weaponBuildFireRay } from './aim.ts';

export const weaponGlobals = registerGlobals(
  'weapons',
  {
    /**
     * 0x9fd44: 1 chain fire (the trigger fires the selected weapon), 0 group
     * fire (the player's trigger fires the selected weapon's whole group);
     * toggle_group_fire flips it. 1 in the image.
     */
    chainFireMode: 1,
    /**
     * 0x1593f0: ten dwords, one per weapon's originalIndex; mech_weapons_tick
     * sets one on the first round of each of the player's bursts, for the
     * netplay packet. Nothing in single player reads them.
     */
    netplayWeaponFiredLocal: new Int32Array(10),
  },
  () => {
    weaponGlobals.chainFireMode = imageI32(LABEL.chainFireMode, 1);
    weaponGlobals.netplayWeaponFiredLocal = Int32Array.from(imageI32s(LABEL.netplayWeaponFiredLocal, 10, new Array<number>(10).fill(0)));
  },
);

const viewerPos = () => cameraGlobals.viewerPosition ?? cameraGlobals.mainViewer;
const isPlayer = (e: MechEntity) => mechs.playerMechIndex === e.index;

/**
 * weapons[i].fireGroup. For i = -1 the C reads 0x5c bytes before the
 * weapons array: the loadout's dword at +0xb2, the high word of
 * throttleScale and the low word of weaponCycleLock.
 */
function fireGroupOf(l: MechLoadout, i: number): number {
  if (i >= 0) return loadoutWeapons(l)[i]!.fireGroup;
  quirk('weapons[-1].fireGroup: reads the loadout dword at +0xb2 (throttleScale >> 16 | weaponCycleLock << 16)', 'weapon_select');
  return ((l.throttleScale >>> 16) | (l.weaponCycleLock << 16)) | 0;
}

/** true when none of the five fire controls is held */
function noTriggerHeld(e: MechEntity): boolean {
  const c = e.control!;
  return c.weapon_fire === 0 && c.weapon_fire_group === 0 && c.weapon_fire_group_1 === 0 && c.weapon_fire_group_2 === 0 && c.weapon_fire_group_3 === 0;
}

/** Arming, as the trigger and group fire both do it: a weapon in state 1 starts a burst. */
function armWeapon(w: MechWeapon, l: MechLoadout): void {
  const wt = weaponTypes()[w.type]!;
  w.fireState = 2;
  w.shotsLeft = wt.shots;
  w.stateTick = 0;
  weaponFireAlertTarget(w, l);
  if (wt.guided === 0 || (l.flags & 0x80) === 0) {
    w.lockType = 0;
    w.lockIndex = w.lockType;
  } else {
    w.lockIndex = l.entity!.targetHandle & 0xff;
    w.lockType = l.entity!.targetHandle & 0xf00;
  }
}

/**
 * One tick of a mech's weapons, while its status is 2 (running).
 *
 * TRIGGERS: toggle_group_fire flips chainFireMode (cue 6 'Chain fire' or 7
 * 'Group fire'). In group fire the player's weapon_fire becomes
 * weapon_fire_group. Unless loadout flags 0x4000 is set, and with a weapon
 * selected, the first held of weapon_fire_group, _1, _2, _3, weapon_fire acts
 * - only on the tick the trigger latch (flags 0x0001) goes from clear to
 * set: group fire arms the selected weapon's group, _1.._3 select group 0..2
 * and arm it, weapon_fire arms the selected weapon if ready (else sound
 * 0x149). With none held and the latch set, the latch clears and the
 * selection steps to the next usable weapon of its group. With flags 0x4000
 * the trigger section is replaced by a one-shot group copy onto the next
 * weapon.
 *
 * THE MACHINE, for all ten slots with a type: 0 -> 1 after reload ticks;
 * 2 fires a round each shotGap ticks of the burst clock (stateTick +
 * tickDelta, several in one long frame), with both muzzle effects and the
 * type's heat PER ROUND; a burst's first round plays fireSound and raises
 * the netplay flag; out of rounds it drops to 0 (cooldown from now), or to
 * 3 when the type auto-repeats and a fire control is held; 3 -> 2 after
 * reload if the weapon is selected or a GROUP control is held, else -> 1.
 * mech_weapon_fire returning 0 (no mount, or the round that empties the
 * ammo) clears the latch and the burst with no effect, heat or sound.
 *
 * @mw2 mech_weapons_tick 0x00052080
 * @fidelity exact
 */
export function mechWeaponsTick(l: MechLoadout): void {
  if (l.status !== 2) return;
  const g = weaponGlobals;
  const e = l.entity!;
  const types = weaponTypes();
  const weapons = loadoutWeapons(l);
  let firstShot = false;
  l.selectedWeaponCopy = l.selectedWeapon;
  if (e.control!.toggle_group_fire !== 0) {
    const cue = g.chainFireMode === 0 ? 6 : 7;
    g.chainFireMode = g.chainFireMode === 0 ? 1 : 0;
    soundCuePlay(cue, 1);
  }
  if ((l.flags & 0x4000) === 0) {
    if (l.selectedWeapon !== -1) {
      const w = weapons[l.selectedWeapon]!;
      if (g.chainFireMode === 0 && isPlayer(e)) {
        const c = e.control!;
        c.weapon_fire_group = c.weapon_fire;
        e.control!.weapon_fire = 0;
      }
      const c = e.control!;
      const latched = (l.flags & 1) !== 0;
      if (c.weapon_fire_group !== 0) {
        if (!latched) {
          l.flags |= 1;
          playerFireGroup();
        }
      } else if (c.weapon_fire_group_1 !== 0 || c.weapon_fire_group_2 !== 0 || c.weapon_fire_group_3 !== 0) {
        if (!latched) {
          l.flags |= 1;
          const group = c.weapon_fire_group_1 !== 0 ? 0 : c.weapon_fire_group_2 !== 0 ? 1 : 2;
          if (weaponSelectGroup(l, group) !== 0) playerFireGroup();
        }
      } else if (c.weapon_fire !== 0) {
        if (!latched) {
          l.flags |= 1;
          if (w.fireState === 1) armWeapon(w, l);
          else soundPlay(0x149, 100, 0x40, 5, 0x32);
        }
      } else if (latched) {
        l.flags &= 0xfffe;
        weaponSelectNextInGroup(l, 0);
      }
    }
  } else {
    l.flags ^= 0x4000;
    let next = l.selectedWeapon + 1;
    const nw = weapons[next];
    if (!nw) unestablished(`mech_weapons_tick: weapons[${next}] is past the ten slots (the C reads the sections that follow)`, 'mech_weapons_tick');
    if (nw?.slotState === -1) next = 0;
    weaponSetFireGroup(l, next, fireGroupOf(l, l.selectedWeapon));
  }

  for (let slot = 0; slot < 10; slot++) {
    const w = weapons[slot]!;
    const type = w.type;
    if (type < 0) continue;
    const wt = types[type]!;
    const state = w.fireState >>> 0; // compared unsigned: -1 matches no case
    if (state < 2) {
      if (state === 0 && wt.reload <= ((clock.simTick - w.stateTick) | 0)) {
        w.fireState = 1;
        w.stateTick = 0;
      }
    } else if (state < 3) {
      let clk: number;
      if (w.shotsLeft < 1) {
        w.fireState = 0;
        clk = clock.simTick;
        w.shotsLeft = 0;
      } else {
        if (w.shotsLeft === wt.shots) firstShot = true;
        clk = (clock.tickDelta + w.stateTick) | 0;
        let repeat = false;
        for (;;) {
          let fired = false;
          while (clk >= wt.shotGap && w.shotsLeft >= 1) {
            e.mountNode = l.sectionNodes[w.sectionIndex] ?? null;
            if (mechWeaponFire(e, w) !== 0) {
              fired = true;
              break;
            }
            l.flags &= 0xfffe;
            w.shotsLeft = 0;
          }
          if (!fired) break;
          effectSpawnOnMount(wt.muzzleEffects[0]!, e);
          effectSpawnOnMount(wt.muzzleEffects[1]!, e);
          w.shotsLeft = (w.shotsLeft - 1) | 0;
          clk = (clk - wt.shotGap) | 0;
          w.stateTick = clk;
          l.heatThisTick = (l.heatThisTick + wt.heat) | 0;
          if (firstShot) {
            firstShot = false;
            if (isPlayer(e)) g.netplayWeaponFiredLocal[w.originalIndex] = 1;
            if (0 < wt.fireSound) {
              if (isPlayer(e) && cameraGlobals.cockpitViewActive !== 0) {
                let pan: number;
                switch (w.sectionIndex) {
                  case 2:
                  case 5:
                    pan = 0x4f;
                    break;
                  case 4:
                  case 6:
                    pan = 0x2f;
                    break;
                  default:
                    pan = 0x40;
                }
                weaponFireSoundPlay(wt.projectileKind, wt.fireSound, pan);
              } else {
                const v = viewerPos();
                soundPlayAt((v.posX - e.posX) | 0, (v.posY - e.posY) | 0, (v.posZ - e.posZ) | 0, wt.fireSound, cameraGlobals.cockpitViewActive);
              }
            }
          }
          if (w.shotsLeft === 0 && wt.autoRepeat !== 0 && !noTriggerHeld(e)) {
            repeat = true;
            break;
          }
        }
        if (repeat) {
          w.stateTick = clock.simTick;
          w.fireState = 3;
          w.shotsLeft = wt.shots;
        }
        if (w.fireState === 3) continue;
      }
      w.stateTick = clk;
    } else if (state === 3 && wt.reload <= ((clock.simTick - w.stateTick) | 0)) {
      const c = e.control!;
      if (weapons[l.selectedWeapon] === w || c.weapon_fire_group !== 0 || c.weapon_fire_group_1 !== 0 || c.weapon_fire_group_2 !== 0 || c.weapon_fire_group_3 !== 0) {
        w.fireState = 2;
      } else {
        w.fireState = 1;
      }
      w.stateTick = 0;
    }
  }
}

/**
 * Fires one round. No mech or no mountNode: 0. No ammo: 0. Otherwise the
 * player's shot tally and the player's group's shot tally go up; a weapon
 * with ammo (not -1, the energy weapons) spends a round - unless it is the
 * player's with unlimitedAmmo - from its current bin, stepping to the next
 * bin once the current one reads 0 (never past numBins); ammo reaching 0
 * sets fireState -1 and makes the result 0, though the round still flies.
 * A type that launchesProjectile takes the first idle pooled projectile of
 * its projectileKind that has a node: age = the weapon's stateTick (the burst
 * clock from BEFORE this tick) and timeLeft = flightTime - that (THE AGED
 * LAUNCH, see projectile_update), the effect word, damage and heatOnHit, the
 * weapon's lock as target, velocity projectileSpeed times the unit shot
 * direction, acceleration (0, -gravity * gravityScale, 0); then it is placed
 * at the muzzle and moved to the drawn list, off the collision chain. For
 * the player, playerLastMissile becomes its slot for kinds 3 and 4, -1
 * otherwise. Non-player mechs refresh their aim range first.
 *
 * @mw2 mech_weapon_fire 0x00052620
 * @fidelity exact
 */
export function mechWeaponFire(mech: MechEntity | null, w: MechWeapon): number {
  const wt = weaponTypes()[w.type]!;
  let result = 1;
  if (mech === null || mech.mountNode === null) return 0;
  if (w.ammo === 0) return 0;
  const m = mechs;
  if (m.playerMechIndex === mech.index) statsWordAdd(0xa5643);
  if (m.mechTable[mech.index]!.groupId === m.mechTable[m.playerMechIndex]!.groupId) statsWordAdd(0xa565a);
  if (w.ammo !== -1 && (m.simOptions.unlimitedAmmo === 0 || m.playerMechIndex !== mech.index)) {
    w.ammo = (w.ammo - 1) | 0;
    const bin = w.bin;
    if (!bin) {
      unestablished('mech_weapon_fire: a weapon with ammo has no bin (the C would dereference null)', 'mech_weapon_fire');
    } else if (bin.rounds === 0) {
      w.binCursor = (w.binCursor + 1) | 0;
      if (w.binCursor === w.numBins) {
        w.binCursor = (w.binCursor - 1) | 0;
      } else {
        const ammo = loadoutAmmo(mech.loadout!);
        const next = ammo[ammo.indexOf(bin) + 1];
        if (!next) unestablished('mech_weapon_fire: the next ammo bin is past the loadout\'s 0x19', 'mech_weapon_fire');
        w.bin = next ?? null;
      }
    } else {
      bin.rounds = ((bin.rounds - 1) << 16) >> 16;
    }
    if (w.ammo === 0) {
      result = 0;
      w.fireState = -1;
    }
  }
  if (wt.launchesProjectile === 0) return result;
  const t = simTables;
  let found = false;
  let i = 0;
  let p = t.projectiles[0]!;
  for (; !found && i < PROJECTILE_COUNT; i++) {
    p = t.projectiles[i]!;
    if (p.id === wt.projectileKind && p.active === 0 && p.node !== null) found = true;
  }
  if (!found) return result;
  if (mech.index !== m.playerMechIndex) mechUpdateAimRange(mech);
  p.age = w.stateTick;
  p.timeLeft = (wt.flightTime - w.stateTick) | 0;
  p.effectIndex = wt.impactEffect & 0xff;
  p.impactFlags = (wt.impactEffect >> 8) & 0xff;
  p.effectHigh = (wt.impactEffect >>> 16) & 0xffff;
  p.damage = wt.damage;
  p.active = 1;
  p.motionHeld = 0;
  p.heatOnHit = wt.heatOnHit;
  p.targetIndex = w.lockIndex;
  p.targetType = w.lockType;
  p.attackerMechIndex = mech.index;
  const speed = wt.projectileSpeed;
  const dir = mechShotDirection(mech);
  vec3Normalise(dir);
  p.velX = Math.imul(speed, dir[0]!);
  p.velY = Math.imul(speed, dir[1]!);
  p.velZ = Math.imul(speed, dir[2]!);
  // -gravity * (gravityScale << 16) >> 16, rounded (shrd + adc at 0x52815)
  const accelY = mulr16(-planet.gravity | 0, wt.gravityScale << 16);
  p.accelZ = 0;
  p.accelY = accelY;
  p.accelX = p.accelZ;
  const spread = p.id === 3 || p.id === 4 ? 1 : 0;
  projectilePlaceOnFire(mech, p.node!, dir[0]!, dir[1]!, dir[2]!, spread);
  sceneSubtreeMoveToWorldList(p.node!);
  sceneNodeRemoveSubtreeFromWorld(p.node!);
  sceneNodeWalk(p.node!);
  if (m.playerMechIndex === mech.index) {
    t.playerLastMissile = p.id === 3 || p.id === 4 ? i - 1 : -1;
  }
  return result;
}

/**
 * Points a launched round's node along the shot: pitch = -asin(dirY),
 * yaw = atan2(dirX, dirZ). Puts it at the mech's mountNode, and for
 * missiles (spread, kinds 3 and 4) offsets it by ONE draw r = -100..99 along
 * both p = normalise(-dirZ, 0, dirX) and u = (dirY*p.z, dirZ*p.x + dirX*p.z,
 * -dirY*p.x) - so a line, not a disc, and u's y sign is not the cross
 * product's. Then pushes it along the shot by twice its object's radius.
 *
 * @mw2 projectile_place_on_fire 0x00053410
 * @fidelity exact
 */
export function projectilePlaceOnFire(mech: MechEntity, node: SceneNode, dirX: number, dirY: number, dirZ: number, spread: number): void {
  const yaw = fixedAtan2(dirX, dirZ);
  const asin = fixedAsin(dirY << 13);
  sceneNodeSetEuler(node, -asin | 0, yaw, 0, 0);
  let [x, y, z] = sceneNodeGetWorldPos(mech.mountNode!);
  if (spread !== 0) {
    const r = (randomRange(200) - 100) | 0;
    const pv = [-dirZ | 0, 0, dirX];
    vec3Normalise(pv);
    const px = pv[0]!;
    const pz = pv[2]!;
    const ux = mulr16(dirY, pz);
    const uy = (mulr16(dirZ, px) + mulr16(pz, dirX)) | 0;
    const uz = -mulr16(px, dirY) | 0;
    x = (x + mulr16(r, px) + mulr16(r, ux)) | 0;
    y = (y + mulr16(r, uy)) | 0;
    z = (z + mulr16(r, pz) + mulr16(r, uz)) | 0;
  }
  sceneNodeSetOrigin(node, x, y, z);
  const d = Math.imul(node.userData!.radius, 2);
  sceneNodeTranslate(node, mulr16(dirX, d), mulr16(dirY, d), mulr16(dirZ, d));
}

/**
 * The shot's direction, not normalised: from the mountNode's world position
 * to the point aimRange along the fire ray - so the weapons converge where
 * the aim range says.
 *
 * @mw2 mech_shot_direction 0x00053250
 * @fidelity exact
 */
export function mechShotDirection(mech: MechEntity): number[] {
  const ray = new Ray();
  weaponBuildFireRay(mech, ray);
  raySetLength(ray, mechAimRange(mech));
  const [x, y, z] = sceneNodeGetWorldPos(mech.mountNode!);
  return [(ray.endX - x) | 0, (ray.endY - y) | 0, (ray.endZ - z) | 0];
}

/**
 * Group fire for the player's mech: from the next usable weapon of the
 * selected weapon's group round to it again, arms every READY weapon
 * (fireState 1) exactly as a trigger pull does; others are skipped. The
 * selection is restored.
 *
 * @mw2 player_fire_group 0x00052d60
 * @fidelity exact
 */
export function playerFireGroup(): void {
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  const weapons = loadoutWeapons(l);
  const saved = l.selectedWeapon;
  weaponSelectNextInGroup(l, 0);
  const start = l.selectedWeapon;
  do {
    const w = weapons[l.selectedWeapon]!;
    if (w.fireState === 1) armWeapon(w, l);
    weaponSelectNextInGroup(l, 0);
  } while (start !== l.selectedWeapon);
  l.selectedWeapon = saved;
}

/**
 * Selects a usable weapon of fire group 0..2: 1 if the selected one is
 * already in it or one is found (first by slot), else 0.
 *
 * @mw2 weapon_select_group 0x00052a60
 * @fidelity exact
 */
export function weaponSelectGroup(l: MechLoadout, group: number): number {
  if (group < 0 || group >= 3) return 0;
  if (l.numWeapons < 1) return 0;
  if (group === fireGroupOf(l, l.selectedWeapon)) return 1;
  const weapons = loadoutWeapons(l);
  for (let i = 0; i < 10; i++) {
    const w = weapons[i]!;
    if (w.type > -1 && w.slotState !== -1 && group === w.fireGroup && w.fireState !== -1) {
      l.selectedWeapon = i;
      return 1;
    }
  }
  return 0;
}

/**
 * The selected weapon's readiness: 1 when its fireState is 1 (ready), 0 in
 * any other state, -1 when nothing is selected.
 *
 * @mw2 selected_weapon_ready 0x00052af0
 * @fidelity exact
 */
export function selectedWeaponReady(l: MechLoadout): number {
  if (l.selectedWeapon === -1) return -1;
  return loadoutWeapons(l)[l.selectedWeapon]!.fireState === 1 ? 1 : 0;
}

/**
 * Steps the selection to the next usable weapon (slot order, wrapping, nine
 * tries) in the selected weapon's fire group; failing that, with
 * orNextGroup, to the next group that has one.
 *
 * @mw2 weapon_select_next_in_group 0x000528b0
 * @fidelity exact
 */
export function weaponSelectNextInGroup(l: MechLoadout, orNextGroup: number): void {
  let found = false;
  if (l.numWeapons < 1) return;
  const weapons = loadoutWeapons(l);
  const sel = l.selectedWeapon;
  const group = fireGroupOf(l, sel);
  let i = sel;
  for (let n = 1; n < 10; n++) {
    i = cmod(i + 1, 10);
    const w = weapons[i]!;
    if (w.type > -1 && w.slotState !== -1 && w.fireGroup === group && w.fireState !== -1 && i !== sel) {
      l.selectedWeapon = i;
      found = true;
      break;
    }
  }
  if (!found && orNextGroup !== 0) weaponSelectNextGroup(l);
}

/**
 * Selects the first usable weapon of the next fire group that has one,
 * searching (group + 1) % 10 onward and giving up on coming back round.
 *
 * @mw2 weapon_select_next_group 0x000529d0
 * @fidelity exact
 */
export function weaponSelectNextGroup(l: MechLoadout): void {
  let found = false;
  if (l.numWeapons < 1) return;
  const weapons = loadoutWeapons(l);
  const start = fireGroupOf(l, l.selectedWeapon);
  let g = start;
  for (;;) {
    g = cmod(g + 1, 10);
    if (g === start) return;
    if (found) return;
    for (let i = 0; i < 10; i++) {
      const w = weapons[i]!;
      if (w.type > -1 && w.slotState !== -1 && g === w.fireGroup && w.fireState !== -1) {
        found = true;
        l.selectedWeapon = i;
        break;
      }
    }
  }
}

/**
 * weapons[weaponIndex].fireGroup = group, for 0 <= group < 3 only.
 *
 * @mw2 weapon_set_fire_group 0x00052c40
 * @fidelity exact
 */
export function weaponSetFireGroup(l: MechLoadout, weaponIndex: number, group: number): void {
  if (group > -1 && group < 3) {
    const w = loadoutWeapons(l)[weaponIndex];
    if (!w) {
      unestablished(`weapon_set_fire_group: weapons[${weaponIndex}] is outside the ten slots`, 'weapon_set_fire_group');
      return;
    }
    w.fireGroup = group;
  }
}

/**
 * Stores group in the player's selected weapon's fireGroup, unchecked
 * (command_execute's 0x8e..0x90 pass 0, 1, 2).
 *
 * @mw2 player_weapon_set_fire_group 0x00052c60
 * @fidelity exact
 */
export function playerWeaponSetFireGroup(group: number): void {
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  const w = loadoutWeapons(l)[l.selectedWeapon];
  if (w) {
    w.fireGroup = group;
    return;
  }
  // selectedWeapon -1: the dword lands at loadout +0xb2, over throttleScale's high word and weaponCycleLock's low word
  quirk('player_weapon_set_fire_group with no weapon selected writes loadout +0xb2 (throttleScale high word, weaponCycleLock low word)', 'player_weapon_set_fire_group');
  l.throttleScale = ((l.throttleScale & 0xffff) | (group << 16)) | 0;
  l.weaponCycleLock = ((l.weaponCycleLock & ~0xffff) | (group >>> 16)) | 0;
}

/**
 * Steps selectedWeapon to the next slot with a type (wrapping at 10, and
 * back to 0 on reaching an unused slot), stopping at one not out of ammo -
 * or after ten out-of-ammo weapons.
 *
 * @mw2 weapon_cycle_next 0x00052950
 * @fidelity exact
 */
export function weaponCycleNext(l: MechLoadout): void {
  let done = false;
  let empties = 0;
  if (l.numWeapons < 1) return;
  const weapons = loadoutWeapons(l);
  while (!done) {
    l.selectedWeapon = cmod(l.selectedWeapon + 1, 10);
    if (weapons[l.selectedWeapon]!.type > -1) {
      if (weapons[l.selectedWeapon]!.slotState === -1) l.selectedWeapon = 0;
      if (weapons[l.selectedWeapon]!.fireState !== -1 || ++empties === 10) done = true;
    }
  }
}

/**
 * weapon_select_next_group on the player's mech.
 *
 * @mw2 weapon_cycle_group 0x00052c90
 * @fidelity exact
 */
export function weaponCycleGroup(): void {
  weaponSelectNextGroup(mechs.mechTable[mechs.playerMechIndex]!.loadout!);
}

/**
 * Jettisons the selected weapon's ammunition: with a weapon selected whose
 * type has shots and which has ammo, sound 0xb3 twice around the message,
 * ammo 0 and fireState -1; returns 1. The bins are not touched. Else 0.
 *
 * @mw2 weapon_jettison_ammo 0x00052b20
 * @fidelity exact
 */
export function weaponJettisonAmmo(l: MechLoadout): number {
  const sel = l.selectedWeapon;
  if (sel === -1) return 0;
  const w = loadoutWeapons(l)[sel]!;
  if (weaponTypes()[w.type]!.shots < 1 || w.ammo < 1) return 0;
  soundPlay(0xb3, 100, 0x40, 5, 0x50);
  messagePost('Ammo for current weapon jettisonned.', 1, 0x16c);
  soundPlay(0xb3, 100, 0x40, 5, 0x32);
  w.ammo = 0;
  w.fireState = -1;
  return 1;
}

/**
 * The fire-sound call for the player's own weapons in the cockpit view:
 * sound_play_delayed(0, 0, sound, 0x32, pan, 0x32) for a positive sound.
 * The first argument (the projectile kind) is not read.
 *
 * @mw2 weapon_fire_sound_play 0x000287f0
 * @fidelity exact
 */
export function weaponFireSoundPlay(_unused: number, sound: number, pan: number): void {
  if (0 < sound) soundPlayDelayed(0, 0, sound, 0x32, pan, 0x32);
}

/** 1 when every |x| < 0x100000 (16 degrees), abs as cdq/xor/sub computes it */
const absI32 = (x: number) => ((x ^ (x >> 31)) - (x >> 31)) | 0;

/**
 * dist2 compared with range^2 as the code does it: a 64-bit subtract whose
 * borrow means "below", and otherwise equality of the LOW dwords only.
 */
function withinRange(d2: bigint, range: number): boolean {
  const r2 = BigInt.asUintN(64, BigInt(range | 0) * BigInt(range | 0));
  if (d2 < r2) return true;
  return BigInt.asUintN(32, d2) === BigInt.asUintN(32, r2);
}

/**
 * The missile lock. Clears LOCKED (flags 0x80), then with a weapon
 * selected, a target that is not 0x1000 or 0x100, and a guided type: the
 * target point must be beyond minRange and within maxRange (64-bit squares;
 * "equal" tests the low dwords only), and the heading error (desiredHeading -
 * heading, less the torso twist aimAngle, each wrapped to +/-180) and the
 * torso tilt (ramps[1] + torsoTilt) must both be under 16 degrees. Then
 * 0x8000 (in the cone) is set; the first such tick starts the lock clock
 * (stateTimer = 0x16c, flags 0x40), later ones count it down by tickDelta
 * and at 0 set LOCKED. Out of the cone: 0x8000 clears and a running lock
 * clock counts back UP, dropping 0x40 at 0x16c. No weapon, target or guided
 * type clears 0x8000 and 0x40 outright.
 *
 * @mw2 mech_update_missile_lock 0x00052ea0
 * @fidelity exact
 */
export function mechUpdateMissileLock(l: MechLoadout): void {
  const M = 0x1680000;
  l.flags &= 0xff7f;
  const sel = l.selectedWeapon;
  const e = l.entity!;
  if (sel === -1 || e.targetHandle === 0 || (e.targetHandle & 0x1000) !== 0 || (e.targetHandle & 0x100) !== 0 || weaponTypes()[loadoutWeapons(l)[sel]!.type]!.guided === 0) {
    l.flags &= 0x7fbf;
    return;
  }
  const wt = weaponTypes()[loadoutWeapons(l)[sel]!.type]!;
  const dx = BigInt((e.posX - e.targetX) | 0);
  const dy = BigInt((e.posY - e.targetY) | 0);
  const dz = BigInt((e.posZ - e.targetZ) | 0);
  const d2 = BigInt.asUintN(64, dx * dx + dy * dy + dz * dz);
  let inCone = false;
  let yawErr = 0x100001;
  let tilt = 0x100001;
  if (!withinRange(d2, wt.minRange) && withinRange(d2, wt.maxRange)) {
    const heading = cmod((cmod(e.heading, M) + M) | 0, M);
    let err = (e.desiredHeading - heading) | 0;
    inCone = true;
    if (err > 0xb40000) err = (err - M) | 0;
    else if (err < -0xb40000) err = (err + M) | 0;
    err = (err - cmod(e.aimAngle, M)) | 0;
    if (err > 0xb40000) err = (err - M) | 0;
    else if (err < -0xb40000) err = (err + M) | 0;
    yawErr = err;
    tilt = cmod((l.ramps[1]!.current + e.torsoTilt) | 0, M);
  } else {
    l.flags &= 0x7fff;
  }
  if (!inCone || absI32(yawErr) >= 0x100000 || absI32(tilt) >= 0x100000) {
    l.flags &= 0x7fff;
    if ((l.flags & 0x40) !== 0) {
      l.stateTimer = (l.stateTimer + clock.tickDelta) | 0;
      if (l.stateTimer >= 0x16c) l.flags &= 0xffbf;
    }
    return;
  }
  l.flags |= 0x8000;
  if ((l.flags & 0x40) === 0) {
    l.stateTimer = 0x16c;
    l.flags |= 0x40;
    return;
  }
  if (0 < l.stateTimer) {
    l.stateTimer = (l.stateTimer - clock.tickDelta) | 0;
    return;
  }
  l.stateTimer = 0;
  l.flags |= 0x80;
}

/**
 * The fire position of `loadout`'s aim point on screen: the fire ray cut to
 * aimRange, projected. Returns viewer_project_point's result and sx, sy.
 *
 * @mw2 aim_point_to_screen 0x00029860
 * @fidelity exact
 */
export function aimPointToScreen(l: MechLoadout): { visible: number; sx: number; sy: number } {
  const ray = new Ray();
  weaponBuildFireRay(l.entity!, ray);
  raySetLength(ray, mechAimRange(l.entity!));
  const p = [ray.endX, ray.endY, ray.endZ];
  const visible = viewerProjectPoint(viewerPos(), p);
  return { visible, sx: p[0]!, sy: p[1]! };
}

/**
 * The dodge warning a guided weapon (or the PPC, type 0x15) gives when it is
 * armed, for a shooter whose aiCapabilities has 4, two times in three. The
 * target is the shooter's target mech (targetSecondary when it carries 0x200
 * and the shooter is not controlSource 2), unless it is already dodging
 * (pendingBehaviour 4). An AI shooter (controlSource 2) warns it outright;
 * otherwise the aim point and the target must both be on screen, the torso
 * tilt / 0xf00 within +/-0x30000 and the heading error within 15 degrees.
 * A warned target that can jump (mech_can_jump(0x41)) - two times in three -
 * probes two sides of the quadrant it faces the shooter from with a 50 m
 * ray and takes the first clear one as pendingBehaviour 0xb (aiDirection
 * the probe's direction); failing that, with aiCapabilities 2, behaviour 4.
 *
 * @mw2 weapon_fire_alert_target 0x0002e450
 * @fidelity exact
 * @divergence returns nothing: the C's return is whatever EAX last held, and both callers discard it
 */
export function weaponFireAlertTarget(w: MechWeapon, l: MechLoadout): void {
  const e = l.entity!;
  let target: MechEntity | null = null;
  if ((e.aiCapabilities & 4) === 0) return;
  if (randomRange(3) === 0) return;
  // [type * 0x58 + 0x9ee70]: weaponTypes[type].guided
  if (weaponTypes()[w.type]!.guided === 0 && w.type !== 0x15) return;
  const handle = e.controlSource === 2 || (e.targetSecondary & 0x200) === 0 ? e.targetHandle : e.targetSecondary & 0xffff;
  const idx = handle & 0xff;
  if (idx === 0 || (handle & 0xf00) !== 0x200) return;
  const t = mechs.mechTable[idx]!;
  if (t.pendingBehaviour === 4) return;
  if (e.controlSource === 2) target = t;
  if (target === null && aimPointToScreen(l).visible !== 0) {
    const p = [t.posX, t.posY, t.posZ];
    if (viewerProjectPoint(viewerPos(), p) !== 0) {
      const tilt = cdiv(e.torsoTilt, 0xf00);
      const rem = cmod(mechHeadingError(e) >> 16, 0x168);
      if (tilt < 0x30000 && tilt > -0x30000 && rem < 0xf && rem > -0xf) target = mechs.mechTable[idx]!;
    }
  }
  if (target === null) return;
  if (mechCanJump(target, 0x41) === 0) return;
  if (randomRange(3) !== 0) {
    const saved = target.targetHandle;
    aiBearingToTarget(target, (e.index << 16) >> 16);
    const bearing = cmod((mechHeadingError(target) + 0x1680000) | 0, 0x1680000);
    aiBearingToTarget(target, (saved << 16) >> 16);
    const quadrant = sdivShl(bearing, 16, 0x5a0000) >> 16;
    let side = randomRange(2) !== 0 ? -1 : 1;
    const direction = cmod((((quadrant << 16) >> 16) + 1) | 0, 4) * 4;
    for (let k = 0; k < 2; k++) {
      const ray = new Ray();
      mechProbeRay(target, ray, side, direction, 5000, 0);
      if (worldRaycast(ray, { v: null }, target.index) === 0) {
        target.pendingBehaviour = 0xb;
        target.aiDirection = direction;
        break;
      }
      side = -side;
    }
  }
  if (target.pendingBehaviour === 0 && (target.aiCapabilities & 2) !== 0) target.pendingBehaviour = 4;
}
