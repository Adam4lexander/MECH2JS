/**
 * Damage to gamethings - the shootable buildings and objects of the GT table
 * - and their destruction: the kill tallies, the replacement model (a wreck
 * or nothing) and, for debris-flagged replacements, falling pieces.
 */
import { unestablished } from '../../core/provenance.ts';
import type { GameThing, WorldObject } from '../../generated/classes.gen.ts';
import { effectSpawn } from '../effects/effects.ts';
import { simTables, statsWordAdd } from '../effects/simTables.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { destructiblesRegisterSubtree } from './destructibles.ts';
import { things } from './gameThings.ts';
import {
  debrisTeardown,
  world,
  worldRecordObject,
  worldRecordReleaseSubtree,
  worldRecordReplace,
  worldRecordsPropagate,
} from '../world/worldRecords.ts';

/**
 * Takes damage off the gamething whose object was struck (obj.index names
 * it). A destroyed thing (flags 4) is skipped, and so is one with 0 hit
 * points - ZERO MEANS INDESTRUCTIBLE, which is 1157 of MW2.PRJ's 2338 GT
 * chunks. At or below 0 the hit points clamp to 0, explosion 0xd (an object
 * of family 0xb0) or 3, then 0x20b, spawn at (x, y, z), and the thing is
 * destroyed. The original returns two registers no caller reads.
 *
 * @mw2 gamething_apply_damage 0x00051b70
 * @fidelity exact
 */
export function gamethingApplyDamage(obj: WorldObject | null, damage: number, x: number, y: number, z: number): void {
  if (!obj) return;
  const i = obj.index & 0xffff;
  const g = things.gameThings[i];
  if (!g) {
    unestablished(`gamething_apply_damage: object index ${i} is past the 254 gamethings`, 'gamething_apply_damage');
    return;
  }
  if ((g.flags & 4) !== 0 || g.hitPoints === 0) return;
  g.hitPoints = (g.hitPoints - damage) | 0;
  if (g.hitPoints >= 1) return;
  g.hitPoints = 0;
  const record = worldRecordObject(g.geomIndex);
  if (!record) unestablished('gamething_apply_damage: the destroyed thing has no world object (the original reads its type through a null pointer)', 'gamething_apply_damage');
  const code = record && (record.type & 0xf0) === 0xb0 ? 0xd : 3;
  effectSpawn(code, x, y, z, x, y, z, 0, 0, 0);
  effectSpawn(0x20b, x, y, z, x, y, z, 0, 0, 0);
  gamethingDestroy(i);
}

/**
 * Scores and removes a destroyed gamething, once (flags 4 returns at once).
 * When killCreditMech is set the kill is tallied by the thing's allegiance -
 * in the player's own counters too when the player made it - and
 * killCreditMech goes back to -1. A thing flagged 0x40 makes the scripted
 * event call, which is empty in this build. Then its world record is
 * destroyed and replaced.
 *
 * @mw2 gamething_destroy 0x00051aa0
 * @fidelity exact
 */
export function gamethingDestroy(i: number): void {
  const g = things.gameThings[i]!;
  if ((g.flags & 4) !== 0) return;
  const t = simTables;
  if (t.killCreditMech !== -1) {
    if (t.killCreditMech === mechs.playerMechIndex) {
      const a = gamethingAllegiance(i);
      if (a === 0) statsWordAdd(0xa5641);
      else if (a < 2) statsWordAdd(0xa563d);
      else if (a === 2) statsWordAdd(0xa563f);
    }
    const a = gamethingAllegiance(i);
    if (a === 0) statsWordAdd(0xa5658);
    else if (a < 2) statsWordAdd(0xa5654);
    else if (a === 2) statsWordAdd(0xa5656);
    t.killCreditMech = -1;
  }
  if ((g.flags & 0x40) !== 0) missionEventNop();
  gamethingDestroyWorldRecord(g);
}

/**
 * The world-record half of gamething_destroy: the record is flagged
 * DESTROYED (0x200) and replaced; when the replacement's own gamething
 * carries 0x8000 (debris) its subtree becomes destructibles and its record
 * is released. Then the change propagates to child records.
 *
 * @mw2 gamething_destroy_world_record 0x00036240
 * @fidelity exact
 * @divergence the original sets 0x200 on worldRecords[geomIndex] before testing geomIndex for -1, and reads gameThings[-1] for a replacement with no gamething; the port skips both out-of-table accesses (the first cannot happen - a thing with geomIndex -1 already has flags 4)
 */
export function gamethingDestroyWorldRecord(g: GameThing): void {
  const gi = g.geomIndex;
  const r = world.worldRecords[gi];
  if (r) r.flags |= 0x200;
  let record = -1;
  if (gi !== -1) record = worldRecordReplace(gi);
  if (record !== -1) {
    const rr = world.worldRecords[record]!;
    const rg = things.gameThings[rr.gamething];
    if (!rg) unestablished(`gamething_destroy_world_record: replacement record ${record} has no gamething; the original tests the word before gameThings (0xf4a80)`, 'gamething_destroy_world_record');
    if (rg && ((rg.flags << 16) >> 16 & 0x8000) !== 0) {
      destructiblesRegisterSubtree(rr.node, debrisTeardown, 0);
      worldRecordReleaseSubtree(record);
    }
  }
  worldRecordsPropagate();
}

/**
 * A gamething's side on mech_allegiance's scale - 0 friendly, 1 enemy, 2
 * neutral: affiliationAllegiance[affiliation], or 2 with no affiliation.
 *
 * @mw2 gamething_allegiance 0x0002b260
 * @fidelity exact
 */
export function gamethingAllegiance(i: number): number {
  const a = things.gameThings[i]!.affiliation;
  if (a < 0) return 2;
  const v = mechs.affiliationAllegiance[a];
  if (v === undefined) {
    unestablished(`gamething_allegiance: affiliation ${a} is past the 8-entry table`, 'gamething_allegiance');
    return 0;
  }
  return v & 0xff;
}

/**
 * The scripted-event hook for nav points and gamethings flagged 0x40: push
 * ebp / mov ebp, esp / pop ebp / ret - empty in this build.
 *
 * @mw2 mission_event_nop 0x00017280
 * @fidelity exact
 */
export function missionEventNop(): void {}
