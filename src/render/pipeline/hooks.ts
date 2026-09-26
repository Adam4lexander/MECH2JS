/**
 * The render-state block's draw hooks (objectCullHook, polygonDrawHook) hold
 * original code addresses (sim/display/renderState.ts); these are the ports
 * behind them. clipProjectHook needs none: projection is the GPU's, which
 * SceneRenderer sets up perspective or orthographic by the hook's address.
 * polygonFillHook is read by poly_fill_dispatch (fillDispatch.ts).
 *
 * @portOnly
 */
import type { MeshPolygon, MeshVertex, WorldObject } from '../../generated/classes.gen.ts';
import { unestablished } from '../../core/provenance.ts';
import { HOOK, renderOptions } from '../../sim/display/renderState.ts';
import { polygonResolveColour, type LightLatch } from '../shading/polygonColour.ts';
import { mapPolygonColour } from '../shading/mapColour.ts';
import { mapObjectCull, objectCullBackdrop, objectCullMainView, objectViewCull } from './drawPipeline.ts';

export type CullFn = (obj: WorldObject) => number;
export type ColourFn = (poly: MeshPolygon, vertices: MeshVertex[], code: number, depth: number, L: LightLatch) => number;

/** The cull hook at 0x3f970, the cockpit shell's: 1 for an object with flags bit 0x1000, else 0 (it leaves objectViewDepth alone). */
export function objectCullCockpit(obj: WorldObject): number {
  return (obj.flags & 0x1000) !== 0 ? 1 : 0;
}

const CULLS = new Map<number, CullFn>([
  [HOOK.objectCullMainView, objectCullMainView],
  [HOOK.objectViewCull, objectViewCull],
  [HOOK.mapObjectCull, mapObjectCull],
  [0x3f780, objectCullBackdrop],
  [0x3f970, objectCullCockpit],
]);

const COLOURS = new Map<number, ColourFn>([
  [HOOK.polygonResolveColour, polygonResolveColour],
  [HOOK.mapPolygonColour, (poly, _v, code) => mapPolygonColour(poly, code)],
]);

/** The port of objectCullHook's current function. */
export function objectCullHook(): CullFn {
  const a = renderOptions.objectCullHook;
  const f = CULLS.get(a);
  if (f) return f;
  unestablished(`objectCullHook 0x${a.toString(16)} is not ported; object_cull_main_view used`, 'render_object_list');
  return objectCullMainView;
}

/** The port of polygonDrawHook's current function. */
export function polygonDrawHook(): ColourFn {
  const a = renderOptions.polygonDrawHook;
  const f = COLOURS.get(a);
  if (f) return f;
  unestablished(`polygonDrawHook 0x${a.toString(16)} is not ported; polygon_resolve_colour used`, 'poly_clip_and_queue');
  return polygonResolveColour;
}

/** Whether clipProjectHook is ortho_clip_project (the map's orthographic view). */
export function projectionIsOrtho(): boolean {
  return renderOptions.clipProjectHook === HOOK.orthoClipProject;
}
