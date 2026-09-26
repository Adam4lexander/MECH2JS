/**
 * The mission objectives display (hudWidgets[15]): 'MISSION OBJECTIVES'
 * underlined, the objectives of the displayed table category by category
 * (primary, secondary, tertiary, return), each with its status right-aligned
 * in the pane, and a clock line - time remaining or elapsed while the table
 * is undecided, the time it was decided at otherwise.
 *
 * Text colour is the ink byte of the text colour table (0xa4dd2 in the
 * original, textColourTable[14] here): 6 for headings, 0xe for text, 7 for
 * 'Successful', 0xb for 'Failed'.
 */
import type { HudWidget, ViewWindow } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv, cmod } from '../../core/int/cint.ts';
import { quirk } from '../../core/provenance.ts';
import { clock } from '../../engine/clock.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { vfxCharacterWidth, vfxFontHeight, vfxLineDraw, vfxStringDraw } from '../../engine/vfx/vfx.ts';
import { objectives } from '../../mission/objectives.ts';
import { display } from '../display/video.ts';
import { hudFont, hudFontUnlock, widgetPane } from './hud.ts';

function bootObjectivesHud() {
  return {
    /** 0x968d8: the objectives display is up; a player command toggles it */
    objectivesDisplayOn: imageI32(LABEL.objectivesDisplayOn, 0),
    /** 0x968dc: which ObjectiveTable (group) the display shows */
    objectivesDisplayTable: imageI32(LABEL.objectivesDisplayTable, 0),
  };
}

export const objectivesHud = registerGlobals('objectivesHud', bootObjectivesHud(), () => {
  Object.assign(objectivesHud, bootObjectivesHud());
});

const ink = (c: number): void => {
  display.textColourTable[0xe] = c;
};

/** C's %2.2d: at least two digits, the sign before them, then padded to width 2. */
function d22(v: number): string {
  const digits = String(Math.abs(v)).padStart(2, '0');
  return (v < 0 ? '-' : '') + digits;
}

/**
 * Ticks as 'hh:mm:ss.ss': ticks / (3600 * 182) hours, the remainder / (60 *
 * 182) minutes, and the rest times 1/182 (the double at 0x90bbf) as seconds,
 * '%2.2d:%2.2d:%05.2f'. The original returns a static buffer (0xfe120).
 *
 * @mw2 format_ticks_hms 0x000317b0
 * @fidelity exact
 */
export function timeFormatSub0317b0(ticks: number): string {
  const h = cdiv(ticks, 0x9ff60);
  const r = cmod(ticks, 0x9ff60);
  const m = cdiv(r, 0x2aa8);
  const s = cmod(r, 0x2aa8) * 0.005494505494505494;
  let f = Math.abs(s).toFixed(2);
  if (s < 0) f = '-' + f;
  return `${d22(h)}:${d22(m)}:${f.padStart(5, '0')}`;
}

/**
 * A count as 'hh:mm:ss' - / 3600, % 3600 / 60, % 60 - '%2.2d:%2.2d:%2.2d'.
 * The original returns a static buffer (0xfe130).
 *
 * @mw2 format_hms 0x00031850
 * @fidelity exact
 */
export function timeFormatSub031850(t: number): string {
  return `${d22(cdiv(t, 0xe10))}:${d22(cdiv(cmod(t, 0xe10), 0x3c))}:${d22(cmod(cmod(t, 0xe10), 0x3c))}`;
}

/**
 * A string's width in pixels: the sum of its characters' widths (the font
 * comes in EDX); 0 for an empty string.
 *
 * @mw2 text_width 0x000318c0
 * @fidelity exact
 */
export function timeFormatSub0318c0(text: string, font: Uint8Array): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) w = (w + vfxCharacterWidth(font, text.charCodeAt(i) & 0xff)) | 0;
  return w;
}

/**
 * Underlines text drawn at (x, y): a mode-0 line in colour from (x, y +
 * font height) to (x + width - 1, the same y). Arguments (pane EAX, text EDX,
 * then x, y, font, colour on the stack; ret 0x10), from the disassembly
 * 0x13a40..0x13acb.
 *
 * @mw2 hud_text_underline 0x00013a40
 * @fidelity exact
 */
export function vfxFontSub013a40(pane: ViewWindow, text: string, x: number, y: number, font: Uint8Array, colour: number): void {
  const yy = (y + vfxFontHeight(font)) | 0;
  let w = 0;
  for (let i = 0; i < text.length; i++) w = (w + vfxCharacterWidth(font, text.charCodeAt(i) & 0xff)) | 0;
  vfxLineDraw(pane, x, yy, (x + w - 1) | 0, yy, 0, colour);
}

/**
 * One category of the objectives display: for each listed objective of the
 * displayed table whose category matches, at the text position's x - the
 * category label ('Primary: ', 'Secondary: ', 'Return: ' for 1, 2, 8,
 * 'Tertiary: ' for anything else) in 6, then, indented by the width of
 * 'Secondary: ' whatever the label, the text in 0xe - split after 32
 * characters onto a second line - and the status right-aligned against the
 * pane's width: 'Successful' (state 5) in 7, 'Failed' (6) in 0xb, else 'In
 * progress'. pos {x, y} is advanced a line (two for a split text).
 * Arguments (widget EAX, pos EDX, font EBX, category ECX).
 *
 * @mw2 objectives_draw_category 0x00031930
 * @fidelity exact
 */
