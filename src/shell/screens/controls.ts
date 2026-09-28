/**
 * COCKPIT CONTROLS, item 2 of shell_menu (decompiled/mw2shell/src/controls/
 * controls.c): the device panel (controlsDevicePanel) over the amwlogo1
 * loop, then, after CUSTOM CONFIGURATION, the GAME CONTROLS binding panel
 * (controlsBindingPanel). Both are widget tables in the shell's image; this
 * module holds their draw functions, the two click functions that run a
 * loop of their own (the configuration name field and the Buttons list's
 * arrows) and the screen. The click functions that only change the
 * configuration are shell/controls/panel.ts; the files, shell/controls/
 * config.ts and inputMap.ts.
 */
import { unestablished } from '../../core/provenance.ts';
import { cdiv } from '../../core/int/cint.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { BackgroundMovie, movieBackgroundClose, movieBackgroundStep, movieOpenBackground } from '../anim/movies.ts';
import { bindingField, controlsDeviceChosen, controlsScreenSetup, currentBinding } from '../controls/config.ts';
import { inputDeviceCount, inputDeviceGet, inputDevicesFree } from '../controls/devices.ts';
import '../controls/panel.ts';
import type { Blocking } from '../host/blocking.ts';
import { mem } from '../memory.ts';
import { driver, mouse, shell } from '../state.ts';
import { inputFlush, inputPollKey } from '../ui/keys.ts';
import { labelCreate, labelCreateUnder, labelDestroy, remapAt, textWidth, type TextLabel } from '../ui/labels.ts';
import { menuScreens } from '../ui/menuScreens.ts';
import { messageBox } from '../ui/messageBox.ts';
import { mouseLeftClicked, mouseRightClicked, mouseUpdate } from '../ui/mouse.ts';
import { fontCharWidth } from '../ui/textInput.ts';
import {
  registerWidgetClick,
  registerWidgetDraw,
  setWidgetField,
  setWidgetLabel,
  WIDGET_ROW,
  widgetField,
  widgetLabel,
  widgetPanelFreeLabels,
  widgetPanelHit,
  widgetPanelLayout,
  widgetPanelRedraw,
  widgetRowClick,
  widgetTextStyle,
  widgetValueString,
} from '../ui/widgets.ts';
import { screenPaintPicture } from '../video/background.ts';
import { videoDriverErase, videoDriverLine } from '../video/driver.ts';

const DEVICE_PANEL = SHELL_LABEL.controlsDevicePanel;
const BINDING_PANEL = SHELL_LABEL.controlsBindingPanel;

export const controlsScreenState = registerGlobals(
  'controlsScreen',
  {
    /** controlsMovie (0x8b12c): the amwlogo1 loop behind the panels (a heap block), null outside the screen */
    movie: null as BackgroundMovie | null,
  },
  () => {
    controlsScreenState.movie = null;
  },
  'mw2shell',
);

function getInt(label: number): number {
  return mem().i32(label);
}
function setInt(label: number, v: number): void {
  mem().setI32(label, v);
}

/** controlsRemapSelected: ink 0x10, the chosen device / the selected cell */
function remapSelected(): Uint8Array {
  return remapAt(SHELL_LABEL.controlsRemapSelected);
}
/** controlsRemapFull: ink 7, what cannot be picked */
function remapFull(): Uint8Array {
  return remapAt(SHELL_LABEL.controlsRemapFull);
}

/** the string at an image address the code hands over (a constant; xref'd address) */
function imageString(addr: number): string {
  return mem().cstr(addr);
}

/** sprintf of '%s' formats into controlsCellText; returns the text */
function cellText(format: string, ...args: string[]): string {
  let i = 0;
  const s = format.replace(/%s/g, () => args[i++] ?? '');
  mem().strcpy(SHELL_LABEL.controlsCellText, s);
  return mem().cstr(SHELL_LABEL.controlsCellText);
}

/** names[i] of a driver's table; a read past the table or through a NULL one is not something the original guards */
function nameAt(names: (string | null)[] | null, i: number, what: string): string | null {
  if (!names || i < 0 || i >= names.length) {
    unestablished(`${what}: an input past the device's name table (the original reads whatever follows it)`);
    return null;
  }
  return names[i] ?? null;
}

function font32() {
  return shell.font32!;
}

