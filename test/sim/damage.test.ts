// Phase 3 damage and destruction, driven directly on a booted mission's
// mechs. Where the original rolls random_range, the test fills the range
// table with one value so the roll is known (random_range(n) = value % n),
// and restores it afterwards.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { randomRangeTable } from '../../src/core/random.ts';
import { bootMission } from '../../src/mission/load.ts';
import { clock } from '../../src/engine/clock.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { mechRuntime } from '../../src/sim/mech/mechRuntime.ts';
import { loadoutAmmo, loadoutSections, loadoutWeapons } from '../../src/sim/mech/loadout.ts';
import { mechAllegiance } from '../../src/sim/groups/groups.ts';
import { lighting } from '../../src/sim/world/environment.ts';
import { simTables } from '../../src/sim/effects/simTables.ts';
import {
  collisionDamageApply,
  mechApplyDamage,
  mechDamageSlot,
  mechDestroySection,
  mechEject,
  missionEndCode,
} from '../../src/sim/mech/damage.ts';
import { destructibleApplyDamage, destructibleGlobals, destructiblesUpdate } from '../../src/sim/things/destructibles.ts';
import { falling } from '../../src/sim/things/fallingObjects.ts';
import { collision } from '../../src/sim/world/collisionGlobals.ts';
import type { MechEntity, MechLoadout, MechSection } from '../../src/generated/classes.gen.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;
let savedTable: Int32Array;

const boot = () => bootMission({ exe, prj, looseFiles: files, mission: 'AMY_SCN1' });
const rollAlways = (v: number) => randomRangeTable.fill(v);

function enemy(): MechEntity {
  for (let i = 0; i < mechs.mechCount; i++) {
    const e = mechs.mechTable[i]!;
    if (i !== mechs.playerMechIndex && e.loadout && e.gamepieceClass === 1 && mechAllegiance(i) === 1) return e;
  }
  throw new Error('no enemy mech in AMY_SCN1');
}

const sec = (l: MechLoadout, loc: number): MechSection => loadoutSections(l)[loc - 1]!;
const hi = (s: MechSection) => (s.flags >> 8) & 0xff;
const snapshot = (l: MechLoadout) => loadoutSections(l).map((s) => [s.armorFront, s.armorRear, s.internal]);

