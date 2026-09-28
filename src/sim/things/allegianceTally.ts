/**
 * The mission's opening count of who is on which side, into the stats block
 * at 0xa5630 that MW2CAR.CFG saves for the shell's debriefing.
 */
import { statsWordAdd } from '../effects/simTables.ts';
import { mechAllegiance } from '../groups/groups.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { worldObjectNode } from '../world/worldRecords.ts';
import { gamethingAllegiance } from './gameThingDamage.ts';
import { things } from './gameThings.ts';

/**
 * Tallies every mech and then every gamething by allegiance into the words
 * at 0xa5668 (friendly), 0xa566c (enemy) and 0xa566a (allegiance 2) for
 * mechs, and 0xa566e / 0xa5672 / 0xa5670 for gamethings; a gamething's range
 * becomes its scene node's world object's radius.
 *
 * @mw2 sim_count_mechs_by_status 0x0004fd00
 * @fidelity exact
 */
export function simCountMechsByStatus(): void {
  for (let i = 0; i < mechs.mechCount; i++) {
    const a = mechAllegiance(i);
    if (a === 0) statsWordAdd(0xa5668);
    else if (a < 2) statsWordAdd(0xa566c);
    else if (a === 2) statsWordAdd(0xa566a);
  }
  for (let i = 0; i < things.gameThingCount; i++) {
    const a = gamethingAllegiance(i);
    if (a === 0) statsWordAdd(0xa566e);
    else if (a < 2) statsWordAdd(0xa5672);
    else if (a === 2) statsWordAdd(0xa5670);
    const t = things.gameThings[i]!;
    const node = worldObjectNode(t.geomIndex);
    const obj = node?.userData as { radius: number } | null | undefined;
    if (node && obj) t.range = obj.radius;
  }
}
