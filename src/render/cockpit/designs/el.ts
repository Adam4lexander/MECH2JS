/**
 * Elemental: Clan battle armour, not a mech - the pilot wears it. Its helmet's
 * visor is a chevron (grown to see through, glass.ts), so this is a helmet's
 * worth of space: a small console close under the visor, the armrests the
 * suit's own arms.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const elemental: CockpitDesign = {
  key: 'EL',
  name: 'Elemental',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.5, floor: -0.65, roof: 0.32, front: 0.62, back: 0.3 }, layout: 'wrap', style: 'clan', console: { pitch: -21, dist: 0.5, height: 0.2, halfWidth: 0.18, wing: 0.24, turn: 44 }, arms: { x: 0.3, y: -0.45 }, overhead: false });
  },
};
