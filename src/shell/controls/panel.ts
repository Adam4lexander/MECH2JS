/**
 * The COCKPIT CONTROLS panels' click functions that change the
 * configuration (decompiled/mw2shell/src/controls/controls.c): the device
 * panel's device rows, ACCEPT and CUSTOM CONFIGURATION, and the GAME
 * CONTROLS panel's page title, direction, modifier and binding cells, its
 * Directional and Buttons lists, its INPUT DEVICES rows and ABORT. The rows
 * of controlsDevicePanel / controlsBindingPanel point at them by address;
 * each is registered here under its own.
 *
 * The draw functions and the ones that run a loop of their own (the name
 * field, the Buttons list's arrows) are the screen's
 * (shell/screens/controls.ts).
 *
 * A row's value (+0x24) is the control, device or list entry it stands for.
 * The binding cells edit controlsBindings[value], the page shown.
 */
import { quirk, unestablished } from '../../core/provenance.ts';
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import type { Blocking } from '../host/blocking.ts';
import { mem } from '../memory.ts';
import { mouse } from '../state.ts';
import { mouseRightClicked } from '../ui/mouse.ts';
import { registerWidgetClick, widgetField, widgetRow, type WidgetClickFn } from '../ui/widgets.ts';
import {
  bindingAt,
  bindingField,
  controlsDeviceChosen,
  controlsLoadConfig,
  controlsResetDefaults,
  controlsSaveConfig,
  CONTROLS,
  currentBinding,
  deviceRecord,
  setBindingField,
  setControlsDeviceChosen,
} from './config.ts';
import { inputDeviceGet, type ShellInputDevice } from './devices.ts';
import { controlsAcceptConfig } from './inputMap.ts';

function getInt(label: number): number {
  return mem().i32(label);
}
function setInt(label: number, v: number): void {
  mem().setI32(label, v);
}

/** a row's value: the control, device or list entry it stands for */
function valueOf(row: number): number {
  return widgetField(row, 'value');
}

/** @portOnly a click function that does not block, as the widget engine calls it */
function click(name: string, address: number, fn: (row: number) => void): WidgetClickFn {
  // the engine yield*s every click function; these never block
  // eslint-disable-next-line require-yield
  return registerWidgetClick(name, address, function* (row) {
    fn(row);
  });
}

/** the device the lists show (controlsDevice) */
function shownDevice(): ShellInputDevice | null {
  return inputDeviceGet(getInt(SHELL_LABEL.controlsDevice));
}

/** a device's axis (kind 0) or button name table and its count, as controls_next_input picks them */
function inputTable(dev: ShellInputDevice, axis: boolean): { names: (string | null)[] | null; count: number } {
  return axis ? { names: dev.record.analogNames, count: dev.record.analogCount } : { names: dev.record.buttonNames, count: dev.record.buttonCount };
}

/**
 * The page title's click: the next of the four pages (after Quaternary,
 * Primary), and controlsBindings at its first binding. The pages are not
 * alternatives - controls_write_temp_map writes all four.
 *
 * @mw2shell controls_next_config_page 0x0001e990
 * @fidelity exact
 */
export function controlsNextConfigPage(): void {
  let page = getInt(SHELL_LABEL.controlsPage) + 1;
  if (page > 3) page = 0;
  setInt(SHELL_LABEL.controlsPage, page);
  setInt(SHELL_LABEL.controlsBindings, bindingAt(SHELL_LABEL.controlBindings, page * CONTROLS));
}
click('controls_next_config_page', 0x0001e990, controlsNextConfigPage);

/**
 * The direction cell's click (axis controls 0..6): the axis reversed, or
 * back - bit 31 of the binding's flags (byte +0xb ^ 0x80).
 *
 * @mw2shell controls_toggle_axis_direction 0x0001ea30
 * @fidelity exact
 */
export function controlsToggleAxisDirection(row: number): void {
  const a = currentBinding(valueOf(row)) + 0xb;
  mem().setU8(a, mem().u8(a) ^ 0x80);
}
click('controls_toggle_axis_direction', 0x0001ea30, controlsToggleAxisDirection);

/**
 * The modifier cell's click: none -> Ctrl (1) -> Alt (2) -> Shift (4) ->
 * none, the reversal bit kept. The first step is taken only from flags 0:
 * a reversed axis (flags 0x80000000) with no modifier stays without one.
 *
 * @mw2shell controls_cycle_modifier 0x0001eab0
 * @fidelity exact
 */
