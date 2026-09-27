/**
 * Kit Fox (Uller): a 30-ton Clan light. A sloped rectangular canopy sits on
 * top of its head, open round the left and over the front; a compact
 * console under it.
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
