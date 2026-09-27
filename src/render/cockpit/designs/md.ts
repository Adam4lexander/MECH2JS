/**
 * Mad Dog (Vulture): a 60-ton Clan heavy. Its glass is a trapezoid panel at
 * the top front of the central head block, between the taller blocks either
 * side: a forward-and-up window, 25 degrees either side, over a console.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const madDog: CockpitDesign = {
  key: 'MD',
  name: 'Mad Dog',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.8, floor: -0.9, roof: 0.5, front: 1.95, back: 0.45 }, layout: 'wrap', style: 'clan', console: { dist: 0.6 } });
  },
};
