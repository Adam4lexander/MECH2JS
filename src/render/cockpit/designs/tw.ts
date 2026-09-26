/**
 * Timber Wolf (Mad Cat): a 75-ton Clan heavy. Its glass wraps round - past
 * 90 degrees either side - so the cabin's side walls open too; a low
 * wrap-around console under it.
 *
 * @portOnly
 */
import { Kit, type CockpitDesign, type Glass } from '../kit.ts';
import { standard } from '../standard.ts';

export const timberWolf: CockpitDesign = {
  key: 'TW',
  name: 'Timber Wolf',
  build(k: Kit, glass: Glass) {
    standard(k, glass, { box: { halfWidth: 0.9, floor: -0.95, roof: 0.55, front: 1.05, back: 0.5 }, layout: 'wrap', style: 'clan' });
  },
};
