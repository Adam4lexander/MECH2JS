/**
 * Stormcrow (Ryoken): a 55-ton Clan medium. Its glass is a wide slot with a
 * post at its middle; a console under it that starts just below the glass.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const stormcrow: CockpitDesign = {
  key: 'SC',
  name: 'Stormcrow',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.8, floor: -0.9, roof: 0.5, front: 1.0, back: 0.45 }, layout: 'wrap', style: 'clan', console: { dist: 0.62 } });
  },
};
