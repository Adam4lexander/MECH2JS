/**
 * Tarantula: a 25-ton Inner Sphere jumping spider on four legs. It wears the
 * Kit Fox's cockpit shell in the original, under its own head; here it has
 * its own cockpit, cut to its exterior: a long, flat sheet of glass over the
 * top of its body, a low windscreen running 100 degrees either side. A tight
 * cabin with switch banks and pipes.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const tarantula: CockpitDesign = {
  key: 'TR',
  name: 'Tarantula',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.7, floor: -0.85, roof: 0.45, front: 0.9, back: 0.4 }, layout: 'wrap', style: 'is', console: { dist: 0.6, halfWidth: 0.21, wing: 0.27, turn: 42 } });
  },
};
