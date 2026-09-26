/**
 * The menus' callbacks (ui_callbacks, and the calibration part of
 * project_tables): what the MENU modules' tables point at.
 *
 *  - the lance menus (MENU 6, 7, 8): the onloads that fit the menu to the
 *    lance, the Status line's target name, the six orders and the formation;
 *  - the user menu (MENU 5): light amplification, image enhancement, HUD,
 *    auto eject - each keyed by the player command that toggles it;
 *  - Combat Variables (MENU 4): the detail options, also applied from
 *    mw2snd.cfg once at start-up;
 *  - Abort Mission and Flee to DOS (MENU 4);
 *  - Device Calibration (MENU 4): the device list and the brightness slider
 *    (world/brightness.ts). The Audio Ctrl sliders are sound/options.ts.
 */
import { unestablished } from '../../core/provenance.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32s } from '../../engine/image.ts';
import { sceneryC0SetVisible } from '../../engine/scene/objectLists.ts';
import type { Menu, MenuContext, MenuControl, MenuItem } from '../../generated/classes.gen.ts';
import { MenuItem as MenuItemClass } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { trackedGlobals } from '../ai/tracked.ts';
import { lodQualityIsHigh, lodQualitySet } from '../camera/projection.ts';
import { hud } from '../cockpit/hud.ts';
import { input } from '../controls/input.ts';
import { layoutPaneInPane } from '../display/layout.ts';
import { renderOptions, textureTypeEnabled, textureTypeSetEnabled, texturePerspectiveEnabled, texturePerspectiveSet } from '../display/renderState.ts';
import { defaultCanvas } from '../display/video.ts';
import { groupGetFormation, groupSetFormation } from '../groups/formations.ts';
import { aiCombatSub0246b0, lanceMechForSlot, lanceOrderIssue } from '../groups/orders.ts';
import { mechEject } from '../mech/damage.ts';
import { mechRuntime } from '../mech/mechRuntime.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { sound } from '../sound/mixer.ts';
import { soundCuePlay } from '../sound/voice.ts';
import { things } from '../things/gameThings.ts';
import { vfxFontSub0150e0, vfxFontSub0150f0 } from '../world/dayCycle.ts';
import { lighting } from '../world/environment.ts';
import { scrounge, scroungeDetach } from '../world/scrounge.ts';
import { debrisEnabled, debrisSetEnabled } from '../world/worldRecords.ts';
import { commandExecute, commandGlobals } from './commands.ts';
import type { MenuListData, MenuPanesData } from './menuLoad.ts';
import { uiContextClearAll } from './menus.ts';
import { ui } from './uiContext.ts';
import '../sound/options.ts';
import '../world/brightness.ts';


export const lanceMenu = registerGlobals(
  'lanceMenu',
  {
    /** 0x959a4: which order menu entry (1..6) each lance slot was last given, shown as its Status */
    lanceOrderSelected: new Int32Array(5),
  },
  () => {
    lanceMenu.lanceOrderSelected = Int32Array.from(imageI32s(LABEL.lanceOrderSelected, 5, [0, 0, 0, 0, 0]));
  },
);

/** A 0x11-byte item record copied over another (the onloads' rep movsd + movsb). */
function copyItem(src: MenuItem): MenuItem {
  const d = new MenuItemClass();
  d.type = src.type;
  d.label = src.label;
  d.draw = src.draw;
  d.control = src.control;
  d.submenu = src.submenu;
  return d;
}

/** lance_mech_for_slot's result as the callers test it: an unsigned index below mechCount. */
function lanceMech(slot: number): number {
  const m = lanceMechForSlot(slot);
  return m >>> 0 < mechs.mechCount >>> 0 ? m : -1;
}

/**
 * Zeroes the request byte of the context with that id. The lance orders
 * pass 1, which no context has.
 *
 * @mw2 ui_context_clear_request 0x00017ca0
 * @fidelity exact
 */
export function uiContextClearRequest(contextId: number): void {
  let c = ui.uiContextHead;
  while (c && c.id !== contextId) c = c.next;
  if (c) c.request = 0;
}

/**
 * MENU 6's onload: the menu cut to the lance - Change Formation, one
 * Command Point per lancemate (not enterable when its mech's aiState is
 * 0xc), Command All, exit - or 'NO STAR MATES' and exit.
 *
 * @mw2 lance_menu_onload 0x000196b0
 * @fidelity exact
 */
