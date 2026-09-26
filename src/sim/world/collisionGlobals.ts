/**
 * The collision queries' result globals (project_entry / terrain): each
 * query answers through a return value and leaves the surface normal of what
 * it found in one of three 16.16 triples.
 */
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';

export const collision = registerGlobals(
  'collision',
  {
    /** 0x95abc..0x95ac4: the normal at the last hit of any single-object query (polygon, box, sphere) */
    hitNormalX: 0,
    hitNormalY: 0,
    hitNormalZ: 0,
    /** 0x95ac8..0x95ad0: the normal of the surface world_ground_height_near / world_find_highest_hit chose */
    groundNormalX: 0,
    groundNormalY: 0,
    groundNormalZ: 0,
    /** 0x95ad4..0x95adc: the normal at the nearest hit of the last world raycast, or of the last sphere pushout */
    rayHitNormalX: 0,
    rayHitNormalY: 0,
    rayHitNormalZ: 0,
    /** 0x95ae0: while set, object_build_ground_quadtree builds nothing */
    groundQuadtreesDisabled: 0,
    /** 0x95ae8: ray_hit_object_box stashes a negative entry distance here (a ray starting inside the box); no reader is known */
    dat00095ae8: 0,
  },
  () => {
    const c = collision;
    c.hitNormalX = imageI32(LABEL.hitNormalX, 0);
    c.hitNormalY = imageI32(LABEL.hitNormalY, 0);
    c.hitNormalZ = imageI32(LABEL.hitNormalZ, 0);
    c.groundNormalX = imageI32(LABEL.groundNormalX, 0);
    c.groundNormalY = imageI32(LABEL.groundNormalY, 0);
    c.groundNormalZ = imageI32(LABEL.groundNormalZ, 0);
    c.rayHitNormalX = imageI32(LABEL.rayHitNormalX, 0);
    c.rayHitNormalY = imageI32(LABEL.rayHitNormalY, 0);
    c.rayHitNormalZ = imageI32(LABEL.rayHitNormalZ, 0);
    c.groundQuadtreesDisabled = imageI32(LABEL.groundQuadtreesDisabled, 0);
    c.dat00095ae8 = imageI32(0x95ae8, 0);
  },
);
