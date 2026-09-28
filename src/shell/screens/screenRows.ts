/**
 * The screens' per-career rows (README "Screen rows: buttons and
 * background"): each screen keeps a table of three 0x10-byte rows, one per
 * career, {buttons, buttonCount, background, music}, and indexes it by the
 * career for button_bar_create's defs and count and for
 * screen_load_background's item.
 *
 * ScreenRow is typed in Mw2shellTypes.java (buildScreenRow) but reaches
 * the generated schemas only with the next Ghidra pipeline run, so its
 * offsets are spelled out here: +0 buttons (ButtonDef *), +4 buttonCount,
 * +8 background (a DATABASE.MW2 item), +0xc music (-1 or an XMIDI item;
 * no reader).
 *
 * @portOnly reads the screens' row tables in the shell's image
 */
import { mem } from '../memory.ts';
import { buttonDefsAt, type ButtonDef } from '../ui/buttonBar.ts';

/** A row's size, and the rows' field offsets (ScreenRow, 0x10 bytes). */
export const SCREEN_ROW = { size: 0x10, buttons: 0x0, buttonCount: 0x4, background: 0x8, music: 0xc } as const;

/** @portOnly the address of row[career] of a row table */
export function screenRowAt(table: number, career: number): number {
  return table + career * SCREEN_ROW.size;
}

/** @portOnly row[career].background */
export function screenRowBackground(table: number, career: number): number {
  return mem().i32(screenRowAt(table, career) + SCREEN_ROW.background);
}

/** @portOnly row[career].buttonCount */
export function screenRowButtonCount(table: number, career: number): number {
  return mem().i32(screenRowAt(table, career) + SCREEN_ROW.buttonCount);
}

/** @portOnly row[career].buttons, the table's address (0 for a career with no row) */
export function screenRowButtonsAddr(table: number, career: number): number {
  return mem().u32(screenRowAt(table, career) + SCREEN_ROW.buttons);
}

/** @portOnly `count` ButtonDefs through row[career].buttons (none for a NULL pointer) */
export function screenRowButtons(table: number, career: number, count: number): ButtonDef[] {
  const addr = screenRowButtonsAddr(table, career);
  return addr === 0 ? [] : buttonDefsAt(addr, count);
}