describe.runIf(hasGameData)('damage', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });
  beforeEach(() => {
    boot();
    savedTable = randomRangeTable.slice();
    simTables.killCreditMech = -1;
  });
  afterEach(() => {
    randomRangeTable.set(savedTable);
  });

  it('armour takes the damage first, then the overflow goes to internal structure', () => {
    rollAlways(0); // random_range(5) = 0: no critical rolls
    const l = enemy().loadout!;
    const s = sec(l, 7);
    const a0 = s.armorFront;
    const i0 = s.internal;
    expect(a0).toBeGreaterThan(0x10000);
    mechApplyDamage(l, 0x10000, 7);
    expect(s.armorFront).toBe(a0 - 0x10000);
    expect(s.internal).toBe(i0);
    expect(hi(s) & 0x80).toBe(0x80); // hit
    expect(hi(s) & 0x40).toBe(0); // not breached
    mechApplyDamage(l, a0, 7); // 0x10000 more than is left
    expect(s.armorFront).toBe(0);
    expect(hi(s) & 0x40).toBe(0x40); // breached
    expect(s.internal).toBe(i0 - 0x10000);
  });

  it('the centre torso re-roll: 0 moves the hit to the right torso, 1 keeps it, the left torso is never reached', () => {
    const l = enemy().loadout!;
    rollAlways(0);
    let before = snapshot(l);
    mechApplyDamage(l, 0x100, 3);
    let after = snapshot(l);
    expect(after[1]![0]).toBe(before[1]![0]! - 0x100);
    expect(after[2]).toEqual(before[2]);
    rollAlways(1);
    before = snapshot(l);
    mechApplyDamage(l, 0x100, 3);
    after = snapshot(l);
    expect(after[2]![0]).toBe(before[2]![0]! - 0x100);
    expect(after[1]).toEqual(before[1]);
    // with the game's own table, a run of centre-torso hits never lands on 4
    randomRangeTable.set(savedTable);
    before = snapshot(l);
    for (let i = 0; i < 300; i++) mechApplyDamage(l, 1, 3);
    expect(snapshot(l)[3]).toEqual(before[3]);
  });

  it('bit 0x8000 takes rear armour on the torsos only', () => {
    rollAlways(1);
    const l = enemy().loadout!;
    for (const loc of [2, 3, 4]) {
      const s = sec(l, loc);
      const f = s.armorFront;
      const r = s.armorRear;
      mechApplyDamage(l, 0x100, loc | 0x8000);
      expect([s.armorFront, s.armorRear]).toEqual([f, r - 0x100]);
    }
    for (const loc of [1, 5, 6, 7, 8]) {
      const s = sec(l, loc);
      const f = s.armorFront;
      const r = s.armorRear;
      mechApplyDamage(l, 0x100, loc | 0x8000);
      expect([s.armorFront, s.armorRear]).toEqual([f - 0x100, r]);
    }
  });

  it('a side torso takes its arm with it, detaches the arm and keeps no destroyed bit itself', () => {
    const e = enemy();
    const l = e.loadout!;
    const active0 = destructibleGlobals.destructibles.filter((d) => d.active).length;
    mechDestroySection(l, 2);
    expect(hi(sec(l, 2)) & 0x20).toBe(0);
    expect(hi(sec(l, 5)) & 0x20).toBe(0x20);
    expect(sec(l, 5).numSlots).toBe(0);
    expect(sec(l, 5).internal).toBe(0);
    expect(l.status).not.toBe(4);
    expect(e.flags & 6).toBe(0);
    // the arm's geometry became debris
    expect(destructibleGlobals.destructibles.filter((d) => d.active).length).toBeGreaterThan(active0);
  });

  it('the first leg stops the mech; the second destroys it', () => {
    const e = enemy();
    const l = e.loadout!;
    mechDestroySection(l, 7);
    expect(l.throttleScale).toBe(0);
    expect(l.flags & 0x20).toBe(0x20);
    expect(l.status).not.toBe(4);
    mechDestroySection(l, 8);
    expect(l.status).toBe(4);
    expect(e.flags & 6).toBe(6);
    expect(hi(sec(l, 1)) & 0x20).toBe(0x20);
    expect(hi(sec(l, 3)) & 0x20).toBe(0x20);
  });

  it('losing the head or the centre torso kills; the centre torso takes every upper section', () => {
    let e = enemy();
    mechDestroySection(e.loadout!, 1);
    expect(e.loadout!.status).toBe(4);
    expect(e.flags & 6).toBe(6);
    boot();
    e = enemy();
    const l = e.loadout!;
    mechDestroySection(l, 3);
    expect(l.status).toBe(4);
    for (const loc of [1, 3, 5, 6]) expect(hi(sec(l, loc)) & 0x20).toBe(0x20);
    for (const loc of [2, 4]) expect(hi(sec(l, loc)) & 0x20).toBe(0); // they clear their own bit
    for (const loc of [7, 8]) expect(hi(sec(l, loc)) & 0x20).toBe(0);
  });

  it('internal structure below 1 destroys the section through mech_apply_damage', () => {
    rollAlways(0);
    const e = enemy();
    const l = e.loadout!;
    const s = sec(l, 1);
    mechApplyDamage(l, s.armorFront + s.internal, 1);
    expect(hi(s) & 0x20).toBe(0x20);
    expect(l.status).toBe(4);
  });

  it('mech_damage_slot removes the slot and moves the rest down', () => {
    const l = enemy().loadout!;
    const loc = loadoutSections(l).findIndex((s) => s.numSlots >= 3) + 1;
    expect(loc).toBeGreaterThan(0);
    const s = sec(l, loc);
    const n = s.numSlots;
    const rest = Array.from(s.slots.slice(2, n));
    const code = s.slots[1]!;
    // make slot 1 an item with no side effects: a code that rounds to nothing handled
    s.slots[1] = 5020;
    mechDamageSlot(l, loc, 1, 1);
    expect(s.numSlots).toBe(n - 1);
    expect(Array.from(s.slots.slice(1, n - 1))).toEqual(rest);
    expect(s.slots[n - 1]).toBe(0);
    void code;
  });

  it('a destroyed weapon slot stops that weapon for good', () => {
    const l = enemy().loadout!;
    const w = loadoutWeapons(l).find((x) => x.type >= 0)!;
    const loc = loadoutSections(l).findIndex((s) => Array.from(s.slots.slice(0, s.numSlots)).includes(w.slotCode)) + 1;
    expect(loc).toBeGreaterThan(0);
    const idx = Array.from(sec(l, loc).slots).indexOf(w.slotCode);
    mechDamageSlot(l, loc, idx, 0);
    expect(w.fireState).toBe(-1);
    expect(w.slotState).toBe(0);
  });

  it('an ammo bin cooks off: rounds leave the weapon, the section takes rounds * damagePerRound, an AI mech dies', () => {
    const e = enemy();
    const l = e.loadout!;
    const bins = loadoutAmmo(l).slice(0, l.numAmmo);
    const bin = bins.find((b) => b.rounds > 0 && ((b.slotCode & 0xffff) / 100 | 0) > 100);
    expect(bin).toBeDefined();
    const b = bin!;
    const w = loadoutWeapons(l)[b.weaponIndex]!;
    const loc = loadoutSections(l).findIndex((s) => Array.from(s.slots.slice(0, s.numSlots)).includes(b.slotCode & 0xffff)) + 1;
    const s = sec(l, loc);
    s.internal = 0x7fffffff >> 1; // survives the explosion so only the status path acts
    const internal0 = s.internal;
    const ammo0 = w.ammo;
    const rounds = b.rounds;
    mechDamageSlot(l, loc, Array.from(s.slots).indexOf(b.slotCode & 0xffff), 0);
    expect(w.ammo).toBe(ammo0 - rounds);
    expect(b.rounds).toBe(0);
    expect(s.internal).toBe(internal0 - rounds * b.damagePerRound * 0x10000);
    // status 5 then mech_on_destroyed, which makes an AI mech 4
    expect(l.status).toBe(4);
    expect(e.flags & 6).toBe(6);
  });

  it('LRM20 ammo (code / 100 == 100) is only removed, never cooks off', () => {
    const e = enemy();
    const l = e.loadout!;
    const b = loadoutAmmo(l)[0]!;
    b.slotCode = 10001;
    b.rounds = 12;
    const w = loadoutWeapons(l)[b.weaponIndex]!;
    const ammo0 = w.ammo;
    const s = sec(l, 3);
    s.slots[0] = 10001;
    const n = s.numSlots;
    mechDamageSlot(l, 3, 0, 0);
    expect(b.rounds).toBe(12);
    expect(w.ammo).toBe(ammo0);
    expect(s.numSlots).toBe(n - 1);
    expect(l.status).not.toBe(4);
  });

  it('leg and hip actuators cost 0x199a of throttleScale each, floored at 0x6666; the gyro also ends jumping', () => {
    const l = enemy().loadout!;
    const s = sec(l, 7);
    const t0 = l.throttleScale;
    expect(t0).toBe(0x10000);
    for (const code of [5500, 5550, 5600, 5650]) {
      s.slots[0] = code + 1;
      s.numSlots = Math.max(s.numSlots, 1);
      mechDamageSlot(l, 7, 0, 1);
    }
    expect(l.throttleScale).toBe(0x10000 - 4 * 0x199a);
    s.slots[0] = 5801;
    s.numSlots = Math.max(s.numSlots, 1);
    mechDamageSlot(l, 7, 0, 1);
    expect(l.throttleScale).toBe(0x10000 - 5 * 0x199a);
    expect(l.jumpFuel).toBe(-2);
    expect(l.jumpCapacity).toBe(0);
    expect(l.jetDeltaY).toBe(0);
    s.slots[0] = 5851; // the engine: 0x7ffe - 0x199a = 0x6664, floored
    s.numSlots = Math.max(s.numSlots, 1);
    mechDamageSlot(l, 7, 0, 1);
    expect(l.throttleScale).toBe(0x6666);
  });

  it('Endo Steel / Ferro-Fibrous passes a loud hit on to another slot and survives', () => {
    rollAlways(0); // random_range(numSlots) = 0
    const l = enemy().loadout!;
    const s = sec(l, 3);
    s.slots[0] = 5020; // harmless
    s.slots[1] = 8001;
    s.numSlots = Math.max(s.numSlots, 2);
    const n = s.numSlots;
    mechDamageSlot(l, 3, 1, 0);
    expect(s.numSlots).toBe(n - 1);
    expect(s.slots[0]).toBe(8001);
  });

  it('collision damage lands by the contact normal', () => {
    rollAlways(1);
    const e = enemy();
    const l = e.loadout!;
    const run = (nx: number, ny: number, nz: number) => {
      collision.rayHitNormalX = nx;
      collision.rayHitNormalY = ny;
      collision.rayHitNormalZ = nz;
      const before = snapshot(l);
      collisionDamageApply(l, null, 0x100);
      const after = snapshot(l);
      return before.map((b, i) => (b[0] !== after[i]![0] ? i + 1 : 0)).filter((x) => x);
    };
    e.heading = 0;
    e.aimAngle = 0;
    expect(run(0, -0x10000, 0)).toEqual([1]); // from above: head
    expect(run(0, 0x10000, 0)).toEqual([7, 8]); // from below: both legs
    // from the side: the contact bearing is atan2(-nx, -nz); +90 degrees is the right arm
    expect(run(-0x10000, 0, 0)).toEqual([5]);
    expect(run(0x10000, 0, 0)).toEqual([6]);
    expect(run(0, 0, -0x10000)).toEqual([4]); // straight ahead: bearing 0 is the left side's <= 0
  });

  it('eject: status 5 for the player with ejection allowed, and mech_on_destroyed records the outcome', () => {
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    const l = p.loadout!;
    l.status = 2;
    lighting.ejectDisabled = 0;
    mechEject(l, 1);
    expect(l.status).toBe(5);
    expect(missionEndCode()).toBe(2);
    expect(p.flags & 6).toBe(6);
  });

  it('an arm blown off falls as debris, settles, and is retired after 0xe38 ticks; or can be shot apart', () => {
    const e = enemy();
    mechDestroySection(e.loadout!, 5);
    const live = () => destructibleGlobals.destructibles.map((s, i) => (s.active ? i : -1)).filter((i) => i >= 0);
    const slots = live();
    expect(slots.length).toBeGreaterThan(0);
    const falls = () => falling.fallingObjects.filter((f) => f.node).length;
    expect(falls()).toBeGreaterThan(0);
    clock.tickDelta = 7;
    const start = clock.simTick;
    // debris lands and comes to rest well inside 20 s
    for (let t = 0; t < 0xe38 - 7 * 4; t += 7) {
      clock.simTick += 7;
      destructiblesUpdate();
    }
    expect(falls()).toBe(0);
    expect(live()).toEqual(slots);
    mechRuntime.playerOut = 0;
    while (clock.simTick - start <= 0xe38 + 7) {
      clock.simTick += 7;
      destructiblesUpdate();
    }
    expect(live()).toEqual([]);

    boot();
    const e2 = enemy();
    mechDestroySection(e2.loadout!, 5);
    const s0 = live()[0]!;
    const d = () => destructibleGlobals.destructibles[s0]!;
    const node = d().node!;
    destructibleApplyDamage(s0, 0x100000); // exactly 16 points: 0, not yet negative
    expect(d().active).toBe(1);
    destructibleApplyDamage(s0, 1);
    expect(d().active).toBe(0);
    expect(d().node).toBeNull();
    expect(falling.fallingObjects.some((f) => f.node === node)).toBe(false);
  });
});
