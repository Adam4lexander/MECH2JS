/**
 * hudWidgets (0xfe140), the 24 HudWidget pointers, on their own so that
 * code outside the HUD that only reaches into the widgets (mech damage's
 * display damage, sound_res_sub_032f70) need not import the HUD and all it
 * draws with - an import cycle through hud.ts defeats the test mocks of the
 * modules on it.
 *
 * @portOnly the array hud.hudWidgets is
 */
import type { HudWidget } from '../../generated/classes.gen.ts';

/** One array for the life of the port; hud's reset empties it. */
export const hudWidgetTable: (HudWidget | null)[] = new Array<HudWidget | null>(0x18).fill(null);