export function controlsCycleModifier(row: number): void {
  const b = currentBinding(valueOf(row));
  const f = bindingField(b, 'flags') >>> 0;
  if (f === 0) {
    mem().setU8(b + 8, mem().u8(b + 8) | 1);
    return;
  }
  if (f === 0x80000000) quirk('controls_cycle_modifier: a reversed axis with no modifier cannot be given one (only flags == 0 steps to Ctrl)');
  setBindingField(b, 'flags', (f & 0x80000000) | ((f * 2) & 7));
}
click('controls_cycle_modifier', 0x0001eab0, controlsCycleModifier);

/**
 * ABORT (both panels): controlsExit = 1, leaving without saving.
 *
 * @mw2shell controls_abort 0x0001eaf0
 * @fidelity exact
 */
export function controlsAbort(): void {
  setInt(SHELL_LABEL.controlsExit, 1);
}
click('controls_abort', 0x0001eaf0, controlsAbort);

/**
 * After a binding cell's click: when the selected cell is a button (kind 1
 * or 2) on the device the lists show, the Buttons list scrolls to put its
 * button (input, or input2 in column 1) at the top, clamped so the 18 rows
 * stay filled.
 *
 * @mw2shell controls_scroll_to_selection 0x0001eb00
 * @fidelity exact
 */
export function controlsScrollToSelection(): void {
  const dev = shownDevice();
  const b = currentBinding(getInt(SHELL_LABEL.controlsSelectedControl));
  if (getInt(SHELL_LABEL.controlsDevice) !== bindingField(b, 'device') || bindingField(b, 'kind') === 0) return;
  let scroll = getInt(SHELL_LABEL.controlsSelectedColumn) === 1 ? bindingField(b, 'input2') : bindingField(b, 'input');
  if (scroll < 0) scroll = 0;
  const count = dev ? dev.record.buttonCount : 0;
  if (!dev) unestablished('controls_scroll_to_selection: controlsDevice is not a loaded device (the original reads through a NULL record)');
  if (count <= scroll + 0x12) scroll = count - 0x12;
  if (scroll < 0) scroll = 0;
  setInt(SHELL_LABEL.controlsButtonScroll, scroll);
}

/**
 * (binding, column): input (column 0) or input2 (1) moves to the binding
 * device's next axis (kind 0) or button whose name is set, not empty and
 * not starting with '*'; past the last one both the input and the device
 * become -1.
 *
 * @mw2shell controls_next_input 0x0001eb90
 * @fidelity exact
 */
export function controlsNextInput(b: number, column: number): void {
  const dev = inputDeviceGet(bindingField(b, 'device'));
  if (!dev) {
    unestablished('controls_next_input: the binding\'s device is not loaded (the original reads through a NULL record)');
    return;
  }
  const { names, count } = inputTable(dev, bindingField(b, 'kind') === 0);
  let i = column === 0 ? bindingField(b, 'input') : bindingField(b, 'input2');
  if (i < 0) i = -1;
  for (;;) {
    i++;
    if (count <= i) break;
    const n = names?.[i] ?? null;
    if (n !== null && n.length !== 0 && n[0] !== '*') break;
  }
  if (count <= i) {
    i = -1;
    setBindingField(b, 'device', -1);
  }
  setBindingField(b, column === 0 ? 'input' : 'input2', i);
}

/** The right button on a binding cell: the whole binding cleared and its first cell selected. */
function clearBinding(row: number): void {
  const v = valueOf(row);
  const b = currentBinding(v);
  setBindingField(b, 'device', -1);
  if (bindingField(b, 'kind') === 2) setBindingField(b, 'kind', 0);
  setBindingField(b, 'flags', 0);
  setBindingField(b, 'flags2', 0);
  setBindingField(b, 'input', -1);
  setBindingField(b, 'input2', -1);
  setInt(SHELL_LABEL.controlsSelectedControl, v);
  setInt(SHELL_LABEL.controlsSelectedColumn, 0);
}

