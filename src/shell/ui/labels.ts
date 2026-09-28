/**
 * The shell's text: font holders (a VFX font with its height and driver),
 * text labels (a string at a place, drawn whole or typed a character at a
 * time with the page markup codes), and the driver's two label lists -
 * drawn under and over the animations - that keep them on screen.
 * decompiled/mw2shell/src/screens/shell_263d0.c and text_markup.c.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { vfxCharacterWidth, vfxFontHeight } from '../../engine/vfx/vfx.ts';
import { mem } from '../memory.ts';
import { drawClip, screenDrawChar, screenDrawText, videoDriverErase, type VideoDriver } from '../video/driver.ts';

/** @portOnly the 0x414-byte FontHolder as a live object */
export class FontHolder {
  /** +0x000 the font text_width measures with */
  font: Uint8Array = new Uint8Array(0);
  /** +0x408 the same font, which every caller draws with */
  drawFont: Uint8Array = new Uint8Array(0);
  /** +0x40c */
  height = 0;
  /** +0x410 */
  driver: VideoDriver | null = null;
}

/**
 * (holder, font, driver): the font twice, its height and the driver.
 *
 * @mw2shell font_holder_init 0x000267f0
 * @fidelity exact
 */
export function fontHolderInit(h: FontHolder, font: Uint8Array, driver: VideoDriver): FontHolder {
  h.driver = driver;
  h.font = font;
  h.drawFont = font;
  h.height = vfxFontHeight(font);
  return h;
}

/**
 * The string's width in the holder's font: the sum of its characters'.
 *
 * @mw2shell text_width 0x00026830
 * @fidelity exact
 */
export function textWidth(h: FontHolder, text: string | null): number {
  if (text === null) return 0;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += vfxCharacterWidth(h.font, text.charCodeAt(i) & 0xff);
  return w;
}

/**
 * screen_draw_text through a holder: its driver and font.
 *
 * @mw2shell font_holder_draw_text 0x00026980
 * @fidelity exact
 */
export function fontHolderDrawText(h: FontHolder, x: number, y: number, text: string, remap: Uint8Array | null = null): number {
  return screenDrawText(h.driver!, x, y, h.font, text, remap);
}

/**
 * The one-character counterpart, for typed labels.
 *
 * @mw2shell font_holder_draw_char 0x000269a0
 * @fidelity exact
 */
export function fontHolderDrawChar(h: FontHolder, x: number, y: number, ch: number, remap: Uint8Array | null = null): number {
  return screenDrawChar(h.driver!, x, y, h.font, ch, remap);
}

/** @portOnly the 0x3e-byte TextLabel as a live object */
export class TextLabel {
  /** +0x00 */
  font: FontHolder | null = null;
  /** +0x04 the colour table it is drawn with (null: the identity table) */
  baseColour: Uint8Array | null = null;
  /** +0x08 the table in use while typing (\A switches it to textRemap1) */
  currentColour: Uint8Array | null = null;
  /** +0x0c the font holder's driver */
  driver: VideoDriver | null = null;
  /** +0x10 1: redraws retype up to the current character */
  typewriter = 0;
  /** +0x14 1 once text_label_type_char has put it on the over list */
  onList = 0;
  /** +0x19 */
  text = '';
  /** +0x1d */
  height = 0;
  /** +0x21 */
  width = 0;
  /** +0x25 */
  x = 0;
  /** +0x29 */
  y = 0;
  /** +0x2d x + width, as text_label_init left it */
  right = 0;
  /** +0x31 y + height */
  bottom = 0;
  /** +0x35 */
  done = 0;
  /** +0x36 */
  penX = -1;
  /** +0x3a */
  charIndex = -1;
}

/** A colour table in the shell's memory, as a live view. */
export function remapAt(addr: number): Uint8Array {
  return mem().view(addr, 256);
}

/**
 * Fills the three glyph colour tables (textRemap1/5/8): identities with
 * entry 0 = 0xff (transparent) and entry 1 - a font's ink - becoming 1, 5
 * and 8.
 *
 * @mw2shell text_remap_init 0x0003bf40
 * @fidelity exact
 */
