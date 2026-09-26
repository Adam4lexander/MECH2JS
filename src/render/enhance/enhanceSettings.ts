/**
 * The port's detail enhancements, each switchable and remembered
 * (localStorage, as the loop rate and the VR sizes are). They add detail in
 * the game's own terms - palette indices chosen by ramp, shade step, LUMA row
 * and the checkerboard dither - and apply to the main view only: the inset
 * views the game reads back into its window (the target display, the damage
 * display's views, the map) stay the original's.
 *
 *   mechPanels   armour panels on mechs: faces split into plates a shade step
 *                apart with darker seams (materials/indexedMaterial.ts)
 *   mechsAllTop  every mech inside mech_lod_update's nearest range at its top
 *                detail level, not only the nearest (sim/camera/projection.ts
 *                lodAllNear)
 *   ground       the flat ground as a dithered surface on its own ramp, and the
 *                game's scrounge patch repeated round the player (groundField.ts)
 *   sky          the sky as a dithered gradient up its ramp, stars at night
 *   shadows      shadows from the mission's light, each colour darkened within
 *                its own ramp (shadows.ts)
 *   cockpit      a hand-built cockpit for each chassis, the game's displays on
 *                its screens (render/cockpit), in the headset and on the flat
 *                screen
 *
 * @portOnly
 */
export interface EnhanceSettings {
  mechPanels: boolean;
  mechsAllTop: boolean;
  ground: boolean;
  sky: boolean;
  shadows: boolean;
  cockpit: boolean;
}

export const ENHANCE_DEFAULTS: EnhanceSettings = { mechPanels: true, mechsAllTop: true, ground: true, sky: true, shadows: true, cockpit: true };

export const ENHANCE_LABELS: Record<keyof EnhanceSettings, string> = {
  mechPanels: 'armour panels',
  mechsAllTop: 'all near mechs at top detail',
  ground: 'ground detail',
  sky: 'sky gradient and stars',
  shadows: 'shadows',
  cockpit: 'cockpits',
};

const KEY = 'mw2.enhance';

export function recallEnhanceSettings(): EnhanceSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof EnhanceSettings, unknown>>;
    const out = { ...ENHANCE_DEFAULTS };
    for (const k of Object.keys(out) as Array<keyof EnhanceSettings>) if (typeof s[k] === 'boolean') out[k] = s[k];
    return out;
  } catch {
    return { ...ENHANCE_DEFAULTS };
  }
}

export function storeEnhanceSettings(s: EnhanceSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window: not remembered */
  }
}
