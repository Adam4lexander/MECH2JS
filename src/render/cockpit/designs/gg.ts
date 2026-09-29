/**
 * Gargoyle (Man O' War): an 80-ton Clan assault whose head is a face - two
 * eye slits either side of a nose ridge, joined into one visor slit here
 * (glass.ts): a letterbox 54 degrees either side, 15 down to 20 up, in a
 * heavy, closed cabin.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const gargoyle: CockpitDesign = {
  key: 'GG',
  name: 'Gargoyle',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 1.0, floor: -1.0, roof: 0.6, front: 1.15, back: 0.55 }, layout: 'wrap', style: 'clan', console: { halfWidth: 0.25, wing: 0.3, turn: 40 } });
  },
};
