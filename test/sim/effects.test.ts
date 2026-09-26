// Phase 3, projectiles and effects: projectile_update's integration and hit
// resolution, projectile_home, effect_spawn and sim_slots_update, driven on a
// booted mission with rounds stocked the way mech_weapon_fire stocks them.
// Expected values are computed independently (BigInt, the effect table)
// rather than recorded from the port.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { readEffectTypes } from '../../src/data/exe/tables/effects.ts';
import { bootMission } from '../../src/mission/load.ts';
import { clock } from '../../src/engine/clock.ts';
import { objectsOnList, worldChain, worldRootNode } from '../../src/engine/scene/objectLists.ts';
import { sceneNodeGetWorldPos, sceneNodeSetOrigin, sceneNodeWalk } from '../../src/engine/scene/sceneGraph.ts';
import type { MechEntity, Projectile, SceneNode, WorldObject } from '../../src/generated/classes.gen.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { simTables } from '../../src/sim/effects/simTables.ts';
import { effectSpawnAt, simSlotsUpdate } from '../../src/sim/effects/effects.ts';
import { projectileHome, projectilesUpdateAll, projectileUpdate } from '../../src/sim/weapons/projectiles.ts';
import { worldGroundHeightNear } from '../../src/sim/world/collision.ts';
import { gamethingApplyDamage } from '../../src/sim/things/gameThingDamage.ts';
import { things } from '../../src/sim/things/gameThings.ts';
import { world, worldRecordObject } from '../../src/sim/world/worldRecords.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

const calls = vi.hoisted(() => ({ damage: [] as Array<[unknown, number, number]>, spawn: [] as number[][] }));

vi.mock('../../src/sim/mech/damage.ts', async (orig) => {
  const actual = await orig<typeof import('../../src/sim/mech/damage.ts')>();
  return {
    ...actual,
    mechApplyDamage: (l: never, points: number, location: number) => {
      calls.damage.push([l, points, location]);
      actual.mechApplyDamage(l, points, location);
    },
  };
});
vi.mock('../../src/sim/effects/effects.ts', async (orig) => {
  const actual = await orig<typeof import('../../src/sim/effects/effects.ts')>();
  return {
    ...actual,
    effectSpawn: (...a: Parameters<typeof actual.effectSpawn>) => {
      calls.spawn.push(a);
      actual.effectSpawn(...a);
    },
  };
});

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

const i32 = (b: bigint) => Number(BigInt.asIntN(32, b));
/** old + ((vel + (accel * dt >> 1)) * dt >> 16) and vel + accel * dt, in BigInt */
function expectStep(old: number, vel: number, accel: number, dt: number): [number, number] {
  const adt = i32(BigInt(accel) * BigInt(dt));
  const pos = i32(BigInt(old) + BigInt.asIntN(32, (BigInt(i32(BigInt(adt >> 1) + BigInt(vel))) * BigInt(dt)) >> 16n));
  return [pos, i32(BigInt(vel) + BigInt(adt))];
}

/** an idle projectiles[] slot the BTHG chunk stocked with a node */
function freeRound(): { slot: number; p: Projectile } {
  const slot = simTables.projectiles.findIndex((p) => p.node !== null && p.active === 0);
  expect(slot).toBeGreaterThanOrEqual(0);
  return { slot, p: simTables.projectiles[slot]! };
}

/** stock a round as mech_weapon_fire would, its node at (x, y, z) */
function launch(p: Projectile, at: [number, number, number], vel: [number, number, number], accel: [number, number, number] = [0, 0, 0]) {
  p.active = 1;
  p.motionHeld = 0;
  p.attackerMechIndex = mechs.playerMechIndex;
  p.damage = 5;
  p.heatOnHit = 0;
  p.timeLeft = 1000;
  p.age = 0;
  p.targetType = 0;
  p.targetIndex = 0;
  p.effectIndex = 0;
  p.impactFlags = 0;
  p.effectHigh = 0;
  [p.velX, p.velY, p.velZ] = vel;
  [p.accelX, p.accelY, p.accelZ] = accel;
  sceneNodeSetOrigin(p.node!, ...at);
  sceneNodeWalk(p.node!);
}

function subtreeObjects(n: SceneNode, out: WorldObject[] = []): WorldObject[] {
  if (n.userData) out.push(n.userData);
  for (let c = n.firstChild; c; c = c.nextSibling) subtreeObjects(c, out);
  return out;
}

/** a mech other than the player's, on the world chain */
function enemy(): MechEntity {
  const chain = new Set(worldChain());
  for (let i = 0; i < mechs.mechCount; i++) {
    const m = mechs.mechTable[i];
    if (!m || i === mechs.playerMechIndex || !m.node || !m.loadout) continue;
    if (subtreeObjects(m.node).some((o) => chain.has(o))) return m;
  }
  throw new Error('no enemy mech on the world chain');
}

