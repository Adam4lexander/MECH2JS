/**
 * Effects: explosions, muzzle flashes, jet exhaust and debris fragments,
 * each a pre-built simSlots entry (the XPLO chunks stock them) that
 * effect_spawn places and sim_slots_update retires; and the area damage an
 * effect, or the nuke, does while it lives. An effect's node goes on the
 * world LIST - so it is drawn - but off the world CHAIN, so rays and
 * collisions pass through it.
 *
 * Units: world units (cm), 182 Hz ticks. Distances are the octagonal
 * approximation (4 * max + mid + min) >> 2 throughout.
 */
import { mulr16 } from '../../core/int/fx16.ts';
import { i16 } from '../../core/int/cint.ts';
import { unestablished } from '../../core/provenance.ts';
import { randomRange } from '../../core/random.ts';
import type { MechEntity, SceneNode } from '../../generated/classes.gen.ts';
import { readEffectTypes, type EffectType } from '../../data/exe/tables/effects.ts';
import type { ExeImage } from '../../data/exe/ExeImage.ts';
import { clock } from '../../engine/clock.ts';
import { octLength } from '../../engine/collision/ray.ts';
import { bootImage } from '../../engine/image.ts';
import { objectLists } from '../../engine/scene/objectLists.ts';
import {
  sceneNodeGetWorldPos,
  sceneNodeRemoveSubtreeFromWorld,
  sceneNodeSetEuler,
  sceneNodeSetLocalMatrix,
  sceneNodeSetOrigin,
  sceneNodeTransform,
  sceneNodeWalk,
  sceneSubtreeMoveToAltList,
  sceneSubtreeMoveToWorldList,
} from '../../engine/scene/sceneGraph.ts';
import { objectGetPosRadius } from '../../engine/scene/worldObject.ts';
import { projectionGlobals } from '../camera/projection.ts';
import { cameraGetMode, viewer } from '../camera/viewer.ts';
import { mechApplyDamage } from '../mech/damage.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { net } from '../net/netplay.ts';
import { soundPlayAt } from '../sound/sound.ts';
import { destructiblesBlastDamage } from '../things/destructibles.ts';
import { fallingObjectAttach, fallingObjectRandomiseMotion } from '../things/fallingObjects.ts';
import { gamethingApplyDamage } from '../things/gameThingDamage.ts';
import { things } from '../things/gameThings.ts';
import { lighting } from '../world/environment.ts';
import { paletteFadeForEffect, paletteFadeStepsLeft } from '../world/palettes.ts';
import { bitmap3dSetEnable, bitmap3dSetFrame } from '../world/bitmap3d.ts';
import { worldRecordObject } from '../world/worldRecords.ts';
import { SIM_SLOT_COUNT, simTables } from './simTables.ts';

let effectCache: { exe: ExeImage; table: EffectType[] } | null = null;
/**
 * effectTypes (0x9f900), read from the boot image.
 *
 * @portOnly cache of the EXE table effect_spawn and sim_slots_update index
 */
export function effectTypes(): EffectType[] {
  const exe = bootImage();
  if (!exe) throw new Error('effectTypes: no boot image (setBootImage)');
  if (effectCache?.exe !== exe) effectCache = { exe, table: readEffectTypes(exe) };
  return effectCache.table;
}

/**
 * Spawns one effect. The code's low byte picks an effectTypes row (none above
 * 0x1f, none for a negative code); its impact bits (Projectile.impactFlags
 * << 8) swap some rows for a variant. Row 0xb launches fragments instead.
 * A row with needsNode or lightsScene claims an idle slot already carrying
 * that row - refused when live ones of the row below 0x17 already lie within
 * 500 (two are tolerated at lodQuality 1, none otherwise) - puts it at
 * (x, y, z) with the given
 * orientation, or on effectMountMech's mount for rows from 0x17, and starts
 * its sprite. A lightsScene row may take over the scene light at (lx, ly,
 * lz). Rows 3 and 4 spawn 0x10b as well. A positive soundId plays at the
 * offset from the viewer, subject to soundChance.
 *
 * Every caller passes a zero orientation.
 *
 * @mw2 effect_spawn 0x00051060
 * @fidelity exact
 */
