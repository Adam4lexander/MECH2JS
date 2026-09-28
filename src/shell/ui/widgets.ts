/**
 * The shell's widget panels: tables of 0x2c-byte rows (MechlabWidget,
 * {x, y, w, h, ?, textStyle, label, drawFn, clickFn, value, extra}) ending
 * at x = -1, laid out, redrawn, hit-tested and freed by one small engine
 * (decompiled/mw2shell/src/screens/shell_2a5e0_part1.c and part2.c). The
 * register's right-hand panels, the options panel (optionsWidgets), the
 * controls screen and the mech lab's CUSTOMIZE panels are all such tables.
 *
 * The tables are the shell's static data: they live in its memory image
 * and are edited in place - widget_panel_layout overwrites a relative y
 * with the absolute one and a w / h of -1 with the label's size, so a
 * second layout of the same table sees absolute values, as in the
 * original. Rows hold code pointers (drawFn, clickFn) resolved through
 * engine/codePtr.ts; a row's draw function returns the TextLabel it put up
 * (or null), and its click function may block (message_box, text_input).
 *
 * The label a row's drawFn returns (+0x18) is a heap object; the port keeps
 * it beside the table (widgetLabels, keyed by the row's address) and
 * leaves the word at +0x18 as the image has it.
 */
import { registerCode, resolveCode, type CodeFn } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import type { Blocking } from '../host/blocking.ts';
import { labelDestroy, remapAt, type TextLabel } from './labels.ts';

/** A row's drawFn: puts up the row's text and returns its label (or null). */
export type WidgetDrawFn = (row: number) => TextLabel | null;
/** A row's clickFn: may block (a message box, a text entry). */
export type WidgetClickFn = (row: number) => Blocking<void>;

/** The MechlabWidget fields, by name, as byte offsets. */
export const WIDGET = {
  x: fieldOffset('MechlabWidget', 'x'),
  y: fieldOffset('MechlabWidget', 'y'),
  w: fieldOffset('MechlabWidget', 'w'),
  h: fieldOffset('MechlabWidget', 'h'),
  textStyle: fieldOffset('MechlabWidget', 'textStyle'),
  label: fieldOffset('MechlabWidget', 'label'),
  drawFn: fieldOffset('MechlabWidget', 'drawFn'),
  clickFn: fieldOffset('MechlabWidget', 'clickFn'),
  value: fieldOffset('MechlabWidget', 'value'),
  extra: fieldOffset('MechlabWidget', 'extra'),
} as const;

/** A row's size: rows are this far apart. */
export const WIDGET_ROW = structSize('MechlabWidget');

export const widgets = registerGlobals(
  'widgetPanels',
  {
    /** each row's +0x18: the TextLabel its drawFn returned, by the row's address */
    labels: new Map<number, TextLabel>(),
  },
  () => {
    widgets.labels = new Map();
  },
  'mw2shell',
);

/** @portOnly registers a ported draw function under its original address, for the rows that point at it */
export function registerWidgetDraw(name: string, address: number, fn: WidgetDrawFn): WidgetDrawFn {
  return registerCode(name, address, fn, 'mw2shell');
}

/** @portOnly registers a ported click function under its original address */
export function registerWidgetClick(name: string, address: number, fn: WidgetClickFn): WidgetClickFn {
  return registerCode(name, address, fn, 'mw2shell');
}

/** @portOnly row i of a table */
export function widgetRow(table: number, i: number): number {
  return table + i * WIDGET_ROW;
}

/** @portOnly a row's int field */
export function widgetField(row: number, f: keyof typeof WIDGET): number {
  return mem().i32(row + WIDGET[f]);
}

/** @portOnly sets a row's int field */
export function setWidgetField(row: number, f: keyof typeof WIDGET, v: number): void {
  mem().setI32(row + WIDGET[f], v);
}

/** @portOnly the C string a row's value points at, or null */
export function widgetValueString(row: number): string | null {
  return mem().ptrStr(row + WIDGET.value);
}

/** @portOnly the colour table a row's textStyle points at (null: none, the identity) */
export function widgetTextStyle(row: number): Uint8Array | null {
  const p = mem().u32(row + WIDGET.textStyle);
  return p === 0 ? null : remapAt(p);
}

/** @portOnly the label a row's drawFn put up, or null */
export function widgetLabel(row: number): TextLabel | null {
  return widgets.labels.get(row) ?? null;
}

/** @portOnly stores (or with null clears) a row's label */
export function setWidgetLabel(row: number, label: TextLabel | null): void {
  if (label) widgets.labels.set(row, label);
  else widgets.labels.delete(row);
}

/** The row's drawFn, resolved; null for none (0). An address nothing is registered for is a port gap. */
function drawFnOf(row: number): WidgetDrawFn | null {
  const addr = mem().u32(row + WIDGET.drawFn);
  if (addr === 0) return null;
  const fn = resolveCode(addr, 'mw2shell') as CodeFn | null;
  if (!fn) throw new Error(`widget row 0x${row.toString(16)}: its drawFn 0x${addr.toString(16)} is not ported`);
  return fn as WidgetDrawFn;
}

