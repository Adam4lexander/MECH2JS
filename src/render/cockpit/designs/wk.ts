/**
 * Warhawk (Masakari): an 85-ton Clan assault with a broad panoramic glass,
 * 73 degrees either side; a wide console and a wide overhead panel.
 *
 * @portOnly
 */
import { facingEye, Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const warhawk: CockpitDesign = {
  key: 'WK',
  name: 'Warhawk',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 1.0, floor: -1.0, roof: 0.6, front: 1.15, back: 0.55 }, layout: 'wrap', style: 'clan', console: { halfWidth: 0.25, wing: 0.3, turn: 40 } });
    const over = facingEye([0, s.box.roof - 0.1, -0.1], -75);
    k.slab(over, 0.6, 0.12, -0.03, Mat.panel);
    k.lamps(over, [Mat.lampGreen, Mat.lampGreen, Mat.lampAmber, Mat.lampGreen, Mat.lampGreen], 0.05);
  },
};
