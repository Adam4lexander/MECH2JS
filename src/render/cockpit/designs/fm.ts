/**
 * Fire Moth (Dasher): a 20-ton Clan scout. A small, upright window, a cramped
 * cabin, and a compact console tucked under it.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const fireMoth: CockpitDesign = {
  key: 'FM',
  name: 'Fire Moth',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.7, floor: -0.85, roof: 0.45, front: 0.9, back: 0.4 }, layout: 'wrap', style: 'clan', console: { dist: 0.6, halfWidth: 0.2, wing: 0.27, turn: 42 } });
  },
};