/** the row before this one's label (+0x18 of row - 0x2c): the cell a direction or second button follows */
function previousLabel(row: number): TextLabel | null {
  return widgetLabel(row - WIDGET_ROW);
}

/**
 * A text row: the row's string in font32, in the row's style.
 *
 * @mw2shell controls_draw_label 0x0001e060
 * @fidelity exact
 */
export const controlsDrawLabel = registerWidgetDraw('controls_draw_label', 0x0001e060, (row) =>
  labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), widgetValueString(row), widgetTextStyle(row)),
);

/**
 * The row under 'Current Config:' (value = controlsConfigName, w 150): the
 * name edited in place. Its label is dropped and the text copied to
 * controlsEditText with a '_' cursor, shown in the UI font over the
 * animations. Each pass steps the amwlogo1 loop and updates the mouse; a
 * left click, Enter or Esc ends it - the three exits are the same code,
 * which copies the text (cursor dropped) back into the row's string, so Esc
 * keeps the edit too. Backspace deletes; a key 0x20..0x7f other than '~'
 * that the font has a glyph for is appended while fewer than 62 are typed,
 * unless the text with its cursor would be as wide as the row. The row gets
 * a font32 label of the result.
 *
 * @mw2shell controls_edit_config_name 0x0001e350
 * @fidelity exact
 */
export const controlsEditConfigName = registerWidgetClick('controls_edit_config_name', 0x0001e350, function* (row): Blocking<void> {
  const m = mem();
  const old = widgetLabel(row);
  if (old) {
    labelDestroy(old);
    setWidgetLabel(row, null);
  }
  const font = shell.uiFont!;
  const x = widgetField(row, 'x');
  const y = widgetField(row, 'y');
  const target = widgetField(row, 'value') >>> 0;
  const style = widgetTextStyle(row);
  const width = widgetField(row, 'w');
  const EDIT = SHELL_LABEL.controlsEditText;
  let n = m.cstr(target).length;
  m.strcpy(EDIT, m.cstr(target));
  // strcat(controlsEditText, 0x735c8 '_')
  m.strcat(EDIT, imageString(0x735c8));
  textWidth(font, m.cstr(EDIT));
  let label: TextLabel | null = labelCreate(font, x, y, m.cstr(EDIT), style);
  const k = shell.keyInput!;
  const ms = mouse();
  for (;;) {
    const movie = controlsScreenState.movie;
    if (movie) movieBackgroundStep(movie);
    yield* mouseUpdate(ms);
    let done = mouseLeftClicked(ms) === 1;
    if (!done) {
      if (inputPollKey(k) === 0) continue;
      const key = k.key;
      if (key === 0x0d || key === 0x1b) done = true;
      else if (key === 0x08) {
        if (n === 0) continue;
        n--;
        m.setU8(EDIT + n, 0x5f);
        m.setU8(EDIT + n + 1, 0);
        if (label) labelDestroy(label);
        label = labelCreate(font, x, y, m.cstr(EDIT), style);
        continue;
      } else {
        if ((key | 0) < 0x20 || (key | 0) > 0x7f || key === 0x7e || n === 0x3e || fontCharWidth(font, key) === 0) continue;
        n++;
        m.setU8(EDIT + n - 1, key & 0xff);
        m.setU8(EDIT + n, 0x5f);
        m.setU8(EDIT + n + 1, 0);
        if (textWidth(font, m.cstr(EDIT)) >= width) {
          n--;
          m.setU8(EDIT + n, 0x5f);
          m.setU8(EDIT + n + 1, 0);
          continue;
        }
        if (label) labelDestroy(label);
        label = labelCreate(font, x, y, m.cstr(EDIT), style);
        continue;
      }
    }
    if (done) break;
  }
  m.setU8(EDIT + n, 0);
  if (label) labelDestroy(label);
  m.strcpy(target, m.cstr(EDIT));
  setWidgetLabel(row, labelCreateUnder(font32(), x, y, m.cstr(target), style));
});

/**
 * The binding cell (x 285, value = control): '<device> <input>' - the
 * device's driver name ('key' for the keyboard) and its axis name (kind 0)
 * or button name (kinds 1, 2) - or '----' when unbound or the name is
 * missing, empty or starts with '*'; highlighted while it is the selected
 * cell. The row is 100 wide, or for an axis on two buttons only as wide as
 * its text, so the second button follows it.
 *
 * @mw2shell controls_draw_binding 0x0001e6a0
 * @fidelity exact
 */