export const lanceMenuOnload = registerCode('lance_menu_onload', 0x196b0, (_ctx: MenuContext, menu: Menu | null): number => {
  if (!menu) return 0;
  const n = aiCombatSub0246b0();
  let dead = 0;
  if (n !== 1) {
    menu.items[n] = copyItem(menu.items[5]!);
    menu.items[n + 1] = copyItem(menu.items[6]!);
    menu.count = n + 2;
    for (let i = 0; i < n - 1; i++) {
      const m = lanceMech(i + 1);
      if (m !== -1 && mechs.mechTable[m]!.aiState === 0xc) {
        menu.items[i + 1]!.type = 1;
        dead++;
      }
    }
  }
  if (n === 1 || n - 1 === dead) {
    menu.items[0] = copyItem(menu.items[7]!);
    menu.items[1] = copyItem(menu.items[6]!);
    menu.count = 2;
  }
  return 1;
});

/**
 * A lancemate's order menu: when its slot (menu +5) is past the lance or
 * its mech is in aiState 0xc, the menu becomes the spare item after the
 * list and the exit item.
 *
 * @mw2 lance_point_menu_onload 0x00019790
 * @fidelity exact
 */
export const lancePointMenuOnload = registerCode('lance_point_menu_onload', 0x19790, (_ctx: MenuContext, menu: Menu | null): number => {
  if (!menu) return 0;
  const slot = menu.slot;
  let ok = slot >>> 0 <= (aiCombatSub0246b0() - 1) >>> 0;
  if (ok) {
    const m = lanceMech(slot);
    ok = m !== -1 && mechs.mechTable[m]!.aiState !== 0xc;
  }
  if (!ok) {
    const spare = menu.items[menu.count];
    if (!spare) unestablished('lance_point_menu_onload: no item record after the list', 'lance_point_menu_onload');
    menu.items[0] = copyItem(spare ?? new MenuItemClass());
    menu.items[1] = copyItem(menu.items[menu.count - 1]!);
    menu.count = 2;
  }
  return 1;
});

/**
 * @mw2 lance_order_selected 0x00019830
 * @fidelity exact
 */
export const lanceOrderSelected = registerCode('lance_order_selected', 0x19830, (slot: number): number => {
  if (slot >= 5) return 7;
  if (slot < 0) unestablished('lance_order_selected: a negative slot reads before the table', 'lance_order_selected');
  return lanceMenu.lanceOrderSelected[slot] ?? 0;
});

/**
 * @mw2 lance_get_formation 0x00019850
 * @fidelity exact
 */
export const lanceGetFormation = registerCode('lance_get_formation', 0x19850, (): number => groupGetFormation(mechs.playerGroupIndex));

/**
 * @mw2 lance_set_formation 0x00019860
 * @fidelity exact
 */
export const lanceSetFormation = registerCode('lance_set_formation', 0x19860, (formation: number): void => {
  lanceMenu.lanceOrderSelected[0] = 0;
  groupSetFormation(mechs.playerGroupIndex, formation);
  uiContextClearRequest(1);
});

/**
 * The aiState of the slot's mech plus one - 0 for no mech.
 *
 * @mw2 lance_slot_ai_state 0x00019890
 * @fidelity exact
 */
export const lanceSlotAiState = registerCode('lance_slot_ai_state', 0x19890, (slot: number): number => {
  let s = -1;
  if (slot < 5) {
    const m = lanceMechForSlot(slot);
    if (m !== -1) {
      const e = mechs.mechTable[m];
      if (!e) unestablished('lance_slot_ai_state: an empty mechTable slot, read through a null pointer', 'lance_slot_ai_state');
      else s = e.aiState;
    }
  }
  return (s + 1) | 0;
});

/**
 * The order items' init: the control's selector becomes the menu's slot.
 *
 * @mw2 lance_control_slot_init 0x000198c0
 * @fidelity exact
 */
export const lanceControlSlotInit = registerCode('lance_control_slot_init', 0x198c0, (menu: Menu | null, c: MenuControl | null): void => {
  if (menu && c) c.selector = menu.slot;
});

/**
 * What the slot's mech is shooting at: the name of its targetSecondary - a
 * tracked object (1), a mech (2) or a gamething (4) - or null for an empty
 * slot or a mech in aiState 5 (follow).
 *
 * @mw2 lance_slot_target_name 0x00019a20
 * @fidelity exact
 */