export function textRemapInit(): void {
  const t8 = remapAt(SHELL_LABEL.textRemap8);
  const t1 = remapAt(SHELL_LABEL.textRemap1);
  const t5 = remapAt(SHELL_LABEL.textRemap5);
  t8[0] = 0xff;
  t1[0] = 0xff;
  t5[0] = 0xff;
  for (let i = 1; i < 0x100; i++) {
    t8[i] = i;
    t1[i] = i;
    t5[i] = i;
  }
  t5[1] = 5;
  t8[1] = 8;
  t1[1] = 1;
}

/**
 * (label, text, x, y, colour, font): a leading '~' centres the label on x
 * by half its width; the typing state is reset.
 *
 * @mw2shell text_label_init 0x0003c2c0
 * @fidelity exact
 */
export function textLabelInit(label: TextLabel, text: string | null, x: number, y: number, colour: Uint8Array | null, font: FontHolder): TextLabel {
  label.font = font;
  label.driver = font.driver;
  const t = text ?? '';
  label.text = t[0] === '~' ? t.slice(1) : t;
  label.width = textWidth(label.font, label.text);
  label.height = font.height;
  label.x = t[0] === '~' ? x - ((label.width / 2) | 0) : x;
  label.done = 0;
  label.penX = -1;
  label.charIndex = -1;
  label.typewriter = 0;
  label.onList = 0;
  label.y = y;
  label.baseColour = colour;
  label.right = label.x + label.width;
  label.currentColour = colour;
  label.bottom = label.y + label.height;
  return label;
}