/**
 * The binding cell's click. The right button clears the binding (device and
 * inputs -1, an axis on buttons back to an axis, no modifier) and selects
 * it. A left click on a cell not selected selects it (column 0). On the
 * selected cell it steps to the next input of the device the lists show:
 * an axis control (kind 0) on a device with axes - a device it is not on
 * yet starts at axis 0; a button control (kind 1) on a device with buttons;
 * an axis on buttons (kind 2) steps its first button on its own device
 * (when that runs out it keeps its second button, or with none becomes an
 * unbound axis), or moves to the shown device's first button - or, on a
 * device with axes and no buttons, becomes an axis there. Then the Buttons
 * list scrolls to the selection.
 *
 * @mw2shell controls_click_binding 0x0001ec10
 * @fidelity exact
 */
export function controlsClickBinding(row: number): void {
  const dev = shownDevice();
  if (mouseRightClicked(mouse()) === 1) {
    clearBinding(row);
    return;
  }
  const v = valueOf(row);
  if (getInt(SHELL_LABEL.controlsSelectedControl) !== v || getInt(SHELL_LABEL.controlsSelectedColumn) !== 0) {
    setInt(SHELL_LABEL.controlsSelectedControl, v);
    setInt(SHELL_LABEL.controlsSelectedColumn, 0);
    controlsScrollToSelection();
    return;
  }
  if (!dev) unestablished('controls_click_binding: controlsDevice is not a loaded device (the original reads through a NULL record)');
  const axes = dev ? dev.record.analogCount : 0;
  const buttons = dev ? dev.record.buttonCount : 0;
  const shown = getInt(SHELL_LABEL.controlsDevice);
  const b = currentBinding(v);
  const kind = bindingField(b, 'kind') >>> 0;
  if (kind === 0) {
    if (axes !== 0) {
      if (shown !== bindingField(b, 'device')) {
        setBindingField(b, 'device', shown);
        setBindingField(b, 'input', 0);
      } else controlsNextInput(b, 0);
    }
  } else if (kind === 1) {
    if (buttons !== 0) {
      if (shown !== bindingField(b, 'device')) {
        setBindingField(b, 'device', shown);
        setBindingField(b, 'input', -1);
      }
      controlsNextInput(b, 0);
    }
  } else if (kind === 2) {
    if (shown === bindingField(b, 'device')) {
      controlsNextInput(b, 0);
      if (bindingField(b, 'input') < 0) {
        if (bindingField(b, 'input2') < 0) setBindingField(b, 'kind', 0);
        else setBindingField(b, 'device', shown);
      }
    } else if (buttons !== 0) {
      setBindingField(b, 'device', shown);
      setBindingField(b, 'input', -1);
      setBindingField(b, 'input2', -1);
      controlsNextInput(b, 0);
    } else if (axes !== 0) {
      setBindingField(b, 'kind', 0);
      setBindingField(b, 'device', shown);
      setBindingField(b, 'input', -1);
      setBindingField(b, 'input2', -1);
      controlsNextInput(b, 0);
    }
  }
  controlsScrollToSelection();
}
click('controls_click_binding', 0x0001ec10, controlsClickBinding);

/**
 * The second button's cell (kind 2 only). The right button clears the
 * whole binding, as on the first cell. A left click on a cell not selected
 * selects it (column 1) when the control is an axis on buttons. On the
 * selected cell: on its own device input2 steps to the next button (when
 * it runs out the binding keeps its first button, or with none becomes an
 * unbound axis back in column 0); on another device with buttons it moves
 * there with input -1 and input2 0 (button 0, unchecked); on a device with
 * axes and no buttons it becomes an axis there on axis 0 (column 0). Then
 * the Buttons list scrolls to the selection.
 *
 * @mw2shell controls_click_second_button 0x0001ef30
 * @fidelity exact
 */
export function controlsClickSecondButton(row: number): void {
  const dev = shownDevice();
  if (mouseRightClicked(mouse()) === 1) {
    clearBinding(row);
    return;
  }
  const v = valueOf(row);
  const b = currentBinding(v);
  if (getInt(SHELL_LABEL.controlsSelectedControl) === v && getInt(SHELL_LABEL.controlsSelectedColumn) === 1) {
    const shown = getInt(SHELL_LABEL.controlsDevice);
    if (shown === bindingField(b, 'device')) {
      controlsNextInput(b, 1);
      if (bindingField(b, 'input2') < 0) {
        if (bindingField(b, 'input') < 0) {
          setBindingField(b, 'kind', 0);
          setInt(SHELL_LABEL.controlsSelectedColumn, 0);
        } else setBindingField(b, 'device', shown);
      }
    } else {
      if (!dev) unestablished('controls_click_second_button: controlsDevice is not a loaded device (the original reads through a NULL record)');
      if (dev && dev.record.buttonCount !== 0) {
        setBindingField(b, 'device', shown);
        setBindingField(b, 'input', -1);
        setBindingField(b, 'input2', 0);
      } else if (dev && dev.record.analogCount !== 0) {
        setBindingField(b, 'device', shown);
        setBindingField(b, 'kind', 0);
        setBindingField(b, 'input', 0);
        setInt(SHELL_LABEL.controlsSelectedColumn, 0);
        setBindingField(b, 'input2', -1);
      }
    }
  } else if (bindingField(b, 'kind') === 2) {
    setInt(SHELL_LABEL.controlsSelectedControl, v);
    setInt(SHELL_LABEL.controlsSelectedColumn, 1);
  }
  controlsScrollToSelection();
}
click('controls_click_second_button', 0x0001ef30, controlsClickSecondButton);