export function objectivesDrawCategory(w: HudWidget, pos: Int32Array, font: Uint8Array, category: number): void {
  const pane = widgetPane(w);
  const t = objectives.objectiveTables[objectivesHud.objectivesDisplayTable]!;
  const fh = vfxFontHeight(font);
  const table = display.textColourTable;
  for (let i = 0; i < t.count; i++) {
    const o = t.objectives[i]!;
    if (o.listed === 0 || (category & 0xff) !== o.category) continue;
    pos[0] = (w.textPos as Int32Array)[0]!;
    let split = 0;
    const label = category === 1 ? 'Primary: ' : category === 2 ? 'Secondary: ' : category === 8 ? 'Return: ' : 'Tertiary: ';
    ink(6);
    vfxStringDraw(pane, pos[0]!, pos[1]!, font, label, table);
    ink(0xe);
    let indent = 0;
    for (const ch of 'Secondary: ') indent = (indent + vfxCharacterWidth(font, ch.charCodeAt(0))) | 0;
    pos[0] = (pos[0]! + indent) | 0;
    const text = o.text;
    if (text.length < 0x20) {
      ink(0xe);
      vfxStringDraw(pane, pos[0]!, pos[1]!, font, text, table);
      ink(0xe);
    } else {
      const x = pos[0]!;
      const y = pos[1]!;
      ink(0xe);
      vfxStringDraw(pane, pos[0]!, pos[1]!, font, text.slice(0, 0x20), table);
      pos[0] = x;
      pos[1] = (pos[1]! + fh) | 0;
      ink(0xe);
      split = 1;
      vfxStringDraw(pane, pos[0]!, pos[1]!, font, text.slice(0x20), table);
      ink(0xe);
      pos[0] = x;
      pos[1] = y;
    }
    const state = o.state & 0xff;
    const status = state === 5 ? 'Successful' : state === 6 ? 'Failed' : 'In progress';
    pos[0] = (pane.right - pane.left - timeFormatSub0318c0(status, font)) | 0;
    ink(state === 5 ? 7 : state === 6 ? 0xb : 0xe);
    vfxStringDraw(pane, pos[0]!, pos[1]!, font, status, table);
    ink(0xe);
    const y = pos[1]!;
    pos[1] = (y + fh) | 0;
    if (split !== 0) pos[1] = (y + fh + fh) | 0;
  }
}

/**
 * The objectives widget's running-state hook: while the widget is visible
 * and objectivesDisplayOn, draws 'MISSION OBJECTIVES' (in 6, underlined in
 * 6) at the text position, the categories 1, 2, 4, 0 and 8 - half a line
 * between 1, 2, 4 and 8, none between 4 and 0 - and then, a line and a half
 * down at the text position's x, the clock line in 6: 'Time Remaining: %s'
 * ((timeLimit + startTime) * 182 - simTick) or 'Elapsed Time: %s' (simTick -
 * startTime * 182, when there is no time limit) while the result is 0;
 * 'Successful at %s', 'Failed at %s', 'Out of time at %s' of decidedAt for
 * results 2, 3, 4.
 *
 * @mw2 hud_objectives_draw 0x00031d60
 * @fidelity exact
 * @divergence for any other result (1, or above 4) the original skips its sprintf and draws its uninitialised 256-byte stack buffer; the port draws an empty string there
 */
export const hudObjectivesDraw = registerCode('hud_objectives_draw', 0x31d60, (w: HudWidget): void => {
  if (w.visible === 0 || objectivesHud.objectivesDisplayOn === 0) return;
  const t = objectives.objectiveTables[objectivesHud.objectivesDisplayTable]!;
  const font = hudFont();
  if (!font) return;
  const pane = widgetPane(w);
  const table = display.textColourTable;
  const fh = vfxFontHeight(font);
  const half = cdiv(fh, 2);
  const tp = w.textPos as Int32Array;
  const pos = Int32Array.of(tp[0]!, tp[1]!);
  ink(6);
  vfxStringDraw(pane, pos[0]!, pos[1]!, font, 'MISSION OBJECTIVES', table);
  ink(0xe);
  vfxFontSub013a40(pane, 'MISSION OBJECTIVES', pos[0]!, pos[1]!, font, 6);
  const gap = (fh + half) | 0;
  pos[1] = (pos[1]! + gap) | 0;
  objectivesDrawCategory(w, pos, font, 1);
  pos[1] = (pos[1]! + half) | 0;
  objectivesDrawCategory(w, pos, font, 2);
  pos[1] = (pos[1]! + half) | 0;
  objectivesDrawCategory(w, pos, font, 4);
  objectivesDrawCategory(w, pos, font, 0);
  pos[1] = (pos[1]! + half) | 0;
  objectivesDrawCategory(w, pos, font, 8);
  pos[0] = tp[0]!;
  pos[1] = (pos[1]! + gap) | 0;
  let line = '';
  switch (t.result) {
    case 0:
      if (t.timeLimit < 1) line = `Elapsed Time: ${timeFormatSub0317b0((clock.simTick + Math.imul(t.startTime, -0xb6)) | 0)}`;
      else line = `Time Remaining: ${timeFormatSub0317b0((Math.imul((t.timeLimit + t.startTime) | 0, 0xb6) - clock.simTick) | 0)}`;
      break;
    case 2:
      line = `Successful at ${timeFormatSub031850(t.decidedAt)}`;
      break;
    case 3:
      line = `Failed at ${timeFormatSub031850(t.decidedAt)}`;
      break;
    case 4:
      line = `Out of time at ${timeFormatSub031850(t.decidedAt)}`;
      break;
    default:
      quirk('hud_objectives_draw: this result draws an uninitialised stack buffer; the port draws nothing', 'hud_objectives_draw');
  }
  ink(6);
  vfxStringDraw(pane, pos[0]!, pos[1]!, font, line, table);
  ink(0xe);
  hudFontUnlock();
});
