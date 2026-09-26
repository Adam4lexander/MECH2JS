/**
 * Warhammer: the Inner Sphere's 70-ton heavy. Its glass opens up into the
 * roof and widens again at its foot, so the console splits into pods clear of
 * it; pipes and switch banks.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const warhammer: CockpitDesign = {
  key: 'WH',
  name: 'Warhammer',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.55, front: 1.05, back: 0.5 }, layout: 'split', style: 'is', pods: { yaw: 34, dist: 0.62 } });
  },
};
