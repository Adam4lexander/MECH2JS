/**
 * The render global block: what viewer_latch_globals flattens out of the
 * viewer for the object cull, the clipper and the shading code (0x14fe40..
 * 0x14fec0 and the light latch at 0x14fcb8..), plus the per-object values
 * the object walk passes down (objectViewDepth, polySortFlags).
 *
 * Nothing here is sim state: it is rebuilt from a viewer at the start of
 * every frame's draw.
 */
import type { Viewer } from '../../generated/classes.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import type { LightLatch } from '../shading/polygonColour.ts';

export const renderView = registerGlobals(
  'renderView',
  {
    /** the viewer last latched (viewerPosition, as the renderer sees it) */
    viewer: null as Viewer | null,
    /** 0x14fe94 / 0x14fe90 / 0x14fe98: the eye, world cm */
    viewTranslationX: 0,
    viewTranslationY: 0,
    viewTranslationZ: 0,
    /** 0x14fed4 / 0x14feac / 0x14fea8: Viewer.rotation row 2 (2.29), the view-depth axis */
    viewDepthRowX: 0,
    viewDepthRowY: 0,
    viewDepthRowZ: 0,
    /** 0x14fe7c / 0x14fecc / 0x14fed0: the same row, the copy the object cull reads */
    cullDepthRowX: 0,
    cullDepthRowY: 0,
    cullDepthRowZ: 0,
    /** 0x14feb4 / 0x14fea4: near and far clip, cm */
    viewNearClip: 0,
    viewFarClip: 0,
    /** 0x14feb0 / 0x14fec8: the same x 4, the scale of the clipper's vertex depths */
    viewNearClipScaled: 0,
    viewFarClipScaled: 0,
    /** 0x14fcbc, 0x14fcb8, 0x14fec0 / 0x14fec4 / 0x14feb8: the light latch the shading reads */
    light: { ambientLight: 0, lightDirectional: 0, lightX: 0, lightY: 0, lightZ: 0 } as LightLatch,
    /** 0x14fcac: view depth of the object the cull last accepted, cm - the LOD distance */
    objectViewDepth: 0,
    /** 0x14fcc0: the flags word of the object being drawn; bits 0-2 pick each polygon's depth key */
    polySortFlags: 0,
  },
  () => {},
);

/**
 * Publishes a viewer to the renderer: the eye, the rotation's depth row
 * (raw, for the clipper and the cull), the clip distances plain and x 4, and
 * the light latch.
 *
 * @mw2 viewer_latch_globals 0x0003ece0
 * @fidelity partial
 * @divergence only the fields the object cull, clipper and shading read are latched: the projection (rows 0-1 premultiplied by projScale, centre, viewport bounds) is done by the GPU from the same viewer; viewerPosition itself is left to the caller, so the editor can draw from its own viewer without handing it to the simulation
 */
export function viewerLatchGlobals(v: Viewer): void {
  const r = renderView;
  r.viewer = v;
  r.light = { ambientLight: v.ambientLight, lightDirectional: v.lightDirectional, lightX: v.lightPos[0]!, lightY: v.lightPos[1]!, lightZ: v.lightPos[2]! };
  r.cullDepthRowX = r.viewDepthRowX = v.rotation[6]!;
  r.cullDepthRowY = r.viewDepthRowY = v.rotation[7]!;
  r.cullDepthRowZ = r.viewDepthRowZ = v.rotation[8]!;
  r.viewTranslationX = v.translationX;
  r.viewTranslationY = v.translationY;
  r.viewTranslationZ = v.translationZ;
  r.viewNearClip = v.nearClip;
  r.viewFarClip = v.farClip;
  r.viewFarClipScaled = Math.imul(v.farClip, 4);
  r.viewNearClipScaled = Math.imul(v.nearClip, 4);
}
