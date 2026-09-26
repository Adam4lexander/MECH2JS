/**
 * Hellbringer (Loki): a 65-ton Clan heavy. Its glass starts low, only 16
 * degrees down, and opens into the roof; a console under it and no overhead
 * panel.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const hellbringer: CockpitDesign = {
  key: 'HB',
  name: 'Hellbringer',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.55, front: 1.05, back: 0.5 }, layout: 'wrap', style: 'clan', console: { dist: 0.62 } });
  },
};
