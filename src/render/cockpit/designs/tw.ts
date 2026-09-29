/**
 * Timber Wolf (Mad Cat): a 75-ton Clan heavy. The cockpit is in its nose,
 * under a faceted bubble canopy - glass overhead and round the upper sides,
 * down to 14 degrees in front; a low wrap-round console under it.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const timberWolf: CockpitDesign = {
  key: 'TW',
  name: 'Timber Wolf',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 1, floor: -0.95, roof: 1, front: 2.25, back: 0.5 }, layout: 'wrap', style: 'clan' });
  },
};
