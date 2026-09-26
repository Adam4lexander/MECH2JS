/**
 * Kit Fox (Uller): a 30-ton Clan light. Its glass is a diamond that runs out
 * to the sides at eye level and up into a peak; a compact console and an
 * overhead strip under the peak's sides.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const kitFox: CockpitDesign = {
  key: 'KF',
  name: 'Kit Fox',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.7, floor: -0.85, roof: 0.45, front: 0.9, back: 0.4 }, layout: 'wrap', style: 'clan', console: { dist: 0.6, halfWidth: 0.2, wing: 0.27, turn: 42 } });
  },
};
