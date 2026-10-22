/**
 * Nova (Black Hawk): a 50-ton Clan mech. A faceted canopy covers the top of
 * its nose, open overhead and 84 degrees either side; a console under it.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const nova: CockpitDesign = {
  key: 'NV',
  name: 'Nova',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.8, floor: -0.9, roof: 0.5, front: 1.85, back: 1 }, layout: 'wrap', style: 'clan', console: { dist: 0.6 } });
  },
};
