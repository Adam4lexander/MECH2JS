/**
 * Mad Dog (Vulture): a 60-ton Clan heavy with a nose of glass - the window
 * runs down to 70 degrees below the eye. The console splits into two pods so
 * the pilot sees the ground through the floor between them.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const madDog: CockpitDesign = {
  key: 'MD',
  name: 'Mad Dog',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.8, floor: -0.9, roof: 0.5, front: 1.0, back: 0.45 }, layout: 'split', style: 'clan', pods: { yaw: 28, dist: 0.6 } });
  },
};
