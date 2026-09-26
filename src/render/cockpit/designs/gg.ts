/**
 * Gargoyle (Man O' War): an 80-ton Clan assault with a narrow, tall slot of
 * glass. The console splits into pods clear of the slot, and heavy struts
 * frame it either side.
 *
 * @portOnly
 */
import { Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const gargoyle: CockpitDesign = {
  key: 'GG',
  name: 'Gargoyle',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 1.0, floor: -1.0, roof: 0.6, front: 1.15, back: 0.55 }, layout: 'split', style: 'clan', pods: { yaw: 32, dist: 0.64 } });
    for (const x of [-0.43, 0.43]) k.beam([x, s.box.floor + 0.3, -s.box.front + 0.08], [x, s.box.roof - 0.05, -s.box.front + 0.08], 0.08, 0.1, Mat.frame, [0, 0, 1]);
  },
};
