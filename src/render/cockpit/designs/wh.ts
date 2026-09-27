/**
 * Warhammer: the Inner Sphere's 70-ton heavy. A flat trapezoid panel of
 * glass on top of the torso between the shoulder blocks, open over the
 * pilot; a console under it, pipes and switch banks.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const warhammer: CockpitDesign = {
  key: 'WH',
  name: 'Warhammer',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.55, front: 1.05, back: 0.5 }, layout: 'wrap', style: 'is', console: { dist: 0.64 } });
  },
};
