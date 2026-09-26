/**
 * Battlemaster: the Inner Sphere's 85-ton command mech. Its glass is a broad
 * shield that narrows to a V below the nose, so the console splits into two
 * pods clear of the V, with a low pedestal of switches under its point; pipes
 * and switch banks in the Inner Sphere's way.
 *
 * @portOnly
 */
import { facingEye, Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const battlemaster: CockpitDesign = {
  key: 'BM',
  name: 'Battlemaster',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 1.0, floor: -1.0, roof: 0.6, front: 1.15, back: 0.55 }, layout: 'split', style: 'is', pods: { yaw: 30, dist: 0.66 } });
    // a low pedestal under the glass's point, below the view
    k.box([0, s.box.floor + 0.2, -0.62], [0.26, 0.4, 0.2], Mat.hull);
    k.switches(facingEye([0, s.box.floor + 0.42, -0.58], 40), 3, 6, 0.024, 0, 0, Mat.trim);
  },
};
