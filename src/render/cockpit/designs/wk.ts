/**
 * Warhawk (Masakari): an 85-ton Clan assault. Its glass is a band under the
 * head's wide flat brim, wrapping round the sides and reaching down to 54
 * degrees in front, so the console splits into pods; the brim is a wide
 * overhead panel.
 *
 * @portOnly
 */
import { facingEye, Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const warhawk: CockpitDesign = {
  key: 'WK',
  name: 'Warhawk',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 1.6, floor: -1, roof: 0.6, front: 1.45, back: 0.6 }, layout: 'split', style: 'clan', pods: { yaw: 32, dist: 0.64 } });
    const over = facingEye([0, s.box.roof - 0.1, -0.1], -75);
    k.slab(over, 0.6, 0.12, -0.03, Mat.panel);
    k.lamps(over, [Mat.lampGreen, Mat.lampGreen, Mat.lampAmber, Mat.lampGreen, Mat.lampGreen], 0.05);
  },
};
