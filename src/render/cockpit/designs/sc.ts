/**
 * Stormcrow (Ryoken): a 55-ton Clan medium. A trapezoid windshield set into
 * the front of its nose, sloping up over the pilot; a console under it.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const stormcrow: CockpitDesign = {
  key: 'SC',
  name: 'Stormcrow',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.8, floor: -0.9, roof: 0.55, front: 1.25, back: 0.45 }, layout: 'wrap', style: 'clan', console: { dist: 0.62 } });
  },
};