export const controlsDrawBinding = registerWidgetDraw('controls_draw_binding', 0x0001e6a0, (row) => {
  const v = widgetField(row, 'value');
  const b = currentBinding(v);
  const input = bindingField(b, 'input');
  let style = widgetTextStyle(row);
  const dev = inputDeviceGet(bindingField(b, 'device'));
  if (getInt(SHELL_LABEL.controlsSelectedControl) === v && getInt(SHELL_LABEL.controlsSelectedColumn) === 0) style = remapSelected();
  let text: string;
  if (!dev) text = cellText(imageString(0x735ca));
  else {
    let s: string | null;
    if (input < 0) s = imageString(0x735cf);
    else s = nameAt(bindingField(b, 'kind') === 0 ? dev.record.analogNames : dev.record.buttonNames, input, 'controls_draw_binding');
    if (s === null) s = imageString(0x735d4);
    else if (s.length === 0) s = imageString(0x735d9);
    else if (s[0] === '*') s = imageString(0x735de);
    // strcmp(device name, 0x735e3 'keyboard') -> 0x735ec 'key'; 0x735f0 '%s %s'
    const name = dev.name === imageString(0x735e3) ? imageString(0x735ec) : dev.name;
    text = cellText(imageString(0x735f0), name, s);
  }
  const label = labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), text, style);
  setWidgetField(row, 'w', bindingField(b, 'kind') === 2 ? label.width : 100);
  return label;
});

/**
 * The second button's cell, an axis on two buttons (kind 2) only: moved to
 * just after the binding cell, '/<button>' (buttonNames[input2]) or '/----'
 * when unset; highlighted while selected.
 *
 * @mw2shell controls_draw_second_button 0x0001e810
 * @fidelity exact
 */
export const controlsDrawSecondButton = registerWidgetDraw('controls_draw_second_button', 0x0001e810, (row) => {
  const v = widgetField(row, 'value');
  const b = currentBinding(v);
  const input2 = bindingField(b, 'input2');
  let style = widgetTextStyle(row);
  const dev = inputDeviceGet(bindingField(b, 'device'));
  if (!dev || bindingField(b, 'kind') !== 2) return null;
  const prev = previousLabel(row);
  if (prev) setWidgetField(row, 'x', prev.right + 1);
  if (getInt(SHELL_LABEL.controlsSelectedControl) === v && getInt(SHELL_LABEL.controlsSelectedColumn) === 1) style = remapSelected();
  // input2 == buttonCount passes the test: the original reads the entry after the table
  let s = input2 < 0 || dev.record.buttonCount < input2 ? imageString(0x735f6) : nameAt(dev.record.buttonNames, input2, 'controls_draw_second_button');
  if (s === null) s = imageString(0x735fb);
  else if (s.length === 0) s = imageString(0x73600);
  // 0x73605 '/%s'
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), cellText(imageString(0x73605), s), style);
});

/**
 * The control's name, controlNames[value], at x 175.
 *
 * @mw2shell controls_draw_control_name 0x0001e8f0
 * @fidelity exact
 */
export const controlsDrawControlName = registerWidgetDraw('controls_draw_control_name', 0x0001e8f0, (row) =>
  labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), mem().ptrStr(SHELL_LABEL.controlNames + widgetField(row, 'value') * 4), widgetTextStyle(row)),
);

/**
 * The page title beside GAME CONTROLS: configPageNames[controlsPage].
 *
 * @mw2shell controls_draw_config_page 0x0001e960
 * @fidelity exact
 */
export const controlsDrawConfigPage = registerWidgetDraw('controls_draw_config_page', 0x0001e960, (row) =>
  labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), mem().ptrStr(SHELL_LABEL.configPageNames + getInt(SHELL_LABEL.controlsPage) * 4), widgetTextStyle(row)),
);

/**
 * The direction cell of axis controls 0..6, just after the name:
 * axisDirectionNames[extra * 2 + reversed] - '-/+' (throttle), 'L/R', 'D/U',
 * 'I/O' (zoom), swapped when flags bit 31 is set. No colour table.
 *
 * @mw2shell controls_draw_axis_direction 0x0001e9d0
 * @fidelity exact
 */
