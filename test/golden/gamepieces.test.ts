// The gamepiece cluster against MW2.EXE and MW2.PRJ:
//  - difficulty armour scales, heat dissipation by climate, loose MEK files;
//  - one gamepiece of each class spawned and run through its create hook;
//  - groups, formations, stars and paths from the real STAR/FTBL/PTBL chunks.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MechEntity } from '../../src/generated/classes.gen.ts';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { readWeaponTypes } from '../../src/data/exe/tables/weaponTypes.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { parseMek } from '../../src/data/formats/mek.ts';
import { mechCatalog } from '../../src/data/catalog/mechs.ts';
import { parseMgeo } from '../../src/data/formats/mgeo.ts';
import { decodeFtbl } from '../../src/data/bwd/payloads/ftbl.ts';
import { decodePtbl } from '../../src/data/bwd/payloads/ptbl.ts';
import { decodeStar } from '../../src/data/bwd/payloads/star.ts';
import type { Chunk } from '../../src/data/bwd/stream.ts';
import { resetAllGlobals } from '../../src/engine/globals.ts';
import { setBootImage } from '../../src/engine/image.ts';
import { setLogSink } from '../../src/core/log.ts';
import { setMainProject } from '../../src/engine/resources/cache.ts';
import { sceneNodeCreate, sceneNodeSetOrigin, sceneNodeWalk } from '../../src/engine/scene/sceneGraph.ts';
import { polyResolveCode, wtboGlobals } from '../../src/engine/scene/wtboLoader.ts';
import { gamepieceClasses } from '../../src/sim/mech/classes.ts';
import { mechLoadConfig, resLoadMgeo, setMechConfigLog } from '../../src/sim/mech/config.ts';
import { mechDispatchHook0 } from '../../src/sim/mech/hooks.ts';
import { loadoutArrays } from '../../src/sim/mech/loadout.ts';
import { setMekSource } from '../../src/sim/mech/looseFiles.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { mechSpawn, thingNodeQueuePop, thingNodes } from '../../src/sim/mech/spawn.ts';
import { formationTableLoad, formations, groupSetFormationByName, starTableLoad } from '../../src/sim/groups/formations.ts';
import { groupReset, groupSetLeader, mechSetStarSlot, starAssignSlots } from '../../src/sim/groups/groups.ts';
import { pathTableLoad, paths } from '../../src/sim/groups/paths.ts';
import { detail } from '../../src/sim/world/detailRecords.ts';
import { lighting } from '../../src/sim/world/environment.ts';
import { planet } from '../../src/sim/world/planet.ts';
import { things } from '../../src/sim/things/gameThings.ts';
import { gameSource, hasGameData, MW2_ROOT } from '../support/env.ts';
import { namedStreams } from '../support/bwdHelpers.ts';
import { NodeFsSource } from '../../tools/nodeSource.ts';

