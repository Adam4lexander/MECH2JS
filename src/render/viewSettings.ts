/**
 * How far out the Modern view (and a headset, which is always modern) draws,
 * tuned by the pilot and remembered (localStorage, as the loop rate is).
 * Faithful keeps the original's distances.
 *
 * viewDistance: how far out things are drawn, as a multiple of the mission's
 * far distance (Viewer.farClip, which the chunk sets per mission): the
 * object cull's far sphere and the clipper's far limit, on the viewer the
 * renderer culls for (farther) - never the game's own viewer, which the sim
 * reads. 1 is the original's: tuned for a 320- or 640-wide screen, where
 * what pops in at the far distance is a few pixels; at native resolution or
 * in a headset it is a building appearing out of thin air.
 *
 * detail: how far out every LOD step is pushed (projection.ts
 * lodDistanceScale) - the meshes' detail steps and mech_lod_update's
 * ranges. 1 is the original's; its steps, chosen for the same small screen,
 * pop close in at higher resolutions.
 *
 * (Correction: both were first VR-only settings, in xrSettings.ts; the flat
 * Modern view popped just the same.)
 *
 * @portOnly
 */
import type { Viewer } from '../generated/classes.gen.ts';

export interface ViewSettings {
  viewDistance: number;
  detail: number;
}

export const VIEW_DEFAULTS: ViewSettings = { viewDistance: 3, detail: 3 };

const KEY = 'mw2.view';
/** where they were remembered while they were VR settings */
const OLD_KEY = 'mw2.vr';

export function recallViewSettings(): ViewSettings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY) ?? '{}') as Partial<ViewSettings>;
    return { viewDistance: num(s.viewDistance, VIEW_DEFAULTS.viewDistance), detail: num(s.detail, VIEW_DEFAULTS.detail) };
  } catch {
    return { ...VIEW_DEFAULTS };
  }
}

export function storeViewSettings(s: ViewSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window: not remembered */
  }
}

/**
 * `v`'s far distance times `k`, in place: the cull's far sphere (+0xb4) and
 * the clipper's far limit, which it latches times 4 - so kept under 2^29 cm.
 * `v` is always a copy (the renderer's), never the game's own viewer.
 */
export function farther(v: Viewer, k: number): Viewer {
  if (k === 1) return v;
  const far = (cm: number) => Math.min(0x1fffffff, Math.max(0, Math.round(cm * k))) | 0;
  v.farClip = far(v.farClip);
  v.field_0xb4 = far(v.field_0xb4);
  return v;
}
