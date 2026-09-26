/**
 * Nova (Black Hawk): a 50-ton Clan mech with a tall slot of glass from 54
 * degrees down to 40 up. The console splits into pods clear of the slot, and
 * lamp strips run down its sides.
 *
 * @portOnly
 */
import { Mat, Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const nova: CockpitDesign = {
  key: 'NV',
  name: 'Nova',
  build(k: Kit, glass: Glass) {
    const s = standard(k, glass, { box: { halfWidth: 0.8, floor: -0.9, roof: 0.5, front: 1.0, back: 0.45 }, layout: 'split', style: 'clan', pods: { yaw: 32, dist: 0.6 } });
    for (const x of [-0.44, 0.44]) for (let y = -0.35; y <= 0.3; y += 0.05) k.box([x, y, -s.box.front + 0.03], [0.018, 0.018, 0.012], y > 0.1 ? Mat.lampAmber : Mat.lampGreen);
  },
};