describe.runIf(hasGameData)('gamepieces', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  let streams: ReturnType<typeof namedStreams>;

  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    streams = namedStreams(prj);
    setLogSink(() => {}); // res_load_file's symlog lines for every record without a loose file
  });

  beforeEach(() => {
    setBootImage(exe);
    resetAllGlobals();
    setMainProject(prj);
    setMekSource(new NodeFsSource(MW2_ROOT));
    setMechConfigLog(null);
  });

  /** Spawns mechTable[index] of a class row the way the GP chunk does, on a fresh node. */
  function spawn(index: number, row: number, group = 1): MechEntity {
    const cls = gamepieceClasses()[row]!;
    mechSpawn(index, cls.createLoadout);
    const e = mechs.mechTable[index]!;
    e.gamepieceClass = cls.classId;
    for (const k of [0, 1, 2, 5]) e.hooks[k] = cls.hooks[k] ?? null;
    if (index === mechs.playerMechIndex) {
      e.hooks[3] = cls.hooks[3] ?? null;
      e.hooks[4] = cls.hooks[4] ?? null;
    }
    e.index = index;
    e.node = sceneNodeCreate(null, 4);
    e.aimNode = e.node;
    e.groupId = group;
    if (mechs.mechCount <= index) mechs.mechCount = index + 1;
    return e;
  }

  it('scales armour by difficulty and side', () => {
    // BHM00STD: loc3 CT armour 46 front 15 rear (listing/chassis.txt)
    const id = 2;
    expect(prj.resourceName('MEK', id)).toBe('BHM00STD');
    // enemy 1/3/4, friendly 3/3/4, player 4 at every difficulty
    const want = { player: [4, 4, 4], enemy: [1, 3, 4], friendly: [3, 3, 4] };
    for (let d = 0; d < 3; d++) {
      for (const role of ['player', 'enemy', 'friendly'] as const) {
        resetAllGlobals();
        mechs.simOptions.difficulty = d;
        mechs.playerMechIndex = 0;
        mechs.mechCount = 2;
        mechs.groupTable[1]!.allegiance = role === 'enemy' ? 1 : 0;
        const e = spawn(role === 'player' ? 0 : 1, 1);
        expect(mechLoadConfig(e.loadout!, 'bhm00std', id, 'bhm00std')).toBe(true);
        const ct = loadoutArrays(e.loadout!).sections[2]!;
        const k = want[role][d]!;
        expect([ct.armorFront, ct.armorRear, ct.internal], `${role} difficulty ${d}`).toEqual([(46 * k) << 16, (15 * k) << 16, 31 << 16]);
      }
    }
  });

  it('sets heat dissipation per sink by difficulty, side and climate', () => {
    // BHM00STD has 20 heat sinks; cold is below -30, hot above 50
    const table: Array<[string, number, number, number]> = [
      // role, difficulty, temperature, rate
      ['player', 0, -31, 140], ['player', 0, 20, 70], ['player', 0, 51, 70],
      ['player', 1, -31, 100], ['player', 1, 20, 50], ['player', 1, 51, 45],
      ['player', 2, -31, 67], ['player', 2, 20, 45], ['player', 2, 51, 36],
      ['enemy', 2, -31, 100], ['enemy', 0, 20, 50], ['enemy', 1, 51, 45],
    ];
    for (const [role, d, temp, rate] of table) {
      resetAllGlobals();
      mechs.simOptions.difficulty = d;
      mechs.mechCount = 2;
      lighting.ambientTemperature = temp;
      const e = spawn(role === 'player' ? 0 : 1, 1);
      mechLoadConfig(e.loadout!, 'bhm00std', 2, 'bhm00std');
      expect(e.loadout!.heatDissipation, `${role} d${d} t${temp}`).toBe(rate * 20);
    }
  });

  it('prefers a loose MEK\\<config>.MEK over the resource the id names', () => {
    // a user variant as the mech lab saves one: here the stock Mad Dog's record, under the user name
    const madDog = mechCatalog(prj).find((m) => m.config === 'mdg00std')!;
    const bytes = prj.readResource('MEK', madDog.mekId)!;
    const loose = parseMek(bytes)!;
    setMekSource(new Map([['MEK/MDG00USR.MEK', bytes]]));
    try {
      mechs.mechCount = 2;
      const e = spawn(1, 1);
      // id 2 is BHM00STD (100 t); the loose Mad Dog must win
      expect(mechLoadConfig(e.loadout!, 'maddog', 2, 'mdg00usr')).toBe(true);
      const l = e.loadout!;
      expect(l.tons).toBe(loose.chassis.tons);
      expect(l.numWeapons).toBe(loose.numWeaponsLoaded);
      expect(loadoutArrays(l).weapons.slice(0, l.numWeapons).map((w) => w.slotCode)).toEqual(loose.weapons.map((w) => w.slotCode));
      expect(l.tons).not.toBe(parseMek(prj.readResource('MEK', 2)!)!.chassis.tons);
      // no loose file and no resource: failure
      expect(mechLoadConfig(e.loadout!, 'x', 0, 'nosuchmk')).toBe(false);
    } finally {
      setMekSource(new NodeFsSource(MW2_ROOT));
    }
  });

  it('writes the log lines in the C formats', () => {
    const out: string[] = [];
    setMechConfigLog((s) => out.push(s));
    mechs.mechCount = 2;
    const e = spawn(1, 1);
    mechLoadConfig(e.loadout!, 'behemoth', 2, 'bhm00std');
    expect(out.slice(0, 3)).toEqual(['\n\n chassis: behemoth  config: bhm00std  ', '\n  tons wt: 100 ', '\n  move: 3  jump: 3  heat: 20  ']);
    // weapon 0 is GAUSS (type 11) with two bins (ammo 0 and 2 feed code 1101), before the armour scaling
    const gauss = readWeaponTypes(exe)[11]!;
    expect(out).toContain(`\nweapon 0- type 11  ammo: ${2 * gauss.ammoPerTon * gauss.shots}  `);
    expect(out.find((x) => x.startsWith('\n\npiece 2-'))).toMatch(/^\n\npiece 2- armor: 46f 15r int: 31 flags:-?\d+\n$/);
    expect(out).toContain('\nammo 3 - class 11104 wpn 1102 ');
  });

  it('res_load_mgeo copies the seven MGEO dwords and writes the resolved id back', () => {
    const t = prj.type('MGEO')!;
    let checked = 0;
    for (let id = 0; id < t.entries.length; id++) {
      const name = prj.resourceName('MGEO', id);
      if (!name) continue;
      const want = parseMgeo(prj.readResource('MGEO', id)!)!;
      const e = spawn(1, 1);
      const ref = { id: -1, name };
      expect(resLoadMgeo(ref, e.loadout!), name).toBe(1);
      const l = e.loadout!;
      expect([l.rideHeight, l.eyeOffsetY, l.mgeoWord2, l.mgeoWord3, l.mgeoWord4, l.torsoPanLimit, l.radius], name).toEqual([
        want.rideHeight, want.eyeOffsetY, want.mgeoWord2, want.mgeoWord3, want.mgeoWord4, want.torsoPanLimit, want.radius,
      ]);
      expect(ref.id, name).toBe(id);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    const e = spawn(1, 1);
    const ref = { id: -1, name: 'NOSUCHGEO' };
    expect(resLoadMgeo(ref, e.loadout!)).toBe(0);
    expect(ref.id).toBe(-1);
  });

  it('spawns one gamepiece of each class and runs its create hook', () => {
    mechs.playerMechIndex = 0;
    planet.gravitySetting = 0x8000; // 0.5 g: the standard create hook doubles speed
    // two THNG nodes for every piece
    detail.detailRecordCount = 16;
    for (let k = 0; k < 16; k++) detail.detailRecords[k]!.node = sceneNodeCreate(null, 4);
    thingNodes.thingNodeQueue.fill(-1);
    for (let k = 0; k < 16; k++) thingNodes.thingNodeQueue[k] = k;
    thingNodes.thingNodeCount = 16;
    const classes = gamepieceClasses();
    const pieces: Array<{ e: MechEntity; row: number; speed: number }> = [];
    for (let row = 1; row <= 8; row++) {
      const idx = row - 1;
      const e = spawn(idx, row, idx === 0 ? 0 : 1);
      sceneNodeSetOrigin(e.node!, 1000 * row, 500, -2000 * row);
      sceneNodeWalk(e.node!);
      const l = e.loadout!;
      expect(l.entity).toBe(e);
      const { weapons, ammo } = loadoutArrays(l);
      expect(l.weapons).toBe(weapons[0]);
      expect(l.ammo).toBe(ammo[0]);
      expect(weapons.every((w) => w.slotState === -1 && w.type === -1 && w.fireState === -1 && w.ammo === -1)).toBe(true);
      const std = classes[row]!.createLoadout === classes[1]!.createLoadout;
      // only the standard loadout resets sectionIndex and the ammo bins
      expect(weapons.every((w) => w.sectionIndex === (std ? -1 : 0))).toBe(true);
      expect(ammo.every((b) => b.weaponIndex === (std ? -1 : 0) && b.field_0x0 === (std ? 0xffff : 0))).toBe(true);
      // the control block: playerControls for the player, the inline block (controlSource 2) otherwise
      if (idx === 0) expect([e.control, e.controlSource]).toEqual([mechs.playerControls, 0]);
      else expect(e.controlSource).toBe(2);
      expect([e.detailLevel, e.blockedByMech, e.animState, e.targetHandle, e.aimRange.current, e.aimRangeSeek.duration]).toEqual([-1, -1, -1, 0xffffffff, 50000, 3640]);
      l.rideHeight = 100 * row;
      e.gpsParams.set([0, 0, 35, 40, 3, 0, 0, 0]);
      if (row !== 7) mechLoadConfig(l, 'jenner', 47, 'jnr00std');
      pieces.push({ e, row, speed: l.speed });
    }
    mechDispatchHook0();
    for (const { e, row, speed } of pieces) {
      const l = e.loadout!;
      const label = `class ${row}`;
      // lifted by rideHeight and read back
      expect([e.posX, e.posY, e.posZ], label).toEqual([1000 * row, 500 + 100 * row, -2000 * row]);
      expect([e.torsoPitch, e.aimAngle, e.torsoRoll], label).toEqual([0, 0, 0]);
      if (row === 3) {
        expect([l.numWeapons, l.speed, l.flags, l.ramps[0]!.duration], label).toEqual([10, 0, 0x2000, 145]);
        expect(l.torsoNode).toBe(detail.detailRecords[4]!.node);
      } else if (row === 7) {
        expect([l.ramps[2]!.current, l.ramps[4]!.current, l.ramps[3]!.current], label).toEqual([e.posX, e.posY, e.posZ]);
        expect([e.headingCos, e.headingSin, e.animSoundId, l.throttleScale], label).toEqual([0x10000, 0, -1, 0x10000]);
      } else {
        expect(l.speed, label).toBe(speed * 2);
        expect(l.ramps[0]!.duration, label).toBe(row === 1 ? 36 : 109); // 0.2 s player, 0.6 s AI
        expect([l.ramps[4]!.current, l.throttleScale, l.flags & 0x2000], label).toEqual([0x400, 0x10000, 0x2000]);
        expect(e.animSoundId, label).toBe(row === 1 ? -1 : 0x103);
      }
      // mech_ai_setup: a local-AI mech gets the GPS values; the player none
      if (row === 1) expect([e.thinkDelay, e.aiSkillLevel, e.aiState], label).toEqual([0, 1, 0]);
      else {
        expect([e.thinkDelay, e.aiRangeOp4, e.aiRangeOp1, e.aiRangeOp2, e.aiSkillLevel, e.aiState], label).toEqual([2, 25000, 3500, 4000, 3, 12]);
        expect(e.engageEnabled, label).toBe(1);
      }
      // skill 3: bits 0, 1, 4, 6 (level < 4, < 4, < 5, < 6), bit 3 for class 1 only; not 2 (< 3) or 5 (< 2)
      if (row !== 1) expect(e.aiCapabilities, label).toBe(0x53 | (e.gamepieceClass === 1 ? 8 : 0));
    }
    expect(thingNodes.thingNodeNext).toBe(14); // doors pop none
    expect(thingNodeQueuePop()).toBe(detail.detailRecords[14]!.node);
  });

  const chunksOf = (tag: string): Chunk[] => streams.flatMap((s) => s.chunks.filter((c) => c.tag === tag));

  it('loads formations, stars and paths from the real chunks', () => {
    const ftbl = chunksOf('FTBL');
    const star = chunksOf('STAR');
    const ptbl = chunksOf('PTBL');
    expect(ftbl.length).toBeGreaterThan(0);
    let loaded = 0;
    for (const c of ftbl) {
      const before = formations.formationCount;
      const d = decodeFtbl(c);
      const ok = formationTableLoad(c);
      expect(ok).toBe(before < 0x20 && d.slots.length === 5 ? 1 : 0);
      if (ok) {
        const row = formations.formationPresets[before]!;
        expect([row.name, [...row.slotX], [...row.slotZ], [...row.slotHeading]]).toEqual([
          d.name, d.slots.map((s) => s.x), d.slots.map((s) => s.z), d.slots.map((s) => s.heading),
        ]);
        loaded++;
      }
    }
    expect(loaded).toBe(Math.min(0x20, ftbl.filter((c) => decodeFtbl(c).slots.length === 5).length));

    for (const c of star.slice(0, 5)) {
      const d = decodeStar(c);
      starTableLoad(c);
      // affiliationAllegiance: the last group of each affiliation wins
      const last = new Map<number, number>();
      for (const g of d.groups) last.set(g.affiliation, g.allegiance);
      for (const [a, v] of last) if (a >= 0 && a < 8) expect(mechs.affiliationAllegiance[a]).toBe(v);
      d.groups.forEach((g, i) => {
        const grp = mechs.groupTable[i]!;
        expect([grp.affiliation, grp.allegiance]).toEqual([g.affiliation, g.allegiance]);
        const hit = formations.formationPresets.slice(0, formations.formationCount).findIndex((p) => p.name.toLowerCase() === g.formation.toLowerCase());
        if (hit >= 0) {
          expect(grp.formation).toBe(hit);
          expect([...mechs.formationTable[i]!.slotX]).toEqual([...formations.formationPresets[hit]!.slotX]);
        }
      });
    }

    for (const c of ptbl) {
      const before = paths.projectPathCount;
      const d = decodePtbl(c);
      expect(pathTableLoad(c)).toBe(before < 0x40 ? 1 : 0);
      if (before < 0x40) {
        const p = paths.projectPaths[before]!;
        expect(p.name).toBe(d.name);
        expect(p.pointCount).toBe(d.points.length);
        expect(p.points.slice(0, p.pointCount).map((q) => [q.x, q.y, q.z, q.pitch, q.yaw, q.roll, q.duration])).toEqual(
          d.points.map((q) => [q.x, q.y, q.z, q.pitch << 16, q.yaw << 16, q.roll << 16, q.duration]),
        );
      }
    }
  });

  it('manages leaders and star slots', () => {
    // a formation with distinct offsets, as group 2's
    const f = formations.formationPresets[0]!;
    f.name = 'wedge';
    f.slotX.set([0, 10, 20, 30, 40]);
    f.slotZ.set([0, -5, -10, -15, -20]);
    formations.formationCount = 1;
    groupReset();
    expect(mechs.groupTable[2]!.leaderMechIndex).toBe(0);
    expect(groupSetFormationByName(2, 'WEDGE')).toBe(1);
    expect(groupSetFormationByName(2, 'vee')).toBe(0);
    mechs.playerMechIndex = 0;
    for (let i = 0; i < 4; i++) {
      const e = spawn(i, 1, 2);
      expect(mechSetStarSlot(i, mechs.groupTable[2]!.memberCount)).toBe(1);
      mechs.groupTable[2]!.members[mechs.groupTable[2]!.memberCount++] = i;
      void e;
    }
    expect(mechSetStarSlot(1, 5)).toBe(0);
    expect(mechSetStarSlot(9, 0)).toBe(0);
    // mech 2 (slot 2) leads: every slot re-based on slot 2's offset
    expect(groupSetLeader(2, 2)).toBe(1);
    expect([...mechs.formationTable[2]!.slotX]).toEqual([-20, -10, 0, 10, 20]);
    expect([...mechs.formationTable[2]!.slotZ]).toEqual([10, 5, 0, -5, -10]);
    // star numbering: leader 0, the rest 1, 2, 3 in member order; a destroyed member (flags & 6) skipped
    mechs.mechTable[1]!.flags = 2;
    expect(starAssignSlots(2)).toBe(1);
    expect(mechs.mechTable.slice(0, 4).map((e) => e!.starSlot)).toEqual([1, 1, 0, 2]);
    // no leader: elect the first usable member that is not the (recorded) leader
    groupSetLeader(2, -1);
    expect(starAssignSlots(2)).toBe(1);
    expect(mechs.groupTable[2]!.leaderMechIndex).toBe(0);
    expect(mechs.mechTable[0]!.starSlot).toBe(0);
  });

  it('installs the owner affiliation poly_resolve_code adds', () => {
    mechs.mechCount = 1;
    spawn(0, 1, 3);
    mechs.groupTable[3]!.affiliation = 5;
    things.gameThings[7]!.affiliation = -1;
    things.gameThings[8]!.affiliation = 2;
    const w = wtboGlobals;
    w.polyOwnerActive = 1;
    w.polyOwnerKind = 0x100;
    w.polyOwnerIndex = 0;
    expect(polyResolveCode(0x314)).toBe(0x319);
    w.polyOwnerKind = 0x200;
    w.polyOwnerIndex = 7;
    expect(polyResolveCode(0x300)).toBe(0x300);
    w.polyOwnerIndex = 8;
    expect(polyResolveCode(0x300)).toBe(0x302);
    w.polyOwnerActive = 0;
  });
});

