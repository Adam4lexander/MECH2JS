/**
 * Dire Wolf (Daishi): the Clans' 100-ton assault. Its glass is a narrow
 * forward slot that opens up into the roof, so there is no overhead panel;
 * instead two grab bars run under the open canopy, and the console is broad.
 *
 * @portOnly
 */
import { Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const direWolf: CockpitDesign = {
  key: 'DW',
  name: 'Dire Wolf',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 1.0, floor: -1.0, roof: 0.6, front: 1.15, back: 0.55 }, layout: 'wrap', style: 'clan', console: { halfWidth: 0.25, wing: 0.3, turn: 40 } });
    for (const x of [-0.35, 0.35]) k.pipe([x, s.box.roof - 0.1, -0.5], [x, s.box.roof - 0.1, 0.25], 0.016, Mat.frame);
  },
};