export function effectSpawn(code: number, x: number, y: number, z: number, lx: number, ly: number, lz: number, pitch: number, yaw: number, roll: number): void {
  const t = simTables;
  let chain = false;
  let chainCode = -1;
  if ((code | 0) < 0) return;
  let row = code & 0xff;
  if (row > 0x1f) return;
  let px = x;
  let pz = z;
  switch (row) {
    case 0:
    case 1:
    case 2:
      if ((code & 0x2000) !== 0) row = 0xe + row;
      else if ((code & 0x400) !== 0) row = 9;
      break;
    case 3:
    case 4:
      if ((code & 0x400) !== 0) row = 0xc;
      else if ((code & 0x2000) !== 0) row = 0x11;
      else if ((code & 0x200) !== 0) row = row === 3 ? 0x13 : 0x14;
      chain = true;
      chainCode = 0x10b;
      break;
    case 5:
      if ((code & 0x100) !== 0) {
        // the one variant placed at the light point's x and z
        px = lx;
        row = 8;
        pz = lz;
      } else if ((code & 0x400) !== 0) row = 9;
      else if ((code & 0x2000) !== 0) row = 0x12;
      break;
    case 6:
      if ((code & 0x400) !== 0) row = 0x15;
      break;
    case 0xb:
      if ((code & 0x1000) === 0) {
        if ((code & 0x100) !== 0 || (code & 0x200) !== 0) {
          effectSpawnFragments(x, y, z, 4);
          return;
        }
        effectSpawnFragments(x, y, z, 8);
      } else {
        effectSpawnFragments(x, y, z, 0x10);
      }
      return;
  }
  const v = viewer();
  const dx = (v.posX - px) | 0;
  const viewY = v.posY;
  const dz = (v.posZ - pz) | 0;
  const et = effectTypes()[row]!;
  if (et.needsNode !== 0 || et.lightsScene !== 0) {
    let near = 0;
    let free = -1;
    for (let i = 0; i < SIM_SLOT_COUNT; i++) {
      const s = t.simSlots[i]!;
      if (row !== s.typeIndex) continue;
      if (s.active === 0) {
        if (free < 0 && (et.needsNode === 0 || s.node !== null)) free = i;
      } else if (s.typeIndex < 0x17) {
        if (octLength((s.x - px) | 0, (s.y - y) | 0, (s.z - pz) | 0) < 500) {
          near++;
          // lodQuality 1 allows two live ones nearby; any other setting none
          if (projectionGlobals.lodQuality !== 1) return;
          if (2 < near) return;
        }
      }
    }
    if (free < 0) return;
    const s = t.simSlots[free]!;
    s.x = px;
    s.y = y;
    s.z = pz;
    s.active = 1;
    s.timeLeft = (et.lifetime + clock.tickDelta) | 0;
    if (s.node !== null) {
      if (row < 0x17 || t.effectMountMech === null) {
        sceneNodeSetEuler(s.node, pitch, yaw, roll, 0);
        sceneNodeSetOrigin(s.node, px, y, pz);
      } else {
        // effectMountMech is cleared only on this path (label note: one-shot only when aligned)
        effectAlignToMount(t.effectMountMech, s.node);
        t.effectMountMech = null;
      }
      sceneSubtreeMoveToWorldList(s.node);
      sceneNodeRemoveSubtreeFromWorld(s.node);
      sceneNodeWalk(s.node);
      if (s.bitmapSlot !== -1) {
        bitmap3dRestart(s.bitmapSlot);
      }
    }
    if (et.lightsScene !== 0 && lighting.effectLightsAllowed !== 0) {
      let take = true;
      let already = false;
      if (t.effectLightActive !== 0) {
        const ox = (v.lightPos[0]! - v.posX) | 0;
        const oz = (v.lightPos[2]! - v.posZ) | 0;
        // a nearer effect moves the light; a farther one leaves it
        if (((Math.imul(dx, dx) + Math.imul(dz, dz)) | 0) < ((Math.imul(oz, oz) + Math.imul(ox, ox)) | 0)) already = true;
        else take = false;
      }
      if (take) {
        if (!already) {
          lighting.lightObjectFollow = 0;
          t.savedLight[0] = v.lightPos[0]!;
          t.savedLight[1] = v.lightPos[1]!;
          t.savedLight[2] = v.lightPos[2]!;
          t.savedLight[3] = v.lightDirectional;
          t.savedLight[4] = v.ambientLight;
          const dimmed = i16(v.ambientLight - 10);
          v.ambientLight = dimmed;
          t.effectLightActive = 1;
          if (0xff < dimmed || v.ambientLight < 0) v.ambientLight = 0x40;
          t.savedLight[5] = lighting.lightDimFlag;
          lighting.lightDimFlag = 0;
          v.lightDirectional = 0;
        }
        t.lightEffectSlot = free;
        s.ownsLight = 1;
        v.lightPos[0] = lx;
        v.lightPos[1] = ly;
        v.lightPos[2] = lz;
        if (-1 < et.screenFadePalette) paletteFadeForEffect(et.screenFadePalette, et.lifetime, 1);
      }
    }
  }
  if (chain) effectSpawn(chainCode, px, y, pz, lx, ly, lz, 0, 0, 0);
  if (0 < et.soundId && (et.soundChance === -1 || randomRange(100) < et.soundChance)) {
    const cockpit = cameraGetMode() === 0 && (code & 0x4000) === 0 ? 1 : 0;
    soundPlayAt(dx, (viewY - y) | 0, dz, et.soundId, cockpit);
  }
}

