/**
 * Jenner: a 35-ton Inner Sphere striker. The glass widens upwards into the
 * roof; a tight cabin with switch banks and pipes.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const jenner: CockpitDesign = {
  key: 'JN',
  name: 'Jenner',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.7, floor: -0.85, roof: 0.45, front: 0.9, back: 0.4 }, layout: 'wrap', style: 'is', console: { dist: 0.6, halfWidth: 0.21, wing: 0.27, turn: 42 } });
  },
};