export const lanceSlotTargetName = registerCode('lance_slot_target_name', 0x19a20, (_ctx: MenuContext, c: MenuControl): string | null => {
  const m = lanceMechForSlot(c.selector);
  if (m >>> 0 >= mechs.mechCount >>> 0) return null;
  const e = mechs.mechTable[m]!;
  if (e.aiState === 5) return null;
  const h = e.targetSecondary & 0xffff;
  const i = h & 0xff;
  switch ((h >> 8) & 0xf) {
    case 1:
      return trackedGlobals.trackedObjects[i]?.name ?? null;
    case 2:
      return mechs.mechTable[i]?.name ?? null;
    case 4:
      return things.gameThings[i]?.name ?? null;
    default:
      return null;
  }
});

/**
 * The Status line's init: its list's suffix callback is
 * lance_slot_target_name (the pointer at 0x95988).
 *
 * @mw2 lance_status_init 0x000198e0
 * @fidelity exact
 */
export const lanceStatusInit = registerCode('lance_status_init', 0x198e0, (menu: Menu | null, c: MenuControl | null): void => {
  if (menu && c && c.data) (c.data as MenuListData).suffix = lanceSlotTargetName;
});

function lanceOrder(slot: number, entry: number, order: number): void {
  if (slot < 5) {
    lanceMenu.lanceOrderSelected[slot] = entry;
    lanceOrderIssue(slot, order);
  }
  uiContextClearRequest(1);
}

/**
 * @mw2 lance_order_target 0x00019900
 * @fidelity exact
 */
export const lanceOrderTarget = registerCode('lance_order_target', 0x19900, (slot: number): void => lanceOrder(slot, 2, 2));

/**
 * @mw2 lance_order_attack 0x00019930
 * @fidelity exact
 */
export const lanceOrderAttack = registerCode('lance_order_attack', 0x19930, (slot: number): void => lanceOrder(slot, 1, 3));

/**
 * @mw2 lance_order_follow 0x00019960
 * @fidelity exact
 */
export const lanceOrderFollow = registerCode('lance_order_follow', 0x19960, (slot: number): void => lanceOrder(slot, 3, 5));

/**
 * @mw2 lance_order_patrol 0x00019990
 * @fidelity exact
 */
export const lanceOrderPatrol = registerCode('lance_order_patrol', 0x19990, (slot: number): void => lanceOrder(slot, 4, 7));

/**
 * @mw2 lance_order_godirect 0x000199c0
 * @fidelity exact
 */
export const lanceOrderGodirect = registerCode('lance_order_godirect', 0x199c0, (slot: number): void => lanceOrder(slot, 5, 8));

/**
 * @mw2 lance_order_shutdown 0x000199f0
 * @fidelity exact
 */
export const lanceOrderShutdown = registerCode('lance_order_shutdown', 0x199f0, (slot: number): void => lanceOrder(slot, 6, 0xb));

/**
 * The user menu's settings, keyed by the player command that toggles each.
 *
 * @mw2 user_option_get 0x00019ab0
 * @fidelity exact
 */
export const userOptionGet = registerCode('user_option_get', 0x19ab0, (selector: number): number => {
  switch (selector >>> 0) {
    case 0x13:
      return hud.hudEnabled;
    case 0x3c:
      return mechRuntime.autoEjectEnabled;
    case 0x40:
      return commandGlobals.shutdownOverrideRequest;
    case 0x9d:
      return vfxFontSub0150e0();
    case 0x9e:
      return renderOptions.wireframeMode === 1 ? 1 : 0;
    default:
      return 0;
  }
});

/**
 * @mw2 user_option_set 0x00019b20
 * @fidelity exact
 */
export const userOptionSet = registerCode('user_option_set', 0x19b20, (selector: number, value: number): void => {
  switch (selector >>> 0) {
    case 0x13:
      hud.hudEnabled = value;
      break;
    case 0x3c:
      mechRuntime.autoEjectEnabled = value;
      break;
    case 0x40:
      commandGlobals.shutdownOverrideRequest = value;
      break;
    case 0x9d:
      vfxFontSub0150f0(0, value);
      break;
    case 0x9e:
      if (value !== 0) {
        renderOptions.wireframeMode = 1;
        soundCuePlay(0x1b, 1);
      } else renderOptions.wireframeMode = value;
      break;
  }
});

