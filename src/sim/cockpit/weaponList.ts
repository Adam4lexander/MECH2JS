/**
 * The weapon list (hudWidgets 3..12): one line per weapon, handed out by
 * loadout_regroup_weapons - label (the weapon type's name), weapon index and
 * these two hooks.
 */
import type { HudWidget } from '../../generated/classes.gen.ts';
import { quirk } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { vfxStringDraw } from '../../engine/vfx/vfx.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { display } from '../display/video.ts';
import { vfxPaneFrame } from '../display/layout.ts';
import { loadoutWeapons } from '../mech/loadout.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { hudFont, hudFontUnlock, widgetPane } from './hud.ts';

/** The ink colour byte of the text colour table (0xa4dd2 = 0xa4dc4 + 14). */
const INK = 14;

/**
 * While the mech powers up: once simTick passes the widget's showAfterTick,
 * its label at the pane's origin - so the list appears line by line.
 *
 * @mw2 hud_weapon_widget_powerup 0x0002fbe0
 * @fidelity exact
 */
export const hudWeaponWidgetPowerup = registerCode('hud_weapon_widget_powerup', 0x2fbe0, (w: HudWidget): void => {
  if (w.visible === 0 || w.weaponIndex < 0) return;
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  if (loadoutWeapons(l)[w.weaponIndex]!.type < 0) return;
  const now = clock.simTick;
  const font = hudFont();
  if (!font) return;
  if (w.visible !== 0 && now > w.showAfterTick) vfxStringDraw(widgetPane(w), 0, 0, font, w.label, display.textColourTable);
  hudFontUnlock();
});

/** The line's ink by the weapon's fireState (the jump table at 0x2fa80) and fireGroup; null where the original leaves it unset. */
function lineColour(fireState: number, fireGroup: number): number | null {
  switch (fireState) {
    case -1:
      return 8;
    case 1:
      if (fireGroup >>> 0 === 0) return 0xe;
      if (fireGroup >>> 0 === 1) return 0xfe;
      if (fireGroup >>> 0 === 2) return 3;
      return null;
    case 2:
      return 0xe;
    default:
      return 0xb;
  }
}

let lastColour = 0xe;

/**
 * While running: the weapon's name, with its ammo when it uses any ("%s" or
 * "%s %d"), at the widget's text position, inked by its state - 8 out of
 * ammo, 0xb cooling, 0xe firing, and when ready 0xe / 0xfe / 3 for fire
 * group 0 / 1 / 2 - and framed in the same colour when it is the selected
 * weapon.
 *
 * @mw2 hud_weapon_widget_tick 0x0002fa90
 * @fidelity exact
 * @divergence a ready weapon in a fire group above 2 has no colour in the original (the stack local is left as it was); the port keeps the last line's colour - weapon_set_fire_group refuses groups above 2, so it does not arise
 */
export const hudWeaponWidgetTick = registerCode('hud_weapon_widget_tick', 0x2fa90, (w: HudWidget): void => {
  if (w.visible === 0 || w.weaponIndex < 0) return;
  const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
  const wp = loadoutWeapons(l)[w.weaponIndex]!;
  if (wp.type < 0) return;
  let colour = lineColour(wp.fireState, wp.fireGroup);
  if (colour === null) {
    quirk('hud_weapon_widget_tick: a ready weapon in a fire group above 2 leaves the colour unset', 'hud_weapon_widget_tick');
    colour = lastColour;
  }
  lastColour = colour;
  const font = hudFont();
  if (font) {
    display.textColourTable[INK] = colour & 0xff;
    const text = wp.ammo < 0 ? w.label : `${w.label} ${wp.ammo}`;
    const p = w.textPos as Int32Array;
    vfxStringDraw(widgetPane(w), p[0]!, p[1]!, font, text, display.textColourTable);
    display.textColourTable[INK] = 0xe;
    hudFontUnlock();
  }
  if (w.weaponIndex === l.selectedWeapon) vfxPaneFrame(widgetPane(w), colour & 0xff);
});
