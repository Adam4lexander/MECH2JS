/**
 * The mech lab's widget-panel functions: the draw and click functions its
 * tables (mechlabDesignPanel, mechlabCustomizingPanel and the eight
 * component panels) point at, registered under their addresses for the
 * widget engine (shell/ui/widgets.ts). decompiled/mw2shell/src/screens/
 * shell_2a5e0_part1.c and part2.c; README "CUSTOMIZE: the summary and its
 * component panels".
 *
 * A draw function sprintf's into mechlabText and puts the text up with
 * label_create in uiFont (font27 for draw_title) at the row's (x, y) in the
 * row's text style; the label it returns is the row's. A click function
 * gets the row (its value at +0x24, its extra at +0x28).
 */
import { SHELL_LABEL as L } from '../../generated/shell/labels.gen.ts';
import { cdiv, cmod } from '../../core/int/cint.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { mem } from '../memory.ts';
import { mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { animSetFlags, animSetFrame, animMove, animUnhide } from '../anim/anims.ts';
import { labelCreate, labelCreateUnder, labelDestroy, remapAt, type TextLabel } from '../ui/labels.ts';
import { mouseDoubleClicked } from '../ui/mouse.ts';
import { messageBox } from '../ui/messageBox.ts';
import { textInput } from '../ui/textInput.ts';
import { soundSamplePlay, type Sample } from '../sound/samples.ts';
import {
  registerWidgetClick,
  registerWidgetDraw,
  setWidgetLabel,
  widgetField,
  widgetLabel,
  widgetPanelLayout,
  widgetPanelRedraw,
  widgetTextStyle,
  WIDGET,
  WIDGET_ROW,
  type WidgetClickFn,
} from '../ui/widgets.ts';
import {
  ammo,
  ITEM,
  crit,
  engineRow,
  g,
  itemField,
  itemName,
  locField,
  mechlabAddAmmo,
  mechlabAddArmour,
  mechlabAddHeatSink,
  mechlabAddItemAndRecompute,
  mechlabAddJumpJet,
  mechlabArmourFrontDown,
  mechlabArmourFrontUp,
  mechlabArmourRearDown,
  mechlabArmourRearUp,
  mechlabDeleteAmmo,
  mechlabDeleteArmour,
  mechlabDeleteHeatSink,
  mechlabDeleteJumpJet,
  mechlabEngineFaster,
  mechlabEngineSlower,
  mechlabPlaceUnplaced,
  mechlabRemoveItemAndRecompute,
  mechlabToggleEndoSteel,
  mechlabToggleEquipment,
  mechlabToggleFerroFibrous,
  mechlabToggleHeatSinkType,
  mechlabToggleXlEngine,
  mechlabUnplaceSlot,
  s,
  unplacedCriticals,
  unplacedItem,
} from './design.ts';

export const mechlabUi = registerGlobals(
  'mechlabUi',
  {
    /** 0xa5938: DATABASE.MW2 item 80 as a sample, played by the location clicks; screen_mechlab creates it */
    clickSample: null as Sample | null,
  },
  () => {
    mechlabUi.clickSample = null;
  },
  'mw2shell',
);

/** mechlabText's new contents (the sprintf every draw function makes), returned for the label. */
function text(t: string): string {
  mem().strcpy(L.mechlabText, t);
  return t;
}

/** label_create(uiFont, row.x, row.y, t, style). */
function put(row: number, t: string | null, style: Uint8Array | null = widgetTextStyle(row)): TextLabel {
  return labelCreate(shell.uiFont!, widgetField(row, 'x'), widgetField(row, 'y'), t, style);
}

/** *row.value: the int the row's value points at. */
function valueInt(row: number): number {
  return g(widgetField(row, 'value') >>> 0);
}

/** '%d.%d%d T' of hundredths of a ton. */
function massText(v: number, format: (a: number, b: number, c: number) => string): string {
  return format(cdiv(v, 100), cmod(cdiv(v, 10), 10), cmod(v, 10));
}

/** A double constant in the image. */
function imageDouble(a: number): number {
  const b = mem().view(a, 8);
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
}

/** A click function that does not block. */
function syncClick(fn: (row: number) => void): WidgetClickFn {
  return function* (row: number): Blocking<void> {
    fn(row);
    yield* [];
  };
}

// ---------------------------------------------------------------- draw

/**
 * The first row of the ARMOR and CRITICALS panels: animation slot 12 (the
 * marker) to frame mechlabLocation at locationMarkerX / Y + (216, 52),
 * shown. No label.
 *
 * @mw2shell mechlab_show_location_marker 0x0002bd20
 * @fidelity exact
 */
export const mechlabShowLocationMarker = registerWidgetDraw('mechlab_show_location_marker', 0x0002bd20, () => {
  const l = g(L.mechlabLocation);
  animSetFrame(0xc, l);
  animMove(0xc, g(L.locationMarkerX + l * 4) + 0xd8, g(L.locationMarkerY + l * 4) + 0x34);
  animUnhide(0xc);
  return null;
});

/**
 * A mass field: *value as '%d.%d%d T'.
 *
 * @mw2shell mechlab_draw_mass 0x0002bd70
 * @fidelity exact
 */
export const mechlabDrawMass = registerWidgetDraw('mechlab_draw_mass', 0x0002bd70, (row) =>
  // 0x76a70 '%d.%d%d T'
  put(row, text(massText(valueInt(row), (a, b, c) => `${a}.${b}${c} T`))),
);

/**
 * Used Mass: the same, in mechlabTextWarning when over designMaxMass.
 *
 * @mw2shell mechlab_draw_used_mass 0x0002bde0
 * @fidelity exact
 */
export const mechlabDrawUsedMass = registerWidgetDraw('mechlab_draw_used_mass', 0x0002bde0, (row) => {
  const v = valueInt(row);
  const style = g(L.designMaxMass) < v ? remapAt(L.mechlabTextWarning) : widgetTextStyle(row);
  // 0x76a7a '%d.%d%d T'
  return put(row, text(massText(v, (a, b, c) => `${a}.${b}${c} T`)), style);
});

/**
 * ENGINE Rating: engineTable[*value % 10000].rating, '%d' or '%dXL'.
 *
 * @mw2shell mechlab_draw_engine_rating 0x0002bed0
 * @fidelity exact
 */
export const mechlabDrawEngineRating = registerWidgetDraw('mechlab_draw_engine_rating', 0x0002bed0, (row) => {
  const v = valueInt(row);
  const r = engineRow(cmod(v, 10000)).rating;
  // 0x76a93 '%d', 0x76a8e '%dXL'
  return put(row, text(v < 10000 ? `${r}` : `${r}XL`));
});

/**
 * ENGINE Type: 'Std' or 'XL'.
 *
 * @mw2shell mechlab_draw_engine_type 0x0002bf40
 * @fidelity exact
 */
export const mechlabDrawEngineType = registerWidgetDraw('mechlab_draw_engine_type', 0x0002bf40, (row) =>
  // 0x76a99 'Std', 0x76a96 'XL'
  put(row, valueInt(row) < 10000 ? 'Std' : 'XL'),
);

/**
 * ENGINE Manufacturer: engineTable[*value % 10000].maker.
 *
 * @mw2shell mechlab_draw_engine_maker 0x0002bf80
 * @fidelity exact
 */
export const mechlabDrawEngineMaker = registerWidgetDraw('mechlab_draw_engine_maker', 0x0002bf80, (row) =>
  // 0x76a9d '%s'
  put(row, text(engineRow(cmod(valueInt(row), 10000)).maker)),
);

/**
 * Walking / Running Speed: *value (MP) x 10.8 as '%1.1f kph'.
 *
 * @mw2shell mechlab_draw_speed 0x0002bfe0
 * @fidelity exact
 * @divergence the product is taken in doubles (the original rounds the x87 product to a double for printf) and printed with toFixed
 */
export const mechlabDrawSpeed = registerWidgetDraw('mechlab_draw_speed', 0x0002bfe0, (row) =>
  // 0x76aa0 '%1.1f kph', 0x76aaa 10.8
  put(row, text(`${(valueInt(row) * imageDouble(0x76aaa)).toFixed(1)} kph`)),
);

/**
 * HEAT SINKS Count: heat-sink tons + 10 (rounded), 'N' for single
 * (*value, the type, 1) or 'N (2N)'.
 *
 * @mw2shell mechlab_draw_heat_sink_count 0x0002c080
 * @fidelity exact
 */
export const mechlabDrawHeatSinkCount = registerWidgetDraw('mechlab_draw_heat_sink_count', 0x0002c080, (row) => {
  const n = cdiv(g(L.designHeatSinkMass) + 0x32, 100) + 10;
  // 0x76ab7 '%d', 0x76aba '%d (%d)'
  return put(row, text(valueInt(row) === 1 ? `${n}` : `${n} (${n * 2})`));
});

/**
 * HEAT SINKS Type: 'Single' for 1, else 'Double'.
 *
 * @mw2shell mechlab_draw_heat_sink_type 0x0002c100
 * @fidelity exact
 */
export const mechlabDrawHeatSinkType = registerWidgetDraw('mechlab_draw_heat_sink_type', 0x0002c100, (row) =>
  // 0x76ac2 'Single', 0x76ac9 'Double'
  put(row, valueInt(row) === 1 ? 'Single' : 'Double'),
);

/**
 * *value as '%d'.
 *
 * @mw2shell mechlab_draw_int 0x0002c130
 * @fidelity exact
 */
export const mechlabDrawInt = registerWidgetDraw('mechlab_draw_int', 0x0002c130, (row) =>
  // 0x76ad0 '%d'
  put(row, text(`${valueInt(row)}`)),
);

/**
 * The plain text row: the string at value, when there is one.
 *
 * @mw2shell mechlab_widget_draw_label 0x0002c1b0
 * @fidelity exact
 */
export const mechlabWidgetDrawLabel = registerWidgetDraw('mechlab_widget_draw_label', 0x0002c1b0, (row) => {
  if (widgetField(row, 'value') === 0) return null;
  return put(row, mem().ptrStr(row + WIDGET.value));
});

/**
 * The same in font27: the summary panels' titles.
 *
 * @mw2shell mechlab_draw_title 0x0002c1e0
 * @fidelity exact
 */
export const mechlabDrawTitle = registerWidgetDraw('mechlab_draw_title', 0x0002c1e0, (row) => {
  if (widgetField(row, 'value') === 0) return null;
  return labelCreate(shell.font27!, widgetField(row, 'x'), widgetField(row, 'y'), mem().ptrStr(row + WIDGET.value), widgetTextStyle(row));
});

/**
 * INTERNAL STRUCTURE Type: 'Std' or 'Endo-S'.
 *
 * @mw2shell mechlab_draw_structure_type 0x0002c210
 * @fidelity exact
 */
export const mechlabDrawStructureType = registerWidgetDraw('mechlab_draw_structure_type', 0x0002c210, (row) =>
  // 0x76ada 'Std', 0x76ad3 'Endo-S'
  put(row, valueInt(row) === 0 ? 'Std' : 'Endo-S'),
);

/**
 * ARMOR Type: 'Std' or 'Ferro-F'.
 *
 * @mw2shell mechlab_draw_armour_type 0x0002c240
 * @fidelity exact
 */
export const mechlabDrawArmourType = registerWidgetDraw('mechlab_draw_armour_type', 0x0002c240, (row) =>
  // 0x76ae6 'Std', 0x76ade 'Ferro-F'
  put(row, valueInt(row) === 0 ? 'Std' : 'Ferro-F'),
);

/**
 * The selected location's front (value 0) or rear (1) points, '~%d';
 * '~--' for a rear of -1.
 *
 * @mw2shell mechlab_draw_selected_armour 0x0002c270
 * @fidelity exact
 */
export const mechlabDrawSelectedArmour = registerWidgetDraw('mechlab_draw_selected_armour', 0x0002c270, (row) => {
  const l = g(L.mechlabLocation);
  let t: string;
  // 0x76af2 '~%d'; 0x76aea '~%d', 0x76aee '~--'
  if (widgetField(row, 'value') === 0) t = `~${locField(l, 'armourFront')}`;
  else t = locField(l, 'armourRear') < 0 ? '~--' : `~${locField(l, 'armourRear')}`;
  return put(row, text(t));
});

/**
 * An ARMOR ALLOCATION row: '~front/rear', or '~front' without rear armour.
 *
 * @mw2shell mechlab_draw_location_armour 0x0002c300
 * @fidelity exact
 */
export const mechlabDrawLocationArmour = registerWidgetDraw('mechlab_draw_location_armour', 0x0002c300, (row) => {
  const l = widgetField(row, 'value');
  // 0x76afd '~%d', 0x76af6 '~%d/%d'
  return put(row, text(locField(l, 'armourRear') < 0 ? `~${locField(l, 'armourFront')}` : `~${locField(l, 'armourFront')}/${locField(l, 'armourRear')}`));
});

/** locationNames[l] */
function locationName(l: number): string {
  return mem().ptrStr(L.locationNames + l * 4) ?? '';
}

/**
 * An ARMOR ALLOCATION row's name: '%s (%d)', the location and maxArmour;
 * nothing for -1.
 *
 * @mw2shell mechlab_draw_location_name 0x0002c370
 * @fidelity exact
 */
export const mechlabDrawLocationName = registerWidgetDraw('mechlab_draw_location_name', 0x0002c370, (row) => {
  const l = widgetField(row, 'value');
  if (l === -1) return null;
  // 0x76b01 '%s (%d)'
  return put(row, text(`${locationName(l)} (${locField(l, 'maxArmour')})`));
});

/**
 * The ARMOR panel's selected location (*value): '%s (%d)'.
 *
 * @mw2shell mechlab_draw_selected_location 0x0002c3d0
 * @fidelity exact
 */
export const mechlabDrawSelectedLocation = registerWidgetDraw('mechlab_draw_selected_location', 0x0002c3d0, (row) => {
  const l = valueInt(row);
  if (l === -1) return null;
  // 0x76b09 '%s (%d)'
  return put(row, text(`${locationName(l)} (${locField(l, 'maxArmour')})`));
});

/**
 * A weapon slot (*value, a designWeapons entry): '-' when empty, 'Name #n',
 * or 'Name #n (ammo nT/shots)' for an ammo weapon; the selected one in
 * mechlabTextSelected. label_create_under from x 436 on.
 *
 * @mw2shell mechlab_draw_weapon_slot 0x0002c430
 * @fidelity exact
 */
export const mechlabDrawWeaponSlot = registerWidgetDraw('mechlab_draw_weapon_slot', 0x0002c430, (row) => {
  let style = widgetTextStyle(row);
  const w = valueInt(row);
  let t: string;
  if (w === -1) t = '-'; // 0x76b11
  else {
    const type = cdiv(w, 100);
    const per = itemField(type, 'ammoPerTon');
    if (per === 0) t = `${itemName(type)} #${cmod(w, 100)}`; // 0x76b28 '%s #%d'
    else {
      let n = 0;
      for (let i = 0; i < 25 && ammo(i) !== -1; i++) if (cdiv(ammo(i), 100) === cdiv(Math.imul(w, 100) + 10000, 100)) n++;
      t = `${itemName(type)} #${cmod(w, 100)} (ammo ${n}T/${Math.imul(per, n)})`; // 0x76b13
    }
    if (w === g(L.mechlabSelectedItem)) style = remapAt(L.mechlabTextSelected);
  }
  text(t);
  const x = widgetField(row, 'x');
  return x < 0x1b4 ? labelCreate(shell.uiFont!, x, widgetField(row, 'y'), t, style) : labelCreateUnder(shell.uiFont!, x, widgetField(row, 'y'), t, style);
});

/**
 * A WEAPONS TABLE row: itemTypes[value].name, selected style when value *
 * 100 is the selection; nothing for -1.
 *
 * @mw2shell mechlab_draw_weapon_row 0x0002c5c0
 * @fidelity exact
 */
export const mechlabDrawWeaponRow = registerWidgetDraw('mechlab_draw_weapon_row', 0x0002c5c0, (row) => {
  const v = widgetField(row, 'value');
  if (v === -1) return null;
  const style = Math.imul(v, 100) === g(L.mechlabSelectedItem) ? remapAt(L.mechlabTextSelected) : widgetTextStyle(row);
  return put(row, itemName(v), style);
});

/**
 * WEAPON INFO for the selection (nothing with none): value 0 the name
 * ('%s', or '%s #%d' for an instance), 1 heat, 2 damage, 3..5 the fields
 * at +8 .. +0x10 no row asks for, 6 range, 7 mass in tons, 8 criticals, 9
 * ammo per ton.
 *
 * @mw2shell mechlab_draw_weapon_info 0x0002c690
 * @fidelity exact
 */
export const mechlabDrawWeaponInfo = registerWidgetDraw('mechlab_draw_weapon_info', 0x0002c690, (row) => {
  const sel = g(L.mechlabSelectedItem);
  if (sel === -1) return null;
  const type = cdiv(sel, 100);
  const base = L.itemTypes + type * ITEM.size;
  let t = mem().cstr(L.mechlabText);
  switch (widgetField(row, 'value')) {
    case 0:
      // 0x76b36 '%s', 0x76b2f '%s #%d'
      t = cmod(sel, 100) === 0 ? itemName(type) : `${itemName(type)} #${cmod(sel, 100)}`;
      break;
    case 1:
      t = `${itemField(type, 'heat')}`; // 0x76b39
      break;
    case 2: {
      const d = itemField(type, 'damage');
      t = d === 0 ? '-' : d < 0 ? `${-d | 0}/missile` : `${d}`; // 0x76b3c, 0x76b3e, 0x76b49
      break;
    }
    case 3: {
      // +8: unnamed (no row shows it)
      const v = g(base + 8);
      t = v < 0 ? '-' : `${v}`; // 0x76b4f, 0x76b4c
      break;
    }
    case 4: {
      const v = g(base + 0xc);
      t = v === -1 ? '-' : v === 1 ? '1' : `1-${v}`; // 0x76b51, 0x76b53, 0x76b55
      break;
    }
    case 5: {
      const v = g(base + 0x10);
      const lo = g(base + 0xc) + 1;
      t = v === -1 ? '-' : lo === v ? `${v}` : `${lo}-${v}`; // 0x76b5a, 0x76b5c, 0x76b5f
      break;
    }
    case 6: {
      const r = itemField(type, 'range');
      t = r === -1 ? '-' : `${r}`; // 0x76b65, 0x76b67
      break;
    }
    case 7: {
      const ms = itemField(type, 'mass');
      // 0x76b7a '%dT', 0x76b73 '%d.%dT', 0x76b6a '%d.%d%dT'
      if (cmod(ms, 10) === 0) t = cmod(ms, 100) === 0 ? `${cdiv(ms, 100)}T` : `${cdiv(ms, 100)}.${cmod(cdiv(ms, 10), 10)}T`;
      else t = `${cdiv(ms, 100)}.${cmod(cdiv(ms, 10), 10)}${cmod(ms, 10)}T`;
      break;
    }
    case 8:
      t = `${itemField(type, 'criticals')}`; // 0x76b7e
      break;
    case 9: {
      const a = itemField(type, 'ammoPerTon');
      t = a === 0 ? '-' : `${a}`; // 0x76b84, 0x76b81
      break;
    }
  }
  return put(row, text(t));
});

/**
 * The CRITICALS heading: locationNames[*value].
 *
 * @mw2shell mechlab_draw_location_title 0x0002caf0
 * @fidelity exact
 */
export const mechlabDrawLocationTitle = registerWidgetDraw('mechlab_draw_location_title', 0x0002caf0, (row) => {
  const l = valueInt(row);
  if (l === -1) return null;
  return put(row, locationName(l));
});

/** equipmentNames' entry whose code / 50 matches, searched from the last of 23; null for none. */
function equipmentName(code: number): string | null {
  for (let i = 0x16; i >= 0; i--) {
    const a = L.equipmentNames + i * 8;
    if (cdiv(code, 0x32) === cdiv(g(a), 0x32)) return mem().ptrStr(a + 4) ?? '';
  }
  return null;
}

/** An ammo code's '(%s #%d) #%d' parts. */
function ammoParts(code: number): [string, number, number] {
  const a = code - 10000;
  return [itemName(cdiv(a, 10000)), cmod(cdiv(a, 100), 100), cmod(a, 100)];
}

/**
 * A CRITICALS slot (value 0..11 of mechlabLocation; bit 31 masked off): '-'
 * empty, a weapon 'Name #n', equipment by equipmentNames, 'Ammo (Name #n)
 * #k', 'BAD CRITICAL %d'; nothing for -1.
 *
 * @mw2shell mechlab_draw_slot 0x0002cb30
 * @fidelity exact
 */
export const mechlabDrawSlot = registerWidgetDraw('mechlab_draw_slot', 0x0002cb30, (row) => {
  const l = g(L.mechlabLocation);
  if (l === -1) return null;
  const c = crit(l, widgetField(row, 'value'));
  if (c === -1) return null;
  const u = c & 0x7fffffff;
  let t: string;
  if (u === 0) t = '-'; // 0x76b86
  else if (u < 5000) t = `${itemName(cdiv(u, 100))} #${cmod(u, 100)}`; // 0x76b88
  else if (u < 10000) t = equipmentName(u) ?? `BAD CRITICAL ${u}`; // 0x76b8f '%s', 0x76b92
  else {
    const [n, w, k] = ammoParts(u);
    t = `Ammo (${n} #${w}) #${k}`; // 0x76ba2
  }
  return put(row, text(t));
});

/**
 * An UNASSIGNED CRITICALS row: mechlabUnplaced[value] with the slots it
 * needs; nothing for an empty entry or with no location.
 *
 * @mw2shell mechlab_draw_unplaced 0x0002ccf0
 * @fidelity exact
 */
export const mechlabDrawUnplaced = registerWidgetDraw('mechlab_draw_unplaced', 0x0002ccf0, (row) => {
  if (g(L.mechlabLocation) === -1) return null;
  const v = widgetField(row, 'value');
  const item = unplacedItem(v);
  const n = unplacedCriticals(v);
  if (item === -1 || item === 0 || n === 0) return null;
  let t: string;
  if (item < 5000) t = `${itemName(cdiv(item, 100))} #${cmod(item, 100)} (${n})`; // 0x76bb4
  else if (item < 10000) {
    const name = equipmentName(item);
    t = name !== null ? `${name} (${n})` : `BAD CRITICAL ${item}`; // 0x76bc0, 0x76bc8
  } else {
    const [nm, w, k] = ammoParts(item);
    t = `Ammo (${nm} #${w}) #${k} (${n})`; // 0x76bd8
  }
  return put(row, text(t));
});

/**
 * The list's last row: 'More...' when that entry is used.
 *
 * @mw2shell mechlab_draw_more 0x0002ce90
 * @fidelity exact
 */
export const mechlabDrawMore = registerWidgetDraw('mechlab_draw_more', 0x0002ce90, (row) =>
  // 0x76bef 'More...'
  unplacedItem(widgetField(row, 'value')) < 1 ? null : put(row, 'More...'),
);

/**
 * An EQUIPMENT flag: 'Yes' / 'No'.
 *
 * @mw2shell mechlab_draw_yes_no 0x0002ced0
 * @fidelity exact
 */
export const mechlabDrawYesNo = registerWidgetDraw('mechlab_draw_yes_no', 0x0002ced0, (row) =>
  // 0x76bfb 'No', 0x76bf7 'Yes'
  put(row, valueInt(row) === 0 ? 'No' : 'Yes'),
);

/**
 * An EQUIPMENT row's name by code (value): MASC (5000), the four arm
 * actuators; '' otherwise.
 *
 * @mw2shell mechlab_draw_equipment_name 0x0002cf00
 * @fidelity exact
 */
export const mechlabDrawEquipmentName = registerWidgetDraw('mechlab_draw_equipment_name', 0x0002cf00, (row) => {
  const v = widgetField(row, 'value') >>> 0;
  // 0x76bfe .. 0x76c48; 0x76c5b ''
  const names: Record<number, string> = { 0x1519: 'Right Lower Arm Actuator', 0x151a: 'Left Lower Arm Actuator', 0x154b: 'Right Hand Actuator', 0x154c: 'Left Hand Actuator' };
  const t = v === 0x1388 ? 'MASC' : (names[v] ?? '');
  return put(row, t);
});

// --------------------------------------------------------------- panels

/** Frees every row's label in the panel at `table` (0: none). */
function freePanelLabels(table: number): void {
  if (table === 0) return;
  for (let row = table; mem().i32(row) !== -1; row += WIDGET_ROW) {
    const l = widgetLabel(row);
    if (l) {
      labelDestroy(l);
      setWidgetLabel(row, null);
    }
  }
}

/**
 * A summary row's click: animations 10..13 hidden, 14 shown, the right
 * panel's labels freed, the row's extra made mechlabPanel and laid out.
 *
 * @mw2shell mechlab_open_panel 0x0002cf80
 * @fidelity exact
 */
export function mechlabOpenPanel(row: number): void {
  const panel = widgetField(row, 'extra') >>> 0;
  for (const i of [10, 11, 12, 13]) animSetFlags(i, 0x20, 0x20);
  animUnhide(0xe);
  freePanelLabels(mem().u32(L.mechlabPanel));
  s(L.mechlabPanel, panel);
  widgetPanelLayout(panel);
}
registerWidgetClick('mechlab_open_panel', 0x0002cf80, syncClick(mechlabOpenPanel));

/**
 * Weapons / Ammo: the selection cleared, the panel opened, animations 11
 * and 13 shown and 14 hidden.
 *
 * @mw2shell mechlab_open_weapons_panel 0x0002d020
 * @fidelity exact
 */
export const mechlabOpenWeaponsPanel = registerWidgetClick(
  'mechlab_open_weapons_panel',
  0x0002d020,
  syncClick((row) => {
    s(L.mechlabSelectedItem, -1);
    mechlabOpenPanel(row);
    animUnhide(0xb);
    animUnhide(0xd);
    animSetFlags(0xe, 0x20, 0x20);
  }),
);

/**
 * Armor: the panel with animations 10 (the diagram) and 12 (the marker).
 *
 * @mw2shell mechlab_open_armour_panel 0x0002d060
 * @fidelity exact
 */
export const mechlabOpenArmourPanel = registerWidgetClick(
  'mechlab_open_armour_panel',
  0x0002d060,
  syncClick((row) => {
    mechlabOpenPanel(row);
    animUnhide(10);
    animUnhide(0xc);
    animSetFlags(0xe, 0x20, 0x20);
  }),
);

/**
 * 'Assign Criticals': the panel with animations 10, 11 and 12.
 *
 * @mw2shell mechlab_open_criticals_panel 0x0002d090
 * @fidelity exact
 */
export const mechlabOpenCriticalsPanel = registerWidgetClick(
  'mechlab_open_criticals_panel',
  0x0002d090,
  syncClick((row) => {
    mechlabOpenPanel(row);
    animUnhide(10);
    animUnhide(0xb);
    animUnhide(0xc);
    animSetFlags(0xe, 0x20, 0x20);
  }),
);

/**
 * 'Variant:': its label freed, text_input on designTitle (28 characters,
 * the row's width), then a new label under the animations.
 *
 * @mw2shell mechlab_edit_variant_title 0x0002d0d0
 * @fidelity exact
 */
export const mechlabEditVariantTitle = registerWidgetClick('mechlab_edit_variant_title', 0x0002d0d0, function* (row) {
  const old = widgetLabel(row);
  if (old) labelDestroy(old);
  const m = mem();
  const at = widgetField(row, 'value') >>> 0;
  const r = yield* textInput(shell.uiFont!, widgetField(row, 'x'), widgetField(row, 'y'), m.cstr(at), widgetTextStyle(row), 0x1c, widgetField(row, 'w'));
  m.strcpy(at, r.text);
  setWidgetLabel(row, labelCreateUnder(shell.uiFont!, widgetField(row, 'x'), widgetField(row, 'y'), m.cstr(at), widgetTextStyle(row)));
});

// ------------------------------------------------------------ the handlers

registerWidgetClick('mechlab_engine_faster', 0x0002d130, syncClick(mechlabEngineFaster));
registerWidgetClick('mechlab_engine_slower', 0x0002d490, syncClick(mechlabEngineSlower));
registerWidgetClick('mechlab_toggle_xl_engine', 0x0002d7f0, syncClick(mechlabToggleXlEngine));
registerWidgetClick('mechlab_add_jump_jet', 0x0002dc90, syncClick(mechlabAddJumpJet));
registerWidgetClick('mechlab_delete_jump_jet', 0x0002deb0, syncClick(mechlabDeleteJumpJet));
registerWidgetClick('mechlab_add_heat_sink', 0x0002e0a0, syncClick(mechlabAddHeatSink));
registerWidgetClick('mechlab_delete_heat_sink', 0x0002e270, syncClick(mechlabDeleteHeatSink));
registerWidgetClick('mechlab_toggle_heat_sink_type', 0x0002e450, syncClick(mechlabToggleHeatSinkType));
registerWidgetClick('mechlab_add_armour', 0x0002e6b0, syncClick(mechlabAddArmour));
registerWidgetClick('mechlab_delete_armour', 0x0002e7d0, syncClick(mechlabDeleteArmour));
registerWidgetClick('mechlab_toggle_ferro_fibrous', 0x0002e900, syncClick(mechlabToggleFerroFibrous));
registerWidgetClick(
  'mechlab_toggle_endo_steel',
  0x0002ebe0,
  syncClick(() => {
    mechlabToggleEndoSteel();
    widgetPanelRedraw(mem().u32(L.mechlabPanel));
    widgetPanelRedraw(mem().u32(L.mechlabSummaryPanel));
  }),
);
registerWidgetClick('mechlab_add_item_and_recompute', 0x0002eee0, syncClick(mechlabAddItemAndRecompute));
registerWidgetClick('mechlab_remove_item_and_recompute', 0x0002f230, syncClick(mechlabRemoveItemAndRecompute));
registerWidgetClick('mechlab_add_ammo', 0x0002f590, syncClick(mechlabAddAmmo));
registerWidgetClick('mechlab_delete_ammo', 0x0002f820, syncClick(mechlabDeleteAmmo));
registerWidgetClick('mechlab_armour_front_up', 0x0002fd90, syncClick(mechlabArmourFrontUp));
registerWidgetClick('mechlab_armour_front_down', 0x0002fe20, syncClick(mechlabArmourFrontDown));
registerWidgetClick('mechlab_armour_rear_up', 0x0002fe50, syncClick(mechlabArmourRearUp));
registerWidgetClick('mechlab_armour_rear_down', 0x0002fed0, syncClick(mechlabArmourRearDown));

/**
 * A weapon slot: selects its weapon; a double click on the one already
 * selected deletes it (the selection is then whatever the slot holds).
 *
 * @mw2shell mechlab_click_weapon_slot 0x0002fab0
 * @fidelity exact
 */
export const mechlabClickWeaponSlot = registerWidgetClick(
  'mechlab_click_weapon_slot',
  0x0002fab0,
  syncClick((row) => {
    const w = valueInt(row);
    if (w < 0) return;
    if (w === g(L.mechlabSelectedItem) && mouseDoubleClicked(mouse()) !== 0) mechlabRemoveItemAndRecompute();
    s(L.mechlabSelectedItem, valueInt(row));
  }),
);

/**
 * A WEAPONS TABLE row: selects type * 100; a double click on the selected
 * row adds the weapon.
 *
 * @mw2shell mechlab_click_weapon_row 0x0002faf0
 * @fidelity exact
 */
export const mechlabClickWeaponRow = registerWidgetClick(
  'mechlab_click_weapon_row',
  0x0002faf0,
  syncClick((row) => {
    const v = Math.imul(widgetField(row, 'value'), 100);
    if (v === g(L.mechlabSelectedItem) && mouseDoubleClicked(mouse()) !== 0) {
      mechlabAddItemAndRecompute();
      return;
    }
    s(L.mechlabSelectedItem, v);
  }),
);

/**
 * The selected location's row: the click sample, the next location
 * (wrapping after 7).
 *
 * @mw2shell mechlab_next_location 0x0002fb20
 * @fidelity exact
 */
export const mechlabNextLocation = registerWidgetClick(
  'mechlab_next_location',
  0x0002fb20,
  syncClick(() => {
    soundSamplePlay(mechlabUi.clickSample!);
    let l = g(L.mechlabLocation) + 1;
    if (l > 7) l = 0;
    s(L.mechlabLocation, l);
  }),
);

/**
 * A 'Mech-diagram hotspot: the click sample, location = value.
 *
 * @mw2shell mechlab_click_location 0x0002fb50
 * @fidelity exact
 */
export const mechlabClickLocation = registerWidgetClick(
  'mechlab_click_location',
  0x0002fb50,
  syncClick((row) => {
    soundSamplePlay(mechlabUi.clickSample!);
    s(L.mechlabLocation, widgetField(row, 'value'));
  }),
);

/**
 * An UNASSIGNED CRITICALS row: the entry placed in the selected location
 * (all its slots or none; jump jets not in the head or arms), else the
 * message.
 *
 * @mw2shell mechlab_click_unplaced 0x0002fb70
 * @fidelity exact
 */
export const mechlabClickUnplaced = registerWidgetClick('mechlab_click_unplaced', 0x0002fb70, function* (row) {
  const msg = mechlabPlaceUnplaced(widgetField(row, 'value'));
  if (msg !== null) yield* messageBox(msg, 0);
});

/**
 * 'More...': a bare ret.
 *
 * @mw2shell mechlab_click_more 0x0002fc80
 * @fidelity exact
 */
export const mechlabClickMore = registerWidgetClick('mechlab_click_more', 0x0002fc80, function* () {});

/**
 * A CRITICALS slot: its item back to the unplaced list from every slot,
 * unless it is a fixed item (5300..5999).
 *
 * @mw2shell mechlab_click_slot 0x0002fc90
 * @fidelity exact
 */
export const mechlabClickSlot = registerWidgetClick('mechlab_click_slot', 0x0002fc90, function* (row) {
  const msg = mechlabUnplaceSlot(widgetField(row, 'value'));
  if (msg !== null) yield* messageBox(msg, 0);
});

registerWidgetClick(
  'mechlab_toggle_equipment',
  0x0002ff00,
  syncClick((row) => mechlabToggleEquipment(widgetField(row, 'value') >>> 0, widgetField(row, 'extra'))),
);
