/**
 * The hand-built cockpits, by chassis key (cockpit/chassis.ts).
 *
 * @portOnly
 */
import { canopyOf, PLAIN_CANOPY } from '../canopy.ts';
import { CANOPY } from '../glass.ts';
import { Kit, type CockpitDesign } from '../kit.ts';
import { battlemaster } from './bm.ts';
import { direWolf } from './dw.ts';
import { elemental } from './el.ts';
import { fireMoth } from './fm.ts';
import { gargoyle } from './gg.ts';
import { hellbringer } from './hb.ts';
import { jenner } from './jn.ts';
import { kitFox } from './kf.ts';
import { madDog } from './md.ts';
import { marauder } from './mr.ts';
import { nova } from './nv.ts';
import { rifleman } from './rf.ts';
import { stormcrow } from './sc.ts';
import { summoner } from './su.ts';
import { tarantula } from './tr.ts';
import { timberWolf } from './tw.ts';
import { warhammer } from './wh.ts';
import { warhawk } from './wk.ts';

export const DESIGNS: Record<string, CockpitDesign> = Object.fromEntries([battlemaster, direWolf, elemental, fireMoth, gargoyle, hellbringer, jenner, kitFox, madDog, marauder, nova, rifleman, stormcrow, summoner, tarantula, timberWolf, warhammer, warhawk].map((d) => [d.key, d]));

/** Builds a design's kit round its mech's canopy (glass.ts; a design without one gets a plain window). */
export function buildDesign(d: CockpitDesign): Kit {
  const k = new Kit();
  d.build(k, canopyOf(CANOPY[d.key] ?? PLAIN_CANOPY));
  return k;
}