/** Three digits after a markup code, as atoi reads them. */
function codeNumber(label: TextLabel): number {
  const i = label.charIndex;
  const digits = label.text.slice(i + 1, i + 4);
  label.charIndex = i + 4;
  const n = parseInt(digits, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Types the label's next character and advances; sets done at the end. A
 * backslash starts a code: \Gnnn pen to x + nnn, \Bnnn pen back nnn, \T
 * pen to the next tab stop, \A (or \a) the next word in textRemap1 until a
 * space or backslash. The label's width grows to the pen's reach.
 *
 * @mw2shell text_label_type_char 0x0003c040
 * @fidelity exact
 */
export function textLabelTypeChar(label: TextLabel): number {
  if (label.onList === 0) {
    labelsAdd(label.driver!, label, 1);
    label.onList = 1;
  }
  if (label.charIndex < 0) {
    label.charIndex = 0;
    label.currentColour = label.baseColour;
    label.penX = label.x;
  }
  if (label.text.length <= label.charIndex) {
    label.done = 1;
    label.currentColour = label.baseColour;
    return 1;
  }
  const c = label.text.charCodeAt(label.charIndex);
  if (c !== 0x5c) {
    if (c === 0x20) label.currentColour = label.baseColour;
    label.penX += fontHolderDrawChar(label.font!, label.penX, label.y, c, label.currentColour);
    label.charIndex++;
  } else {
    label.currentColour = label.baseColour;
    label.charIndex++;
    if (label.charIndex < label.text.length) {
      const code = label.text.charCodeAt(label.charIndex);
      if (code === 0x47 || code === 0x67) label.penX = label.x + codeNumber(label); // G g
      else if (code === 0x42 || code === 0x62) label.penX -= codeNumber(label); // B b
      else if (code === 0x41 || code === 0x61) {
        // A a
        label.currentColour = remapAt(SHELL_LABEL.textRemap1);
        label.charIndex++;
      } else if (code === 0x54 || code === 0x74) {
        // T t
        label.charIndex++;
        for (let k = 0; k < 19; k++) {
          const stop = mem().i32(SHELL_LABEL.tabStops + k * 4);
          if (label.penX - label.x < stop) {
            label.penX = label.x + stop;
            break;
          }
        }
      }
    }
  }
  const reach = label.penX - label.x + 1;
  if (label.width < reach) label.width = reach;
  return 0;
}

/**
 * Redraws a label: a typed one is retyped from the start to its current
 * character, any other drawn whole and marked done.
 *
 * @mw2shell text_label_redraw 0x0003bfb0
 * @fidelity exact
 */
export function textLabelRedraw(label: TextLabel): void {
  if (label.text.length === 0) return;
  if (label.typewriter === 1) {
    const upTo = label.charIndex;
    label.charIndex = -1;
    while (label.charIndex < upTo) textLabelTypeChar(label);
  } else {
    fontHolderDrawText(label.font!, label.x, label.y, label.text, label.baseColour);
    label.done = 1;
  }
}

/**
 * @mw2shell label_set_typewriter 0x0003bfa0
 * @fidelity exact
 */
export function labelSetTypewriter(label: TextLabel, on: number): void {
  label.typewriter = on;
}

/**
 * A new label on the list drawn UNDER the animations, drawn now.
 *
 * @mw2shell label_create_under 0x00026890
 * @fidelity exact
 */
export function labelCreateUnder(font: FontHolder, x: number, y: number, text: string | null, colour: Uint8Array | null): TextLabel {
  const label = textLabelInit(new TextLabel(), text ?? '', x, y, colour, font);
  labelsAdd(font.driver!, label, 0);
  textLabelRedraw(label);
  return label;
}

/**
 * A new label on the list drawn OVER the animations, drawn now.
 *
 * @mw2shell label_create 0x000268e0
 * @fidelity exact
 */
export function labelCreate(font: FontHolder, x: number, y: number, text: string | null, colour: Uint8Array | null): TextLabel {
  const label = textLabelInit(new TextLabel(), text ?? '', x, y, colour, font);
  labelsAdd(font.driver!, label, 1);
  textLabelRedraw(label);
  return label;
}

/**
 * Takes a label off both lists and restores the screen behind it.
 *
 * @mw2shell label_hide 0x0003c370
 * @fidelity exact
 */
export function labelHide(label: TextLabel): void {
  label.done = 0;
  label.penX = -1;
  label.charIndex = -1;
  labelsRemove(label.driver!, label);
  label.onList = 0;
  videoDriverErase(label.driver!, label.x, label.y, label.width, label.height);
}

/**
 * label_hide, and its text freed (the caller frees the label).
 *
 * @mw2shell label_destroy 0x0003c3c0
 * @fidelity exact
 */
export function labelDestroy(label: TextLabel): void {
  labelHide(label);
}

/**
 * Appends a label to the driver's over (over != 0) or under list.
 *
 * @mw2shell labels_add 0x0003ee10
 * @fidelity exact
 */
export function labelsAdd(d: VideoDriver, label: TextLabel, over: number): void {
  labelListAdd((over !== 0 ? d.labelsOver : d.labelsUnder) as TextLabel[], label);
}

/**
 * @mw2shell labels_remove 0x0003ee30
 * @fidelity exact
 */
export function labelsRemove(d: VideoDriver, label: TextLabel): void {
  labelListRemove(d.labelsOver as TextLabel[], label);
  labelListRemove(d.labelsUnder as TextLabel[], label);
}

/**
 * Redraws one list with text outside the dirty rectangle skipped.
 *
 * @mw2shell labels_redraw 0x0003ee50
 * @fidelity exact
 */
export function labelsRedraw(d: VideoDriver, over: number): void {
  drawClip.keepDirty = 1;
  labelListRedraw((over === 0 ? d.labelsUnder : d.labelsOver) as TextLabel[]);
  drawClip.keepDirty = 0;
}

/**
 * Empties both lists (destroying the labels, or only hiding them).
 *
 * @mw2shell labels_clear 0x0003ee80
 * @fidelity exact
 */
export function labelsClear(d: VideoDriver, destroy: number): void {
  labelListClear(d.labelsOver as TextLabel[], destroy);
  labelListClear(d.labelsUnder as TextLabel[], destroy);
}

/**
 * @mw2shell label_list_add 0x0003bea0
 * @fidelity exact
 */
export function labelListAdd(list: TextLabel[], label: TextLabel): void {
  list.push(label);
}

/**
 * @mw2shell label_list_remove 0x0003beb0
 * @fidelity exact
 */
export function labelListRemove(list: TextLabel[], label: TextLabel): void {
  const i = list.indexOf(label);
  if (i >= 0) list.splice(i, 1);
}

/**
 * @mw2shell label_list_redraw 0x0003bf10
 * @fidelity exact
 */
export function labelListRedraw(list: TextLabel[]): void {
  for (let i = 0; i < list.length; i++) textLabelRedraw(list[i]!);
}

/**
 * Empties a list from the end: destroy each label, or hide it.
 *
 * @mw2shell label_list_clear 0x0003bed0
 * @fidelity exact
 */
export function labelListClear(list: TextLabel[], destroy: number): void {
  while (list.length !== 0) {
    const label = list[list.length - 1]!;
    if (destroy === 1) labelDestroy(label);
    else labelHide(label);
  }
}