/** bitmap3d_set_frame(slot, 0) then bitmap3d_set_enable(slot, 2): rewind and play once */
function bitmap3dRestart(slot: number): void {
  bitmap3dSetFrame(i16(slot), 0);
  bitmap3dSetEnable(i16(slot), 2);
}

/**
 * @mw2 effect_spawn_at 0x00050fa0
 * @fidelity exact
 */
export function effectSpawnAt(code: number, x: number, y: number, z: number, lx: number, ly: number, lz: number): void {
  effectSpawn(code, x, y, z, lx, ly, lz, 0, 0, 0);
}

/**
 * Spawns an effect on a mech's weapon mount: the mech goes in
 * effectMountMech for effect_spawn, which aligns rows from 0x17 up to it.
 * A lower row is placed at (0, 0, 0), the position this passes.
 *
 * @mw2 effect_spawn_on_mount 0x00051000
 * @fidelity exact
 */
export function effectSpawnOnMount(code: number, mech: MechEntity): void {
  simTables.effectMountMech = mech;
  effectSpawn(code, 0, 0, 0, 0, 0, 0, 0, 0, 0);
}

/**
 * Launches up to `count` (0 means 256) idle row-0xb slots from (x, y, z) as
 * tumbling debris: each gets a falling-object slot of kind 1 and a random
 * motion, and lives effectTypes[0xb].lifetime.
 *
 * @mw2 effect_spawn_fragments 0x00051c50
 * @fidelity exact
 */
export function effectSpawnFragments(x: number, y: number, z: number, count: number): void {
  let launched = 0;
  if (count === 0) count = 0x100;
  for (let i = 0; i < SIM_SLOT_COUNT && launched < count; i++) {
    const s = simTables.simSlots[i]!;
    if (s.active !== 0 || s.typeIndex !== 0xb || s.node === null) continue;
    const node = s.node;
    const slot = fallingObjectAttach(node, 1);
    const life = effectTypes()[0xb]!.lifetime;
    if (slot !== -1) {
      s.active = 1;
      s.timeLeft = life;
      sceneNodeSetOrigin(node, x, y, z);
      fallingObjectRandomiseMotion(slot);
      sceneSubtreeMoveToWorldList(node);
      launched++;
      sceneNodeWalk(node);
    }
  }
}

/**
 * Gives an effect's node the mech's mountNode transform and world position.
 *
 * @mw2 effect_align_to_mount 0x000533c0
 * @fidelity exact
 */
export function effectAlignToMount(mech: MechEntity, effectNode: SceneNode): void {
  const mount = mech.mountNode;
  if (!mount) {
    unestablished('effect_align_to_mount: the mech has no mountNode (the original would read through a null pointer)', 'effect_align_to_mount');
    return;
  }
  const [mx, my, mz] = sceneNodeGetWorldPos(mount);
  sceneNodeSetLocalMatrix(effectNode, sceneNodeTransform(mount));
  sceneNodeSetOrigin(effectNode, mx, my, mz);
}

