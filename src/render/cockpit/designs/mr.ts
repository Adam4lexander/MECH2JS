/**
 * Marauder: the Inner Sphere's 75-ton heavy. Its wedge head's face has one
 * long six-sided slit of glass (brought nearer the eye, glass.ts); a heavy,
 * closed cabin round it, switch banks and pipes.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const marauder: CockpitDesign = {
  key: 'MR',
  name: 'Marauder',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.55, front: 1.05, back: 0.5 }, layout: 'wrap', style: 'is', console: { dist: 0.64, halfWidth: 0.24 } });
  },
};