export const controlsDrawAxisDirection = registerWidgetDraw('controls_draw_axis_direction', 0x0001e9d0, (row) => {
  const reversed = bindingField(currentBinding(widgetField(row, 'value')), 'flags') < 0 ? 1 : 0;
  const prev = previousLabel(row);
  if (prev) setWidgetField(row, 'x', prev.right + 1);
  const text = mem().ptrStr(SHELL_LABEL.axisDirectionNames + (reversed + widgetField(row, 'extra') * 2) * 4);
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), text, null);
});

/**
 * The modifier cell, centred in its 20 px: modifierNames[flags & 7] -
 * '~--', '~Ctrl', '~Alt', '~Shft'. Flags 5..7, which the panel never makes,
 * would index past the table into configSlotNames. No colour table.
 *
 * @mw2shell controls_draw_modifier 0x0001ea50
 * @fidelity exact
 */
export const controlsDrawModifier = registerWidgetDraw('controls_draw_modifier', 0x0001ea50, (row) => {
  const idx = bindingField(currentBinding(widgetField(row, 'value')), 'flags') & 7;
  const text = mem().ptrStr(SHELL_LABEL.modifierNames + idx * 4);
  return labelCreateUnder(font32(), widgetField(row, 'x') + cdiv(widgetField(row, 'w'), 2), widgetField(row, 'y'), text, null);
});

/**
 * A Directional row (x 480, value = axis): the shown device's axis title,
 * only for an axis it has whose name and title are set and not empty;
 * greyed while no cell is selected or the selected control is a button.
 *
 * @mw2shell controls_draw_axis_entry 0x0001f170
 * @fidelity exact
 */
export const controlsDrawAxisEntry = registerWidgetDraw('controls_draw_axis_entry', 0x0001f170, (row) => {
  const dev = inputDeviceGet(getInt(SHELL_LABEL.controlsDevice));
  const v = widgetField(row, 'value');
  let style = widgetTextStyle(row);
  if (!dev || v >= dev.record.analogCount) return null;
  const name = dev.record.analogNames?.[v] ?? null;
  const title = dev.record.analogTitles?.[v] ?? null;
  if (name === null || title === null || name.length === 0 || title.length === 0) return null;
  const sel = getInt(SHELL_LABEL.controlsSelectedControl);
  if (sel < 0 || bindingField(currentBinding(sel), 'kind') === 1) style = remapFull();
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), title, style);
});

/**
 * A Buttons row (x 480, 18 of them): the shown device's button title,
 * value + controlsButtonScroll; '----' and greyed when its name or title is
 * missing or empty, greyed when the name starts with '*' or no cell is
 * selected; nothing past the device's last button.
 *
 * @mw2shell controls_draw_button_entry 0x0001f230
 * @fidelity exact
 */
export const controlsDrawButtonEntry = registerWidgetDraw('controls_draw_button_entry', 0x0001f230, (row) => {
  const dev = inputDeviceGet(getInt(SHELL_LABEL.controlsDevice));
  const i = widgetField(row, 'value') + getInt(SHELL_LABEL.controlsButtonScroll);
  let style = widgetTextStyle(row);
  if (!dev || i >= dev.record.buttonCount) return null;
  const name = dev.record.buttonNames?.[i] ?? null;
  const title = dev.record.buttonDescriptions?.[i] ?? null;
  let text: string;
  if (name === null || title === null || name.length === 0 || title.length === 0) {
    text = imageString(0x73611);
    style = remapFull();
  } else {
    text = title;
    if (name[0] === '*') style = remapFull();
  }
  if (getInt(SHELL_LABEL.controlsSelectedControl) < 0) style = remapFull();
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), text, style);
});

/**
 * The Buttons list's arrows at x 600 (value -1: up, glyph 1; +1: down,
 * glyph 2), only for a device with more than 18 buttons; greyed at either
 * end of the list.
 *
 * @mw2shell controls_draw_scroll_arrow 0x0001f350
 * @fidelity exact
 */
export const controlsDrawScrollArrow = registerWidgetDraw('controls_draw_scroll_arrow', 0x0001f350, (row) => {
  const dev = inputDeviceGet(getInt(SHELL_LABEL.controlsDevice));
  if (!dev) unestablished('controls_draw_scroll_arrow: controlsDevice is not a loaded device (the original reads through a NULL record)');
  const count = dev ? dev.record.buttonCount : 0;
  let style = widgetTextStyle(row);
  if (count < 0x13) return null;
  const v = widgetField(row, 'value');
  const scroll = getInt(SHELL_LABEL.controlsButtonScroll);
  if (v < 0 ? scroll === 0 : count - 0x12 <= scroll) style = remapFull();
  // 0x73616 '\x01' / 0x73618 '\x02'
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), imageString(v < 0 ? 0x73616 : 0x73618), style);
});

