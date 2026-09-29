/**
 * Rifleman: a 60-ton Inner Sphere anti-aircraft mech. A tall, narrow window
 * under the flat brim of its head - 30 degrees either side, 28 down to 39 up,
 * for watching the sky; a long console, switch banks and pipes.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const rifleman: CockpitDesign = {
  key: 'RF',
  name: 'Rifleman',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.7, front: 1.05, back: 0.5 }, layout: 'wrap', style: 'is', console: { dist: 0.64, halfWidth: 0.24 } });
  },
};
