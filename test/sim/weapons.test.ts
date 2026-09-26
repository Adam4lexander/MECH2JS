// Phase 3's "weapon stats match weapons.txt": the player's real loadout on a
// real mission, each weapon pulled once, with mech_weapons_tick driven tick by
// tick (tickDelta 7, 26 fps) so every number is checked against the
// weaponTypes row it comes from - shotGap to the first round, shots per
// burst, heat per round, ammo, reload, and the launched round's damage,
// heatOnHit, aged flight time and velocity. Then the same through main's
// loop with the Space key, and the missile lock's clock.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { octLength, vec3Normalise } from '../../src/engine/collision/ray.ts';
import { clock } from '../../src/engine/clock.ts';
import { timerInterrupt } from '../../src/engine/timer.ts';
import { mulr16 } from '../../src/core/int/fx16.ts';
import type { MechEntity, MechLoadout, MechWeapon, Projectile } from '../../src/generated/classes.gen.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { simTables } from '../../src/sim/effects/simTables.ts';
import { weaponTypes } from '../../src/sim/mech/config.ts';
import { loadoutWeapons } from '../../src/sim/mech/loadout.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { planet } from '../../src/sim/world/planet.ts';
import { mechShotDirection, mechUpdateMissileLock, mechWeaponsTick, weaponGlobals } from '../../src/sim/weapons/weapons.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

const DT = 7;
const player = (): MechEntity => mechs.mechTable[mechs.playerMechIndex]!;

function boot(mission = 'AMY_SCN1'): KeyboardDriver {
  bootMission({ exe, prj, looseFiles: files, mission });
  const l = player().loadout!;
  for (let f = 0; f < 400 && l.status !== 2; f++) frame();
  expect(l.status).toBe(2);
  return input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
}

function frame(ticks = DT) {
  for (let i = 0; i < ticks; i++) timerInterrupt();
  mainLoopFrame();
}

/** one weapons tick on its own: simTick advances by DT, heatThisTick starts at 0 */
function tick(l: MechLoadout): { heat: number; launched: Projectile[] } {
  const before = new Set(simTables.projectiles.filter((p) => p.active !== 0));
  clock.tickDelta = DT;
  clock.simTick = (clock.simTick + DT) | 0;
  l.heatThisTick = 0;
  mechWeaponsTick(l);
  return { heat: l.heatThisTick, launched: simTables.projectiles.filter((p) => p.active !== 0 && !before.has(p)) };
}

function idle(l: MechLoadout) {
  const c = l.entity!.control!;
  c.weapon_fire = c.weapon_fire_group = c.weapon_fire_group_1 = c.weapon_fire_group_2 = c.weapon_fire_group_3 = c.toggle_group_fire = 0;
  l.flags &= ~1;
  for (const p of simTables.projectiles) p.active = 0; // the harness does not fly rounds: give the pool back
}

/** the velocity mech_weapon_fire gives: projectileSpeed times the normalised shot direction */
function expectedVelocity(e: MechEntity, speed: number): number[] {
  const d = mechShotDirection(e);
  vec3Normalise(d);
  return d.map((c) => Math.imul(speed, c));
}