/** aim point: the centre torso part's position (hitLocation 3), else the mech's origin + 5 m */
function torso(m: MechEntity): [number, number, number] {
  const o = subtreeObjects(m.node!).find((x) => x.hitLocation === 3);
  return o ? [o.posX, o.posY, o.posZ] : [m.posX, m.posY + 500, m.posZ];
}

describe.runIf(hasGameData)('projectiles and effects', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });
  beforeEach(() => {
    bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
    clock.tickDelta = 7;
    calls.damage.length = 0;
    calls.spawn.length = 0;
  });

  it('integrates pos += (vel + accel*dt/2) * dt >> 16 and stores vel + accel*dt', () => {
    const { slot, p } = freeRound();
    const pl = mechs.mechTable[mechs.playerMechIndex]!;
    const at: [number, number, number] = [pl.posX + 1234, pl.posY + 90000, pl.posZ - 777];
    launch(p, at, [0x1234567, 0x345678, -0x2468ace], [0x1111, -0x794, -0x3333]);
    const vel0 = [p.velX, p.velY, p.velZ];
    const acc = [p.accelX, p.accelY, p.accelZ];
    for (let k = 0; k < 3; k++) {
      const dt = [7, 5, 9][k]!;
      clock.tickDelta = dt;
      const before = sceneNodeGetWorldPos(p.node!);
      const vb = [p.velX, p.velY, p.velZ];
      projectileUpdate(slot);
      expect(p.active).toBe(1);
      const after = sceneNodeGetWorldPos(p.node!);
      for (let a = 0; a < 3; a++) {
        const [pos, v] = expectStep(before[a]!, vb[a]!, acc[a]!, dt);
        expect(after[a]).toBe(pos);
        expect([p.velX, p.velY, p.velZ][a]).toBe(v);
      }
    }
    expect(vel0).not.toEqual([p.velX, p.velY, p.velZ]);
  });

  it('a round whose timeLeft runs out vanishes with no effect', () => {
    const { p } = freeRound();
    const pl = mechs.mechTable[mechs.playerMechIndex]!;
    launch(p, [pl.posX, pl.posY + 90000, pl.posZ], [0x10000, 0, 0]);
    p.timeLeft = 8; // 8 - 7 = 1: still flying
    projectilesUpdateAll();
    expect(p.active).toBe(1);
    expect(p.age).toBe(7);
    projectilesUpdateAll(); // 1 - 7 < 1: gone
    expect(p.active).toBe(0);
    expect(p.effectIndex).toBe(0xff); // projectile_clear
    expect(calls.spawn).toHaveLength(0);
    expect([...objectsOnList(worldRootNode)]).not.toContain(p.node!.userData);
  });

  it('a hit on a mech from the front and from behind: damage << 16 at the part hit, 0x8000 only from behind', () => {
    const m = enemy();
    const target = torso(m);
    for (const fromBehind of [false, true]) {
      calls.damage.length = 0;
      calls.spawn.length = 0;
      const { slot, p } = freeRound();
      // travel direction: opposite the mech's heading from the front, along it from behind
      const h = ((m.heading / 0x1680000) * 2 * Math.PI) + (fromBehind ? 0 : Math.PI);
      const dir = [Math.sin(h), Math.cos(h)];
      const start: [number, number, number] = [Math.round(target[0] - dir[0]! * 2000), target[1], Math.round(target[2] - dir[1]! * 2000)];
      launch(p, start, [Math.round(dir[0]! * 600 * 65536), 0, Math.round(dir[1]! * 600 * 65536)]);
      p.damage = 5;
      projectileUpdate(slot);
      expect(p.active).toBe(0);
      expect(simTables.killCreditMech === -1 || simTables.killCreditMech === mechs.playerMechIndex).toBe(true);
      expect(calls.damage).toHaveLength(1);
      const [l, points, location] = calls.damage[0]!;
      expect(l).toBe(m.loadout);
      expect(points).toBe(5 << 16);
      expect(location & 0x7fff).toBeGreaterThanOrEqual(1);
      expect(location & 0x7fff).toBeLessThanOrEqual(8);
      expect(location & 0x8000).toBe(fromBehind ? 0x8000 : 0);
      // the round's effect: code 0 | (impactFlags 1 << 8), impact then the blast point 1 m back
      expect(calls.spawn[0]![0]).toBe(0x100);
      const [, ix, iy, iz, bx, by, bz] = calls.spawn[0]!;
      const back = Math.hypot(ix! - bx!, iy! - by!, iz! - bz!);
      expect(Math.abs(back - 100)).toBeLessThan(2);
    }
  });

  it('below y = 0 the heightfield stops a round the raycast missed (impact flag 4)', () => {
    const { slot, p } = freeRound();
    const pl = mechs.mechTable[mechs.playerMechIndex]!;
    // straight down onto open ground away from the mechs, in one step
    let x = pl.posX;
    let z = pl.posZ;
    let found = false;
    for (let k = 1; k < 40 && !found; k++) {
      x = pl.posX + k * 3000;
      z = pl.posZ + k * 1700;
      const g = worldGroundHeightNear(x, 0x7fff0000, z);
      if (g <= 0 && g > -2000) found = [...worldChain()].every((o) => Math.hypot(o.posX - x, o.posZ - z) > o.radius + 500);
    }
    expect(found).toBe(true);
    const g = worldGroundHeightNear(x, -1, z);
    launch(p, [x, g + 200, z], [0, -400 * 65536, 0]);
    projectileUpdate(slot);
    expect(p.active).toBe(0);
    expect(calls.spawn).toHaveLength(1);
    const [code, ix, iy, iz] = calls.spawn[0]!;
    expect(code).toBe(0x400);
    expect(ix).toBe(x);
    expect(iz).toBe(z);
    expect(Math.abs(iy! - worldGroundHeightNear(x, iy!, z))).toBeLessThanOrEqual(1);
  });

  it('homing: accel = unit(target - pos) - unit(vel); within 101 it arms a hit on the target root object at the old position', () => {
    const m = enemy();
    const { slot, p } = freeRound();
    const at: [number, number, number] = [m.posX + 3000, m.posY + 2000, m.posZ - 4000];
    launch(p, at, [-5 * 65536, 0, 6 * 65536]);
    p.targetType = 0x200;
    p.targetIndex = m.index;
    p.age = 7;
    projectileHome(p, ...at);
    const d = [m.posX - at[0], m.posY - at[1], m.posZ - at[2]].map((v) => Math.abs(v)).sort((a, b) => b - a);
    const oct = (4 * d[0]! + d[1]! + d[2]!) >> 2;
    const want = [m.posX - at[0], m.posY - at[1], m.posZ - at[2]].map((v) => i32((BigInt(v) << 16n) / BigInt(oct)));
    const vd = [5, 0, 6].map((v) => v * 65536).sort((a, b) => b - a);
    const voct = (4 * vd[0]! + vd[1]! + vd[2]!) >> 2;
    const cur = [-5 * 65536, 0, 6 * 65536].map((v) => i32((BigInt(v) << 16n) / BigInt(voct)));
    expect([p.accelX, p.accelY, p.accelZ]).toEqual([want[0]! - cur[0]!, want[1]! - cur[1]!, want[2]! - cur[2]!]);
    expect(p.active & 0x8000).toBe(0);
    // within 101 of the target's origin: the proximity bit
    projectileHome(p, m.posX + 50, m.posY, m.posZ);
    expect(p.active & 0x8000).toBe(0x8000);
    // the next step strikes the target's own object at the old position, no raycast
    sceneNodeSetOrigin(p.node!, m.posX + 50, m.posY, m.posZ);
    sceneNodeWalk(p.node!);
    projectileUpdate(slot);
    expect(p.active).toBe(0);
    // the object struck is scene_node_get_userdata(mech->node): the mech's ROOT object, which
    // in the missions is the GPS thing's type-0x70 pivot, not a 0x100 part - so no damage is
    // dealt and the round bursts as a scenery hit (impact flag 4)
    const root = m.node!.userData!;
    expect(root.type & 0xf0).toBe(0x70);
    expect(calls.damage).toHaveLength(0);
    expect(calls.spawn[0]![0]).toBe(0x400);
    expect(calls.spawn[0]!.slice(1, 7)).toEqual([m.posX + 50, m.posY, m.posZ, m.posX + 50, m.posY, m.posZ]);
    // a destroyed target drops the lock
    const r = freeRound();
    launch(r.p, at, [0x10000, 0, 0]);
    r.p.targetType = 0x200;
    r.p.targetIndex = m.index;
    r.p.accelX = 99;
    m.flags |= 2;
    projectileHome(r.p, ...at);
    expect([r.p.targetType, r.p.accelX, r.p.accelY, r.p.accelZ]).toEqual([0, 0, 0, 0]);
  });

  it('effect_spawn claims an idle slot of the row, on the world list but off the chain; sim_slots_update retires it after lifetime + tickDelta', () => {
    const table = readEffectTypes(exe);
    const row = 1; // MLASER impact: a node, no light, no area query
    expect(table[row]!.needsNode).toBe(1);
    expect(table[row]!.lightsScene).toBe(0);
    const pl = mechs.mechTable[mechs.playerMechIndex]!;
    const at: [number, number, number] = [pl.posX + 5000, pl.posY + 300, pl.posZ + 5000];
    const idle = simTables.simSlots.findIndex((s) => s.typeIndex === row && s.active === 0 && s.node !== null);
    expect(idle).toBeGreaterThanOrEqual(0);
    effectSpawnAt(row, ...at, ...at);
    const s = simTables.simSlots[idle]!;
    expect(s.active).toBe(1);
    expect([s.x, s.y, s.z]).toEqual(at);
    expect(s.timeLeft).toBe(table[row]!.lifetime + 7);
    const obj = s.node!.userData!;
    expect([...objectsOnList(worldRootNode)]).toContain(obj);
    expect([...worldChain()]).not.toContain(obj);
    expect(sceneNodeGetWorldPos(s.node!)).toEqual(at);
    let frames = 0;
    while (s.active !== 0 && frames < 1000) {
      simSlotsUpdate();
      frames++;
    }
    // retired on the frame timeLeft reaches 0 or below
    expect(frames).toBe(Math.ceil((table[row]!.lifetime + 7) / 7));
    expect([...objectsOnList(worldRootNode)]).not.toContain(obj);
    expect([s.x, s.y, s.z, s.timeLeft]).toEqual([0, 0, 0, 0]);
  });

  it('crowding: a second effect of a row within 500 of a live one is refused at lodQuality below full (not 1)', () => {
    const row = 1;
    const pl = mechs.mechTable[mechs.playerMechIndex]!;
    const at: [number, number, number] = [pl.posX + 5000, pl.posY + 300, pl.posZ + 5000];
    const live = () => simTables.simSlots.filter((s) => s.typeIndex === row && s.active !== 0).length;
    effectSpawnAt(row, ...at, ...at);
    effectSpawnAt(row, at[0] + 100, at[1], at[2], ...at);
    effectSpawnAt(row, at[0] + 200, at[1], at[2], ...at);
    effectSpawnAt(row, at[0] + 300, at[1], at[2], ...at);
    // lodQuality 1 (the image's) tolerates two live ones nearby: three in all
    expect(live()).toBe(3);
  });
  it('a gamething dies when its hit points reach 0 - explosion, fragments, DESTROYED record - and one with 0 hit points never does', () => {
    const idx = things.gameThings.findIndex((g, i) => i < things.gameThingCount && g.hitPoints > 0 && (g.flags & 4) === 0 && worldRecordObject(g.geomIndex) !== null);
    expect(idx).toBeGreaterThanOrEqual(0);
    const g = things.gameThings[idx]!;
    const rec = g.geomIndex;
    const obj = worldRecordObject(rec)!;
    const family = obj.type & 0xf0;
    const hp = g.hitPoints;
    gamethingApplyDamage(obj, hp - 1, 1, 2, 3);
    expect(g.hitPoints).toBe(1);
    expect(calls.spawn).toHaveLength(0);
    simTables.killCreditMech = mechs.playerMechIndex;
    gamethingApplyDamage(obj, 5, 1, 2, 3);
    expect(g.hitPoints).toBe(0);
    expect(g.flags & 4).toBe(4); // world_record_replace marks the thing
    expect(world.worldRecords[rec]!.flags & 0x200).toBe(0x200);
    expect(simTables.killCreditMech).toBe(-1);
    // explosion 0xd (family 0xb0) or 3 at the point given, then 0x10b and 0x20b throw fragments
    // (row 0xb). (gameThingDamage's calls bypass the effects mock: effects.ts and it import each other.)
    const boom = family === 0xb0 ? 0xd : 3;
    if (simTables.simSlots.some((s) => s.typeIndex === boom && s.node !== null)) {
      expect(simTables.simSlots.some((s) => s.typeIndex === boom && s.active !== 0 && s.x === 1 && s.y === 2 && s.z === 3)).toBe(true);
    }
    expect(simTables.simSlots.filter((s) => s.typeIndex === 0xb && s.active !== 0).length).toBe(Math.min(8, simTables.simSlots.filter((s) => s.typeIndex === 0xb && s.node !== null).length));
    // indestructible: 0 hit points
    const zero = things.gameThings.findIndex((t, i) => i < things.gameThingCount && t.hitPoints === 0 && (t.flags & 4) === 0 && worldRecordObject(t.geomIndex) !== null);
    if (zero >= 0) {
      const t = things.gameThings[zero]!;
      gamethingApplyDamage(worldRecordObject(t.geomIndex), 1000, 0, 0, 0);
      expect(t.hitPoints).toBe(0);
      expect(t.flags & 4).toBe(0);
    }
  });
});