/**
 * A Directional row's click (value = axis): binds that axis of the shown
 * device to the selected control - kind 0, input the axis, input2 -1,
 * column 0 - unless no cell is selected, the axis is past the device's or
 * has no name or title, or the control is a button (kind 1).
 *
 * @mw2shell controls_pick_axis 0x0001f2c0
 * @fidelity exact
 */
export function controlsPickAxis(row: number): void {
  const dev = shownDevice();
  const sel = getInt(SHELL_LABEL.controlsSelectedControl);
  if (sel < 0) return;
  const axis = valueOf(row);
  if (!dev || axis >= dev.record.analogCount) return;
  if ((dev.record.analogNames?.[axis] ?? null) === null || (dev.record.analogTitles?.[axis] ?? null) === null) return;
  const b = currentBinding(sel);
  if (bindingField(b, 'kind') === 1) return;
  setBindingField(b, 'kind', 0);
  setBindingField(b, 'device', getInt(SHELL_LABEL.controlsDevice));
  setBindingField(b, 'input2', -1);
  setBindingField(b, 'input', axis);
  setInt(SHELL_LABEL.controlsSelectedColumn, 0);
}
click('controls_pick_axis', 0x0001f2c0, controlsPickAxis);

/**
 * A Buttons row's click (value + controlsButtonScroll = the button): binds
 * it to the selected cell, unless no cell is selected, the button is past
 * the device's, or its name or title is missing or empty, or its name
 * starts with '*'. Column 1: input2 (moving the binding to the shown
 * device drops its first button; with no first button the selection goes
 * back to column 0). Column 0: input on the shown device - an axis control
 * (kind 0) becoming an axis on two buttons (kind 2) whose selection moves
 * on to the second button; a move to another device drops input2.
 *
 * @mw2shell controls_pick_button 0x0001f460
 * @fidelity exact
 */
export function controlsPickButton(row: number): void {
  const dev = shownDevice();
  const i = valueOf(row) + getInt(SHELL_LABEL.controlsButtonScroll);
  const sel = getInt(SHELL_LABEL.controlsSelectedControl);
  if (sel < 0 || !dev || i >= dev.record.buttonCount) return;
  const name = dev.record.buttonNames?.[i] ?? null;
  const title = dev.record.buttonDescriptions?.[i] ?? null;
  if (name === null || title === null || name.length === 0 || title.length === 0 || name[0] === '*') return;
  const shown = getInt(SHELL_LABEL.controlsDevice);
  const b = currentBinding(sel);
  if (getInt(SHELL_LABEL.controlsSelectedColumn) === 1) {
    if (shown !== bindingField(b, 'device')) {
      setBindingField(b, 'input', -1);
      setBindingField(b, 'device', shown);
    }
    setBindingField(b, 'input2', i);
    if (bindingField(b, 'input') < 0) setInt(SHELL_LABEL.controlsSelectedColumn, 0);
  } else {
    if (bindingField(b, 'kind') === 0) {
      setBindingField(b, 'kind', 2);
      setBindingField(b, 'input2', -1);
    }
    if (shown !== bindingField(b, 'device')) setBindingField(b, 'input2', -1);
    setBindingField(b, 'input', i);
    setBindingField(b, 'device', shown);
    if (bindingField(b, 'kind') === 2 && bindingField(b, 'input2') < 0) setInt(SHELL_LABEL.controlsSelectedColumn, 1);
  }
}
click('controls_pick_button', 0x0001f460, controlsPickButton);

