/**
 * The VR view's sizes, tuned by the pilot and remembered (localStorage, as
 * the loop rate is).
 *
 * cockpitScale: the cockpit shell's size about the eye. The shell is modelled
 * at the mech's own scale - measured in AMY_SCN1 its vertices lie 2.7 m to
 * 11.5 m from the eye (median 6.3 m), wrapping round to +/-156 degrees and
 * down to -84, the mech's head and torso about the pilot - so at 1 it is a
 * room-sized canopy. 0.35 puts its nearest parts under a metre away.
 * (The first cut assumed a shell a few centimetres from the eye, confusing
 * it with its 8 cm near clip, and enlarged it 8x: a hangar.)
 *
 * hudScale: the HUD's width as a share of the game's field of view. At 1 its
 * corners (the radar, the weapon list) stand 45 degrees off the nose; below
 * 1 they come in. The reticle and the target marker are not on this plane
 * (xrRig.ts placeLifted draws them in the world, where they register at any
 * hudScale).
 *
 * hudDistance: metres ahead of the eye. Drawn over the cockpit, the HUD
 * reads best just in front of its nearest parts.
 *
 * dashDrop: how far below its place the hand-built cockpit sits
 * (render/cockpit), metres - for a pilot sitting taller or shorter.
 *
 * detail: how far out every LOD step is pushed (projection.ts
 * lodDistanceScale) while in VR - the meshes' detail steps and
 * mech_lod_update's ranges. 1 is the original's; its steps, chosen for a
 * 320- or 640-wide screen, pop close in at a headset's resolution.
 *
 * viewDistance: how far out things are drawn while in VR, as a multiple of
 * the mission's far distance (Viewer.farClip, which the chunk sets per
 * mission): the object cull's far sphere and the clipper's far limit, on the
 * viewer the headset culls for (xrRig.ts cullViewer) - the game's own viewer
 * and the flat view keep the original's. 1 is the original's: tuned for a
 * small screen, where what pops in at the far distance is a few pixels, and
 * in a headset it is a building appearing out of thin air.
 *
 * @portOnly
 */
export interface XrSettings {
  cockpitScale: number;
  hudScale: number;
  hudDistance: number;
  detail: number;
  dashDrop: number;
  viewDistance: number;
}

export const XR_DEFAULTS: XrSettings = { cockpitScale: 0.35, hudScale: 0.6, hudDistance: 1.2, detail: 3, dashDrop: 0, viewDistance: 3 };

const KEY = 'mw2.vr';

export function recallXrSettings(): XrSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<XrSettings>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
    return {
      cockpitScale: num(s.cockpitScale, XR_DEFAULTS.cockpitScale),
      hudScale: num(s.hudScale, XR_DEFAULTS.hudScale),
      hudDistance: num(s.hudDistance, XR_DEFAULTS.hudDistance),
      detail: num(s.detail, XR_DEFAULTS.detail),
      viewDistance: num(s.viewDistance, XR_DEFAULTS.viewDistance),
      dashDrop: typeof s.dashDrop === 'number' && Number.isFinite(s.dashDrop) ? s.dashDrop : XR_DEFAULTS.dashDrop,
    };
  } catch {
    return { ...XR_DEFAULTS };
  }
}

export function storeXrSettings(s: XrSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window: not remembered */
  }
}