/**
 * An arrow's click: controlsButtonScroll moved by the row's value (twice as
 * far while the right button is down), kept within the list, and the panel
 * redrawn - again every pass while a button is held, stepping the amwlogo1
 * loop and the mouse.
 *
 * @mw2shell controls_scroll_buttons 0x0001f3c0
 * @fidelity exact
 */
export const controlsScrollButtons = registerWidgetClick('controls_scroll_buttons', 0x0001f3c0, function* (row): Blocking<void> {
  const dev = inputDeviceGet(getInt(SHELL_LABEL.controlsDevice));
  if (!dev) unestablished('controls_scroll_buttons: controlsDevice is not a loaded device (the original reads through a NULL record)');
  const count = dev ? dev.record.buttonCount : 0;
  const ms = mouse();
  let step = widgetField(row, 'value');
  if (ms.rightDown === 1) step *= 2;
  do {
    let scroll = getInt(SHELL_LABEL.controlsButtonScroll) + step;
    if (scroll < 0) scroll = 0;
    if (count <= scroll + 0x12) scroll = count - 0x12;
    if (scroll < 0) scroll = 0;
    setInt(SHELL_LABEL.controlsButtonScroll, scroll);
    widgetPanelRedraw(BINDING_PANEL);
    const movie = controlsScreenState.movie;
    if (movie) movieBackgroundStep(movie);
    yield* mouseUpdate(ms);
  } while (ms.leftDown === 1 || ms.rightDown === 1);
});

/**
 * An INPUT DEVICES row (x 0, value = device 0..11), or with value -1 the
 * shown device's name above the lists: the device's display name,
 * highlighted for the shown device, greyed when it was not chosen.
 *
 * @mw2shell controls_draw_device_tab 0x0001f5e0
 * @fidelity exact
 */
export const controlsDrawDeviceTab = registerWidgetDraw('controls_draw_device_tab', 0x0001f5e0, (row) => {
  const v = widgetField(row, 'value');
  let style = widgetTextStyle(row);
  if (v > -1 && !controlsDeviceChosen(v)) style = remapFull();
  if (getInt(SHELL_LABEL.controlsDevice) === v) style = remapSelected();
  const dev = inputDeviceGet(v < 0 ? getInt(SHELL_LABEL.controlsDevice) : v);
  if (!dev) return null;
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), dev.record.displayName, style);
});

/**
 * A device row of the device panel (value = device 0..11): its display
 * name, highlighted when chosen, greyed when four are chosen and it is not.
 *
 * @mw2shell controls_draw_device 0x0001f640
 * @fidelity exact
 */
export const controlsDrawDevice = registerWidgetDraw('controls_draw_device', 0x0001f640, (row) => {
  const v = widgetField(row, 'value');
  let style = widgetTextStyle(row);
  if (v < 0 || !controlsDeviceChosen(v)) {
    if (getInt(SHELL_LABEL.controlsDeviceCount) > 3) style = remapFull();
  } else style = remapSelected();
  const dev = inputDeviceGet(v < 0 ? getInt(SHELL_LABEL.controlsDevice) : v);
  if (!dev) return null;
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), dev.record.displayName, style);
});

/**
 * A vertical line from the row's (x, y) down to y 470 in colour 0x10 (the
 * decompile drops the colour, the second stack argument); the two at x 172
 * and 477 frame the panels. No label.
 *
 * @mw2shell controls_draw_divider 0x0001f770
 * @fidelity exact
 */
export const controlsDrawDivider = registerWidgetDraw('controls_draw_divider', 0x0001f770, (row) => {
  const x = widgetField(row, 'x');
  videoDriverLine(driver(), x, widgetField(row, 'y'), x, 0x1d6, 0x10);
  return null;
});

/**
 * After 'Current Config:' (x 90): configSlotNames[*value], value pointing at
 * controlsConfigSlot - 'Default', 'Custom 1' .. 'Custom 4' (0 outside 0..4).
 *
 * @mw2shell controls_draw_config_slot 0x0001f7a0
 * @fidelity exact
 */