/** mw2snd.cfg's image, which main loads before anything runs. */
function cfgBuffer(): Int32Array {
  const b = sound.soundConfigBuffer;
  if (!b) throw new Error('soundConfigBuffer is not loaded');
  return b;
}

/**
 * The detail options from mw2snd.cfg's image: object textures (+0x14),
 * terrain textures (+0x18), display detail (+0x1c), object density
 * (+0x20), explosion chunks (+0x24).
 *
 * @mw2 detail_options_apply 0x00019bb0
 * @fidelity exact
 */
export const detailOptionsApply = registerCode('detail_options_apply', 0x19bb0, (): number => {
  const b = sound.soundConfigBuffer;
  if (b) {
    textureTypeSetEnabled(0x100, b[5]!);
    textureTypeSetEnabled(0x200, b[5]!);
    textureTypeSetEnabled(0x800, b[6]!);
    scroungeDetach(b[6]!);
    lodQualitySet(1, b[7]!);
    texturePerspectiveSet(1, b[7]!);
    sceneryC0SetVisible(b[8]!);
    debrisSetEnabled(1, b[9]!);
  }
  return 1;
});

/**
 * main, before the frame loop: detail_options_apply.
 *
 * @mw2 detail_options_apply_thunk 0x00019ba0
 * @fidelity exact
 */
export function detailOptionsApplyThunk(): void {
  detailOptionsApply();
}

/**
 * @mw2 detail_object_textures_get 0x00019c50
 * @fidelity exact
 */
export const detailObjectTexturesGet = registerCode('detail_object_textures_get', 0x19c50, (): number =>
  textureTypeEnabled(0x100) === 0 && textureTypeEnabled(0x200) === 0 ? 0 : 1,
);

/**
 * @mw2 detail_object_textures_set 0x00019c80
 * @fidelity exact
 */
export const detailObjectTexturesSet = registerCode('detail_object_textures_set', 0x19c80, (_selector: number, value: number): void => {
  textureTypeSetEnabled(0x100, value);
  textureTypeSetEnabled(0x200, value);
  cfgBuffer()[5] = value;
});

/**
 * @mw2 detail_terrain_textures_get 0x00019cb0
 * @fidelity exact
 */
export const detailTerrainTexturesGet = registerCode('detail_terrain_textures_get', 0x19cb0, (): number =>
  textureTypeEnabled(0x800) !== 0 || scrounge.scroungeActive !== 0 ? 1 : 0,
);

/**
 * @mw2 detail_terrain_textures_set 0x00019ce0
 * @fidelity exact
 */
export const detailTerrainTexturesSet = registerCode('detail_terrain_textures_set', 0x19ce0, (_selector: number, value: number): void => {
  textureTypeSetEnabled(0x800, value);
  scroungeDetach(value);
  cfgBuffer()[6] = value;
});

/**
 * @mw2 detail_display_get 0x00019d10
 * @fidelity exact
 */
export const detailDisplayGet = registerCode('detail_display_get', 0x19d10, (): number => (lodQualityIsHigh() || texturePerspectiveEnabled() !== 0 ? 1 : 0));

/**
 * @mw2 detail_display_set 0x00019d40
 * @fidelity exact
 */
export const detailDisplaySet = registerCode('detail_display_set', 0x19d40, (selector: number, value: number): void => {
  lodQualitySet(selector, value);
  texturePerspectiveSet(selector, value);
  cfgBuffer()[7] = value;
});

/**
 * @mw2 detail_density_get 0x00019d70
 * @fidelity exact
 */
export const detailDensityGet = registerCode('detail_density_get', 0x19d70, (): number => cfgBuffer()[8]!);

/**
 * @mw2 detail_density_set 0x00019d80
 * @fidelity exact
 */
export const detailDensitySet = registerCode('detail_density_set', 0x19d80, (_selector: number, value: number): void => {
  sceneryC0SetVisible(value);
  cfgBuffer()[8] = value;
});

/** The explosion-chunks item's get and commit are debris_enabled and debris_set_enabled themselves. */
registerCode('debris_enabled', 0x36d60, debrisEnabled);
registerCode('debris_set_enabled', 0x36d70, debrisSetEnabled);

/** Enter on the selected item, or its hotkey. */
function chosen(index: number, menu: Menu | null): boolean {
  return !!menu && ((index === menu.selected && ui.menuKeyPending === 0xd) || index === ui.menuKeyPending - 0x31);
}