/**
 * The per-frame sweep of the 256 effect slots. First the nuke's blast and,
 * with heat tracking on, the heat of fires. Then every live slot whose row
 * has areaQuery damages everything within its own mesh radius - mechs (only
 * with splash damage on), gamethings and destructibles, at rate 0x100, EVERY
 * frame it lives. Each counts timeLeft down; at or below 0 it is retired,
 * except the slot holding the scene light while a palette fade still runs -
 * that waits, and once the fade is over the saved light is put back.
 *
 * @mw2 sim_slots_update 0x000515c0
 * @fidelity exact
 */
export function simSlotsUpdate(): void {
  const t = simTables;
  nukeBlastUpdate();
  if (mechs.simOptions.heatTracking !== 0) environmentHeatUpdate();
  for (let i = 0; i < SIM_SLOT_COUNT; i++) {
    const s = t.simSlots[i]!;
    if (s.active === 0) continue;
    if (effectTypes()[s.typeIndex]!.areaQuery !== 0) {
      const { x, y, z } = s;
      const obj = s.node?.userData ?? null;
      if (!obj) {
        unestablished('sim_slots_update: an area effect with no node object (the original reads its radius through a null pointer)', 'sim_slots_update');
      } else {
        const r = obj.radius;
        if (mechs.simOptions.splashDamage !== 0) mechsBlastDamage(x, y, z, r, 0x100);
        gamethingsNearPoint(x, y, z, r, 0x100);
        destructiblesBlastDamage(x, y, z, r, 0x100);
      }
    }
    s.timeLeft = (s.timeLeft - clock.tickDelta) | 0;
    if (s.timeLeft >= 1) continue;
    let retire = true;
    let restore = false;
    if (s.ownsLight !== 0 && t.effectLightActive !== 0 && i === t.lightEffectSlot) {
      if (paletteFadeStepsLeft() === 0) restore = true;
      else retire = false;
    }
    if (!retire) continue;
    if (restore) {
      const v = viewer();
      v.lightPos[0] = t.savedLight[0]!;
      v.lightPos[1] = t.savedLight[1]!;
      v.lightPos[2] = t.savedLight[2]!;
      v.lightDirectional = i16(t.savedLight[3]!);
      lighting.lightObjectFollow = 1;
      v.ambientLight = i16(t.savedLight[4]!);
      t.effectLightActive = 0;
      lighting.lightDimFlag = t.savedLight[5]!;
      s.ownsLight = 0;
      t.lightEffectSlot = -1;
    }
    if (s.node !== null) sceneSubtreeMoveToAltList(s.node);
    if (0 < s.bitmapSlot) {
      bitmap3dSetEnable(i16(s.bitmapSlot), 0);
      bitmap3dSetFrame(i16(s.bitmapSlot), 0);
    }
    s.z = 0;
    s.timeLeft = 0;
    s.active = 0;
    s.ownsLight = 0;
    s.y = s.z;
    s.x = s.z;
  }
}

/**
 * Area damage to mechs: every mech whose centre lies within its own radius
 * plus blastRadius of (x, y, z) takes rate * tickDelta on locations 2..8 and
 * a quarter of it on the head (1) - double against a mech already dead
 * (status 4). Mechs with loadout flags 0x100 are skipped; in a network game
 * only the player's own mech is damaged here.
 *
 * @mw2 mechs_blast_damage 0x000517c0
 * @fidelity exact
 */
export function mechsBlastDamage(x: number, y: number, z: number, blastRadius: number, rate: number): void {
  const m = mechs;
  let i = m.mechCount - 1;
  if (i === -1) return;
  do {
    if (net.netRole === 0 || i === m.playerMechIndex) {
      const e = m.mechTable[i]!;
      const l = e.loadout!;
      if (((l.flags >> 8) & 1) === 0) {
        if (octLength((e.posX - x) | 0, (e.posY - y) | 0, (e.posZ - z) | 0) < ((l.radius + blastRadius) | 0)) {
          let d = Math.imul(rate, clock.tickDelta);
          if (l.status === 4) d = Math.imul(d, 2);
          mechApplyDamage(l, d >> 2, 1);
          for (let loc = 2; loc <= 8; loc++) mechApplyDamage(l, d, loc);
        }
      }
    }
    i--;
  } while (i !== -1);
}