export const controlsDrawConfigSlot = registerWidgetDraw('controls_draw_config_slot', 0x0001f7a0, (row) => {
  let slot = mem().i32(widgetField(row, 'value') >>> 0);
  if (slot < 0 || slot > 4) slot = 0;
  return labelCreateUnder(font32(), widgetField(row, 'x'), widgetField(row, 'y'), mem().ptrStr(SHELL_LABEL.configSlotNames + slot * 4), widgetTextStyle(row));
});

/** One panel's loop: until controlsExit, or - on the binding panel - Esc; a click runs the row's function and redraws. */
function* panelLoop(table: number, escExits: boolean): Blocking<void> {
  const ms = mouse();
  const k = shell.keyInput!;
  do {
    const movie = controlsScreenState.movie;
    if (movie) movieBackgroundStep(movie);
    yield* mouseUpdate(ms);
    if (inputPollKey(k) === 3) {
      if (!escExits) break;
      setInt(SHELL_LABEL.controlsExit, 1);
    }
    if (mouseLeftClicked(ms) === 1 || mouseRightClicked(ms) === 1) {
      const row = widgetPanelHit(table, ms.x, ms.y);
      if (row !== 0 && widgetField(row, 'clickFn') !== 0) {
        yield* widgetRowClick(row);
        widgetPanelRedraw(table);
      }
    }
  } while (getInt(SHELL_LABEL.controlsExit) === 0);
}

/**
 * COCKPIT CONTROLS. DATABASE picture 4 over the screen, the erase fill
 * colour 0, then the configuration's start (controlsScreenSetup: the
 * devices, the keyboard, config00). No drivers: nothing more. No keyboard:
 * "Error: keyboard.dll not found." Otherwise the amwlogo1 loop at (120, 4),
 * y 120..479 erased, the two colour tables built (ink -> 0x10 selected,
 * ink -> 7 greyed, 0 transparent), and the device panel run - Esc sets
 * controlsExit 1, a click (either button) runs the row's function and
 * redraws the panel - until controlsExit. Unless that is 1, the binding
 * panel the same way, where Esc leaves at once. Then the movie closed, the
 * drivers freed and the erase fill off. shell_menu redraws the screen.
 *
 * @mw2shell controls_screen 0x00021020
 * @fidelity exact
 */
export function* controlsScreen(): Blocking<void> {
  const d = driver();
  const m = mem();
  screenPaintPicture(d, 4);
  d.fillColour = 0;
  const keyboard = controlsScreenSetup();
  if (inputDeviceCount() !== 0) {
    if (keyboard < 0) {
      // 0x73a5a 'Error: keyboard.dll not found.#Ok'
      yield* messageBox(imageString(0x73a5a), 0);
    } else {
      const k = shell.keyInput!;
      inputFlush(k);
      // 0x73a86 'amwlogo1'
      controlsScreenState.movie = yield* movieOpenBackground(new BackgroundMovie(), imageString(0x73a86), 0x78, 4);
      inputFlush(k);
      videoDriverErase(d, 0, 0x78, 0x280, 0x168);
      const sel = SHELL_LABEL.controlsRemapSelected;
      const full = SHELL_LABEL.controlsRemapFull;
      m.setU8(sel, 0xff);
      m.setU8(sel + 1, 0x10);
      m.setU8(full, 0xff);
      m.setU8(full + 1, 7);
      for (let i = 2; i < 0x100; i++) {
        m.setU8(sel + i, i);
        m.setU8(full + i, i);
      }
      setInt(SHELL_LABEL.controlsExit, 0);
      setInt(SHELL_LABEL.controlsDirty, 0);
      widgetPanelLayout(DEVICE_PANEL);
      yield* panelLoop(DEVICE_PANEL, true);
      widgetPanelFreeLabels(DEVICE_PANEL);
      if (getInt(SHELL_LABEL.controlsExit) !== 1) {
        setInt(SHELL_LABEL.controlsExit, 0);
        widgetPanelLayout(BINDING_PANEL);
        yield* panelLoop(BINDING_PANEL, false);
        widgetPanelFreeLabels(BINDING_PANEL);
      }
      const movie = controlsScreenState.movie;
      if (movie) movieBackgroundClose(movie);
      controlsScreenState.movie = null;
    }
  }
  inputDevicesFree();
  d.fillColour = -1;
}

menuScreens.register(2, controlsScreen);