/**
 * A device row's click on the device panel (value = device): chooses or
 * drops the device, at most four chosen (controlsDeviceCount), and marks
 * the choice changed (controlsDirty). A row with no device, and the one
 * whose record is named 'keyboard', do nothing.
 *
 * @mw2shell controls_toggle_device 0x0001f6a0
 * @fidelity exact
 */
export function controlsToggleDevice(row: number): void {
  const v = valueOf(row);
  if (!inputDeviceGet(v)) return;
  // strcmp(controlsDeviceRecords[v].name, 0x7361a 'keyboard')
  if (deviceRecord(v).name === mem().cstr(0x7361a)) return;
  const count = getInt(SHELL_LABEL.controlsDeviceCount);
  if (!controlsDeviceChosen(v)) {
    if (count < 4) {
      setInt(SHELL_LABEL.controlsDirty, 1);
      setInt(SHELL_LABEL.controlsDeviceCount, count + 1);
      setControlsDeviceChosen(v, 1);
    }
  } else {
    setControlsDeviceChosen(v, 0);
    setInt(SHELL_LABEL.controlsDeviceCount, count - 1);
    setInt(SHELL_LABEL.controlsDirty, 1);
  }
}
click('controls_toggle_device', 0x0001f6a0, controlsToggleDevice);

/**
 * An INPUT DEVICES row's click (value = device): a chosen device becomes
 * the one the lists show (controlsDevice), the Buttons list at its top.
 *
 * @mw2shell controls_show_device 0x0001f740
 * @fidelity exact
 */
export function controlsShowDevice(row: number): void {
  const v = valueOf(row);
  if (!controlsDeviceChosen(v) || !inputDeviceGet(v)) return;
  setInt(SHELL_LABEL.controlsDevice, v);
  setInt(SHELL_LABEL.controlsButtonScroll, 0);
}
click('controls_show_device', 0x0001f740, controlsShowDevice);

/**
 * The device panel's ACCEPT: when the choice changed, the bindings rebuilt
 * from the chosen devices' defaults (RESET DEFAULTS) and accepted (ACCEPT
 * CONFIG AND EXIT: input.map and config00.cpc); then the screen ends.
 *
 * @mw2shell controls_accept 0x0001f7e0
 * @fidelity exact
 */
export function* controlsAccept(): Blocking<void> {
  if (getInt(SHELL_LABEL.controlsDirty) !== 0) {
    controlsResetDefaults();
    yield* controlsAcceptConfig();
  }
  setInt(SHELL_LABEL.controlsExit, 1);
}
registerWidgetClick('controls_accept', 0x0001f7e0, controlsAccept);

/**
 * CUSTOM CONFIGURATION: the bindings rebuilt from the chosen devices'
 * defaults (RESET DEFAULTS), and the device panel ended with controlsExit
 * 10000 (the EDX it loads before the call, 0x2710) - anything but 1 sends
 * controls_screen on to the GAME CONTROLS panel.
 *
 * @mw2shell controls_custom_config 0x0001f810
 * @fidelity exact
 */
export function controlsCustomConfig(): void {
  controlsResetDefaults();
  setInt(SHELL_LABEL.controlsExit, 0x2710);
}
click('controls_custom_config', 0x0001f810, controlsCustomConfig);

// The binding panel's file rows point straight at the configuration's functions (shell/controls/config.ts, inputMap.ts).
click('controls_load_config', 0x00020a40, controlsLoadConfig);
registerWidgetClick('controls_save_config', 0x00020b00, controlsSaveConfig);
click('controls_reset_defaults', 0x00020c10, () => controlsResetDefaults());
registerWidgetClick('controls_accept_config', 0x00020e60, () => controlsAcceptConfig());

/**
 * The controlsDevicePanel row that chooses device i (its clickFn
 * controls_toggle_device, its value i), or 0.
 *
 * @portOnly finds a table row by what it points at, for the first-run seed and tests
 */
export function controlsDeviceRow(i: number): number {
  return findRow(SHELL_LABEL.controlsDevicePanel, 0x0001f6a0, i);
}

/** @portOnly the first row of `table` whose clickFn is `clickFn` and whose value is `value`, or 0 */
export function findRow(table: number, clickFn: number, value: number): number {
  for (let k = 0; ; k++) {
    const row = widgetRow(table, k);
    if (widgetField(row, 'x') === -1) return 0;
    if (widgetField(row, 'clickFn') >>> 0 === clickFn && widgetField(row, 'value') === value) return row;
  }
}
