/**
 * Summoner (Thor): a 70-ton Clan heavy. Its cockpit is a small head set off
 * to the right of the torso, with a visor band round its top front (lowered
 * to eye level, glass.ts); a switch panel low on the left wall, below the
 * band.
 *
 * @portOnly
 */
import { facingEye, Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const summoner: CockpitDesign = {
  key: 'SU',
  name: 'Summoner',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 0.95, floor: -0.95, roof: 0.55, front: 1.05, back: 0.5 }, layout: 'wrap', style: 'clan', console: { dist: 0.64 } });
    const wall = facingEye([-s.box.halfWidth + 0.04, -0.42, -0.2], 0);
    k.slab(wall, 0.3, 0.2, -0.03, Mat.panel);
    k.switches(wall, 2, 5, 0.03, 0, -0.02, Mat.trim);
    k.lamps(wall, [Mat.lampGreen, Mat.lampAmber, Mat.lampRed], 0.03, 0, 0.07);
  },
};