/** The row's clickFn, resolved; null for none. */
function clickFnOf(row: number): WidgetClickFn | null {
  const addr = mem().u32(row + WIDGET.clickFn);
  if (addr === 0) return null;
  const fn = resolveCode(addr, 'mw2shell') as CodeFn | null;
  if (!fn) throw new Error(`widget row 0x${row.toString(16)}: its clickFn 0x${addr.toString(16)} is not ported`);
  return fn as WidgetClickFn;
}

/** label_destroy and the free: what every "drop this row's label" does. */
function freeLabel(row: number): void {
  const label = widgetLabel(row);
  if (label) {
    labelDestroy(label);
    setWidgetLabel(row, null);
  }
}

/**
 * (rows): lays out and draws a table, row by row until x == -1. A y with
 * bit 31 set is relative: previous y + ((y & 0xff0) >> 4) * previous h +
 * (y & 0xf). Then the row's drawFn (if any) puts up its label, stored as
 * the row's label (a previous label is not freed). A w or h of -1 is taken
 * from that label's width / height; one still -1 becomes 0 (w) or the
 * previous row's h. The resolved y and h carry to the next row. Every
 * value is written back into the table.
 *
 * @mw2shell widget_panel_layout 0x0002ac90
 * @fidelity exact
 */
export function widgetPanelLayout(table: number): void {
  if (table === 0) return;
  const m = mem();
  let prevY = 0;
  let prevH = 0;
  for (let row = table; m.i32(row + WIDGET.x) !== -1; row += WIDGET_ROW) {
    const y = m.i32(row + WIDGET.y);
    if (y < 0) m.setI32(row + WIDGET.y, (prevY + ((y & 0xff0) >> 4) * prevH + (y & 0xf)) | 0);
    const draw = drawFnOf(row);
    const label = draw ? draw(row) : null;
    setWidgetLabel(row, label);
    if (label) {
      if (m.i32(row + WIDGET.w) === -1) m.setI32(row + WIDGET.w, label.width);
      if (m.i32(row + WIDGET.h) === -1) m.setI32(row + WIDGET.h, label.height);
    }
    if (m.i32(row + WIDGET.w) === -1) m.setI32(row + WIDGET.w, 0);
    if (m.i32(row + WIDGET.h) === -1) m.setI32(row + WIDGET.h, prevH);
    prevY = m.i32(row + WIDGET.y);
    prevH = m.i32(row + WIDGET.h);
  }
}

/**
 * (rows): frees every row's label, then calls every drawFn again and keeps
 * the new labels. Positions are not recomputed.
 *
 * @mw2shell widget_panel_redraw 0x0002ad30
 * @fidelity exact
 */
export function widgetPanelRedraw(table: number): void {
  if (table === 0) return;
  const m = mem();
  for (let row = table; m.i32(row + WIDGET.x) !== -1; row += WIDGET_ROW) freeLabel(row);
  for (let row = table; m.i32(row + WIDGET.x) !== -1; row += WIDGET_ROW) {
    const draw = drawFnOf(row);
    if (draw) setWidgetLabel(row, draw(row));
  }
}

/**
 * (rows): frees every row's label and clears the field.
 *
 * @mw2shell widget_panel_free_labels 0x0002ada0
 * @fidelity exact
 */
export function widgetPanelFreeLabels(table: number): void {
  if (table === 0) return;
  const m = mem();
  for (let row = table; m.i32(row + WIDGET.x) !== -1; row += WIDGET_ROW) freeLabel(row);
}

/**
 * (rows, x, y): the first row with a clickFn whose [x, x + w) x [y, y + h)
 * holds the point - its address - or 0.
 *
 * @mw2shell widget_panel_hit 0x000305a0
 * @fidelity exact
 */
export function widgetPanelHit(table: number, x: number, y: number): number {
  if (table === 0) return 0;
  const m = mem();
  for (let row = table; ; row += WIDGET_ROW) {
    const rx = m.i32(row + WIDGET.x);
    if (rx === -1) return 0;
    if (m.u32(row + WIDGET.clickFn) === 0) continue;
    const ry = m.i32(row + WIDGET.y);
    if (rx <= x && x < rx + m.i32(row + WIDGET.w) && ry <= y && y < ry + m.i32(row + WIDGET.h)) return row;
  }
}

/**
 * @portOnly `row->clickFn(row)`, the call the options panel, the controls
 * screen and the mech lab make on the row widget_panel_hit returned; a row
 * with no clickFn does nothing
 */
export function* widgetRowClick(row: number): Blocking<void> {
  if (row === 0) return;
  const click = clickFnOf(row);
  if (click) yield* click(row);
}