/**
 * 'Accept (Esc to cancel)' under Abort Mission: the invulnerability cheat
 * cleared, EJECT run with ejectDisabled lifted for the call, and every ui
 * context torn down.
 *
 * @mw2 menu_item_abort_mission 0x00019da0
 * @fidelity exact
 */
export const menuItemAbortMission = registerCode('menu_item_abort_mission', 0x19da0, (_ctx: MenuContext, _c: MenuControl | null, index: number, _item: MenuItem, _x: number, _y: number, menu: Menu | null): void => {
  if (!menu || !chosen(index, menu)) return;
  mechs.simOptions.invulnerability = 0;
  const saved = lighting.ejectDisabled;
  lighting.ejectDisabled = 0;
  commandExecute(0x3b);
  lighting.ejectDisabled = saved;
  uiContextClearAll();
});

/**
 * 'Accept (Esc to cancel)' under Flee to DOS: fleeToDos set (main exits
 * with 0xff), the invulnerability cheat cleared, the player's mech ejected
 * and every ui context torn down.
 *
 * @mw2 menu_item_flee_to_dos 0x00019e10
 * @fidelity exact
 */
export const menuItemFleeToDos = registerCode('menu_item_flee_to_dos', 0x19e10, (_ctx: MenuContext, _c: MenuControl | null, index: number, _item: MenuItem, _x: number, _y: number, menu: Menu | null): void => {
  if (!menu || !chosen(index, menu)) return;
  ui.fleeToDos = 1;
  mechs.simOptions.invulnerability = 0;
  mechEject(mechs.mechTable[mechs.playerMechIndex]!.loadout!, 0);
  uiContextClearAll();
});

/**
 * Input device record i (0x152bf8 + i * 0x34), or null past the devices.
 *
 * @mw2 input_sub_048cb0 0x00048cb0
 * @fidelity exact
 */
export function inputSub048cb0(i: number): (typeof input.devices)[number] | null {
  return i >= 0 && i < input.devices.length ? input.devices[i]! : null;
}

/**
 * Device Calibration's onload: an item per calibratable device (analog
 * channels, and the record's +0x24 word), then the Monitor Brightness
 * slider (item 8) copied after them and the count set to devices + 2 - the
 * stored item after the slider's copy is the exit.
 *
 * @mw2 menu_calibration_onload 0x000191a0
 * @fidelity exact
 * @divergence the device record's +0xc (name) and +0x24 are not modelled: neither shipped GIDDI driver's init writes them, so they stay 0 and no device is listed
 */
export const menuCalibrationOnload = registerCode('menu_calibration_onload', 0x191a0, (ctx: MenuContext, menu: Menu): number => {
  let ok = 1;
  let k = 0;
  for (let dev = 0; ; dev++) {
    const d = inputSub048cb0(dev);
    if (!d || menu.count - 3 <= k || ok === 0) break;
    const calibratable = 0; // record +0x24
    if (d.record.analogCount !== 0 && calibratable !== 0) {
      const it = menu.items[k]!;
      it.type = 0;
      it.label = d.name;
      ok = 0;
      const sub = it.submenu;
      const c = sub?.items[0]?.control ?? null;
      const data = c?.data as MenuPanesData | undefined;
      if (sub && c && data && data.pane1 && data.pane0) {
        sub.title = d.name;
        c.selector = dev;
        for (const p of [data.pane1, data.pane0]) {
          if (!p.canvas) {
            p.canvas = defaultCanvas;
            layoutPaneInPane(ctx.pane!, p, p);
          }
        }
        ok = 1;
        data.device = d;
      }
      k++;
    }
  }
  menu.items[k] = copyItem(menu.items[8]!);
  menu.count = k + 2;
  return ok;
});

/**
 * A device's calibration run inside the menu, then accept. Not reached:
 * no shipped device is listed (menu_calibration_onload).
 *
 * @mw2 menu_item_calibrate 0x000192d0
 * @fidelity stub
 * @divergence the calibration loop (input_sub_048cd0 / _048ce0 / _048d90) is not ported
 */
export const menuItemCalibrate = registerCode('menu_item_calibrate', 0x192d0, (): void => {
  unestablished('menu_item_calibrate: a device calibration was started, and it is not ported', 'menu_item_calibrate');
});