describe.runIf(hasGameData)('weapons', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('each weapon of the player\'s chassis fires as its weaponTypes row says', () => {
    boot();
    const e = player();
    const l = e.loadout!;
    const weapons = loadoutWeapons(l);
    const armed = weapons.filter((w) => w.type >= 0);
    expect(armed.length).toBe(l.numWeapons);
    for (let i = 0; i < 10; i++) {
      const w = weapons[i]!;
      if (w.type < 0) continue;
      const wt = weaponTypes()[w.type]!;
      idle(l);
      expect(w.fireState).toBe(1);
      l.selectedWeapon = i;
      const ammo0 = w.ammo;
      const binRounds0 = w.bin?.rounds ?? 0;

      // the pull: armed this tick, no round yet unless shotGap fits in one tick
      l.entity!.control!.weapon_fire = 1;
      const pullTick = (clock.simTick + DT) | 0;
      let r = tick(l);
      expect(w.fireState).toBe(2);
      l.entity!.control!.weapon_fire = 0;

      let rounds = r.launched.length;
      let firstRoundTick = rounds > 0 ? pullTick : -1;
      let cooldownStart = -1;
      for (let n = 0; n < 2000 && w.fireState !== 1; n++) {
        const clockBefore = w.stateTick;
        r = tick(l);
        const fired = r.launched.length;
        if (fired > 0 && firstRoundTick < 0) firstRoundTick = clock.simTick;
        // heat is per ROUND
        expect(r.heat).toBe(Math.imul(fired, wt.heat));
        for (const p of r.launched) {
          expect(p.id).toBe(wt.projectileKind);
          expect(p.damage).toBe(wt.damage);
          expect(p.heatOnHit).toBe(wt.heatOnHit);
          expect(p.attackerMechIndex).toBe(e.index);
          expect(p.effectIndex).toBe(wt.impactEffect & 0xff);
          // THE AGED LAUNCH: age is the burst clock before this tick, timeLeft the rest of flightTime
          expect(p.age).toBe(clockBefore);
          expect(p.timeLeft).toBe(wt.flightTime - clockBefore);
          expect([p.velX, p.velY, p.velZ]).toEqual(expectedVelocity(e, wt.projectileSpeed));
          expect([p.accelX, p.accelY, p.accelZ]).toEqual([0, mulr16(-planet.gravity | 0, wt.gravityScale << 16), 0]);
          // vec3_normalise makes the direction unit in its own octagonal metric, so the speed is exact there
          const speed = octLength(p.velX >> 8, p.velY >> 8, p.velZ >> 8) / 256;
          expect(Math.abs(speed / wt.projectileSpeed - 1)).toBeLessThan(0.01);
        }
        rounds += fired;
        if (w.fireState === 0 && cooldownStart < 0) cooldownStart = w.stateTick;
      }
      // the first round comes on the first tick whose burst clock (tickDelta per tick, from the pull's own) reaches shotGap
      expect(firstRoundTick - pullTick).toBe(DT * (Math.ceil(wt.shotGap / DT) - 1));
      expect(rounds).toBe(wt.shots);
      if (wt.ammoPerTon !== -1) {
        expect(w.ammo).toBe(ammo0 - wt.shots);
        expect(w.bin!.rounds).toBe(binRounds0 - wt.shots);
      } else {
        expect(w.ammo).toBe(-1);
      }
      // ready again on the first tick reload ticks after the cooldown began
      expect(cooldownStart).toBeGreaterThan(0);
      expect(clock.simTick - cooldownStart).toBeGreaterThanOrEqual(wt.reload);
      expect(clock.simTick - cooldownStart).toBeLessThan(wt.reload + DT);
    }
  });

  it('the round that empties the ammo flies but costs no heat, and the weapon stays at -1', () => {
    boot();
    const l = player().loadout!;
    const weapons = loadoutWeapons(l);
    const i = weapons.findIndex((w) => w.type >= 0 && w.ammo > 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const w: MechWeapon = weapons[i]!;
    const wt = weaponTypes()[w.type]!;
    idle(l);
    l.selectedWeapon = i;
    w.ammo = 1;
    w.bin!.rounds = 1;
    l.entity!.control!.weapon_fire = 1;
    tick(l);
    l.entity!.control!.weapon_fire = 0;
    let last = { heat: 0, launched: [] as Projectile[] };
    for (let n = 0; n < 100 && last.launched.length === 0; n++) last = tick(l);
    expect(last.launched.length).toBe(1);
    expect(last.heat).toBe(0);
    expect(w.ammo).toBe(0);
    expect(w.fireState).toBe(-1);
    expect(w.shotsLeft).toBe(0);
    for (let n = 0; n < Math.ceil(wt.reload / DT) + 5; n++) tick(l);
    expect(w.fireState).toBe(-1);
  });

  it('a held auto-repeat weapon fires a burst every shotGap + reload ticks, give or take a frame', () => {
    boot();
    const l = player().loadout!;
    const weapons = loadoutWeapons(l);
    const i = weapons.findIndex((w) => w.type >= 0 && weaponTypes()[w.type]!.autoRepeat !== 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const w = weapons[i]!;
    const wt = weaponTypes()[w.type]!;
    idle(l);
    l.selectedWeapon = i;
    l.entity!.control!.weapon_fire = 1;
    const starts: number[] = [];
    let prevState = w.fireState;
    for (let n = 0; n < 400; n++) {
      tick(l);
      if (w.fireState === 3 && prevState !== 3) starts.push(clock.simTick);
      prevState = w.fireState;
      for (const p of simTables.projectiles) p.active = 0;
    }
    expect(starts.length).toBeGreaterThan(3);
    for (let k = 1; k < starts.length; k++) {
      const gap = starts[k]! - starts[k - 1]!;
      expect(gap).toBeGreaterThanOrEqual(wt.shotGap * (wt.shots - 1) + wt.reload);
      expect(gap).toBeLessThanOrEqual(wt.shotGap * wt.shots + wt.reload + 2 * DT);
    }
  });

  it('Space fires the selected weapon through main\'s loop, and toggle_group_fire flips chain fire', () => {
    const kb = boot();
    const e = player();
    const l = e.loadout!;
    const w = loadoutWeapons(l)[l.selectedWeapon]!;
    expect(weaponGlobals.chainFireMode).toBe(1);
    const seen = new Set<Projectile>();
    kb.isr(0x39); // Space: weapon_fire
    for (let f = 0; f < 3; f++) frame();
    kb.isr(0xb9);
    for (let f = 0; f < 30; f++) {
      frame();
      for (const p of simTables.projectiles) if (p.active !== 0 && p.attackerMechIndex === e.index) seen.add(p);
    }
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen].every((p) => p.id === weaponTypes()[w.type]!.projectileKind)).toBe(true);
    kb.isr(0x2b); // '\': TOGGLE_GROUP_FIRE
    kb.isr(0xab);
    frame();
    frame();
    expect(weaponGlobals.chainFireMode).toBe(0);
  });

  it('the missile lock runs its 0x16c-tick clock in the cone and loses it out of range', () => {
    boot();
    const e = player();
    const l = e.loadout!;
    const weapons = loadoutWeapons(l);
    const i = weapons.findIndex((w) => w.type >= 0 && weaponTypes()[w.type]!.guided !== 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const wt = weaponTypes()[weapons[i]!.type]!;
    l.selectedWeapon = i;
    const enemy = mechs.mechTable.findIndex((m, k) => m !== null && k !== mechs.playerMechIndex);
    e.targetHandle = 0x200 | enemy;
    const range = (wt.minRange + wt.maxRange) >> 1;
    e.targetX = e.posX;
    e.targetY = e.posY;
    e.targetZ = (e.posZ + range) | 0;
    e.desiredHeading = ((e.heading % 0x1680000) + 0x1680000) % 0x1680000;
    e.aimAngle = 0;
    e.torsoTilt = -l.ramps[1]!.current | 0;
    l.flags &= ~0x80c0 & 0xffff;
    clock.tickDelta = DT;
    mechUpdateMissileLock(l);
    expect(l.flags & 0x80c0).toBe(0x8040);
    expect(l.stateTimer).toBe(0x16c);
    let calls = 1;
    while ((l.flags & 0x80) === 0 && calls < 200) {
      mechUpdateMissileLock(l);
      calls++;
    }
    // 0x16c counted down by tickDelta to <= 0, then one more call sets LOCKED
    expect(calls).toBe(1 + Math.ceil(0x16c / DT) + 1);
    mechUpdateMissileLock(l);
    expect(l.flags & 0x80c0).toBe(0x80c0);
    // out of range: the cone bit and LOCKED go at once, the clock counts back up
    e.targetZ = (e.posZ + wt.maxRange + 1000) | 0;
    mechUpdateMissileLock(l);
    expect(l.flags & 0x80c0).toBe(0x40);
    let up = 1;
    while ((l.flags & 0x40) !== 0 && up < 200) {
      mechUpdateMissileLock(l);
      up++;
    }
    expect(up).toBe(Math.ceil(0x16c / DT));
  });
});