/**
 * Area damage to gamethings: each standing one whose object lies within its
 * radius plus `radius` of the point takes (rate * tickDelta) >> 16, rounded,
 * at the object's own position. (The original returns a register left over
 * from the loop; no caller reads it.)
 *
 * @mw2 gamethings_near_point 0x00051910
 * @fidelity exact
 */
export function gamethingsNearPoint(x: number, y: number, z: number, radius: number, damageRate: number): void {
  let i = things.gameThingCount - 1;
  if (i === -1) return;
  do {
    const g = things.gameThings[i]!;
    if ((g.flags & 4) === 0) {
      const obj = worldRecordObject(g.geomIndex);
      if (obj !== null) {
        const p = objectGetPosRadius(obj);
        if (octLength((p.x - x) | 0, (p.y - y) | 0, (p.z - z) | 0) < ((radius + p.radius) | 0)) {
          gamethingApplyDamage(obj, mulr16(damageRate, clock.tickDelta), p.x, p.y, p.z);
        }
      }
    }
    i--;
  } while (i !== -1);
}

/**
 * While the nuke's blast lasts, its front grows 200 a tick to its maximum
 * and damages mechs, gamethings and destructibles inside it at rate 0x1000.
 *
 * @mw2 nuke_blast_update 0x00051f50
 * @fidelity exact
 */
export function nukeBlastUpdate(): void {
  const t = simTables;
  if (0 < t.nukeBlastTicksLeft) {
    t.nukeBlastRadius = (t.nukeBlastRadius + Math.imul(clock.tickDelta, 200)) | 0;
    if (t.nukeBlastMaxRadius < t.nukeBlastRadius) t.nukeBlastRadius = t.nukeBlastMaxRadius;
    mechsBlastDamage(t.nukeBlastX, t.nukeBlastY, t.nukeBlastZ, t.nukeBlastRadius, 0x1000);
    gamethingsNearPoint(t.nukeBlastX, t.nukeBlastY, t.nukeBlastZ, t.nukeBlastRadius, 0x1000);
    destructiblesBlastDamage(t.nukeBlastX, t.nukeBlastY, t.nukeBlastZ, t.nukeBlastRadius, 0x1000);
    t.nukeBlastTicksLeft = (t.nukeBlastTicksLeft - clock.tickDelta) | 0;
  }
}

/**
 * Heat from fires: every object of type family 0x10 on the world list heats
 * each live mech within its doubled radius plus the mech's radius, by
 * ((2r - d * 2r / reach) >> 3) * tickDelta - most at the centre, none at the
 * edge. Only called with simOptions heatTracking on.
 *
 * @mw2 environment_heat_update 0x00051d40
 * @fidelity exact
 */
export function environmentHeatUpdate(): void {
  const root = objectLists.worldRoot;
  if (!root) return;
  let obj = root.listNext;
  if (!obj) return;
  do {
    if ((obj.type & 0xf0) === 0x10) {
      const p = objectGetPosRadius(obj);
      const r2 = Math.imul(p.radius, 2);
      let i = mechs.mechCount;
      while (--i !== -1) {
        if (!(net.netRole === 0 || i === mechs.playerMechIndex)) continue;
        const e = mechs.mechTable[i]!;
        if ((e.flags & 2) !== 0 || (e.flags & 4) !== 0) continue;
        const l = e.loadout!;
        const reach = (l.radius + r2) | 0;
        const d = octLength((e.posX - p.x) | 0, (e.posY - p.y) | 0, (e.posZ - p.z) | 0);
        if (d < reach) {
          const q = (Math.imul(d, r2) / reach) | 0;
          l.heatThisTick = (l.heatThisTick + Math.imul(((r2 - q) | 0) >> 3, clock.tickDelta)) | 0;
        }
      }
    }
    obj = obj.listNext;
  } while (obj);
}
