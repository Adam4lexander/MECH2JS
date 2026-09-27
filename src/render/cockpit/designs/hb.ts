/**
 * Hellbringer (Loki): a 65-ton Clan heavy. Its cockpit is in the torso: a
 * trapezoid windshield sloping back between the shoulder blocks, narrow at
 * the top and open over the pilot's head; a console under it.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const hellbringer: CockpitDesign = {
  key: 'HB',
  name: 'Hellbringer',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.55, front: 1.25, back: 0.5 }, layout: 'wrap', style: 'clan', console: { dist: 0.62 } });
  },
};
