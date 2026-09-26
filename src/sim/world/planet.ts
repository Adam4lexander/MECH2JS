/**
 * World-wide physical settings the PLNT chunk (keyword planet) and the
 * options set. Values boot from the image and are overwritten by the
 * mission's PLNT chunk (project_chunk_exec).
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const planet = registerGlobals(
  'planet',
  {
    /** 0x957b0: downward acceleration; PLNT sets it to planet value * 0x794 >> 16, rounded */
    gravity: 1940,
    /** 0x957b4: the planet's own gravity figure; falling_object_randomise_motion scales tumble speed by it */
    gravitySetting: 0,
  },
  () => {
    planet.gravity = imageI32(LABEL.gravity, 1940);
    planet.gravitySetting = imageI32(LABEL.gravitySetting, 0);
  },
);
