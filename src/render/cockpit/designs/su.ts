/**
 * Summoner (Thor): a 70-ton Clan heavy. Its glass is lopsided - it runs
 * round to the right but stops 61 degrees to the left - so a switch panel
 * sits on the closed left wall.
 *
 * @portOnly
 */
import { facingEye, Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const summoner: CockpitDesign = {
  key: 'SU',
  name: 'Summoner',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.55, front: 1.05, back: 0.5 }, layout: 'wrap', style: 'clan', console: { dist: 0.64 } });
    const wall = facingEye([-s.box.halfWidth + 0.04, -0.1, -0.2], 0);
    k.slab(wall, 0.3, 0.26, -0.03, Mat.panel);
    k.switches(wall, 3, 5, 0.03, 0, 0, Mat.trim);
    k.lamps(wall, [Mat.lampGreen, Mat.lampAmber, Mat.lampRed], 0.03, 0, 0.1);
  },
};
