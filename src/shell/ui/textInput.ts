/**
 * The shell's line editor (decompiled/mw2shell/src/screens/
 * shell_2a5e0_part1.c): a label with an underscore cursor at a place on
 * the screen, edited from the keyboard until Enter, Esc or a click. The
 * register types a new pilot's name with it, star select a starmate's,
 * the mech lab a variant's title.
 */
import { vfxCharacterWidth } from '../../engine/vfx/vfx.ts';
import { mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { getch, kbhit } from '../host/hardware.ts';
import { animUpdateAll } from '../anim/anims.ts';
import { mouseLeftClicked, mouseUpdate } from './mouse.ts';
import { labelCreate, labelDestroy, textWidth, type FontHolder, type TextLabel } from './labels.ts';

/**
 * The advance of one character in the holder's font (0 when the font has
 * no glyph for it).
 *
 * @mw2shell font_char_width 0x00026870
 * @fidelity exact
 */
export function fontCharWidth(h: FontHolder, ch: number): number {
  return vfxCharacterWidth(h.font, ch & 0xff);
}

/** What text_input leaves: its result and the buffer it wrote. */
export interface TextInputResult {
  /** 1 for Enter or a left click, 0 for Esc */
  accepted: number;
  /** the buffer's new contents - what was typed, on Esc as well */
  text: string;
}

/**
 * text_input(font, x, y, buffer, colour, maxChars, maxWidth): the buffer's
 * text plus a '_' cursor as a label (label_create, over the animations) at
 * (x, y) in `colour` (null: the identity table). Each pass runs
 * anim_update_all and mouse_update, then reads one key the way
 * input_poll_key does (into the input object). Enter or a left click
 * returns 1, Esc 0 - either way with the typed text (cursor dropped)
 * copied back to the buffer. Backspace deletes the last character. A key
 * 0x20..0x7f other than '~' that the font has a glyph for is appended,
 * unless maxChars are already typed or the text with its cursor would be
 * maxWidth wide or wider. The label is rebuilt after every change.
 *
 * The caller copies `text` into its buffer (the original writes the
 * caller's buffer through its pointer).
 *
 * @mw2shell text_input 0x0002a910
 * @fidelity exact
 */
export function* textInput(font: FontHolder, x: number, y: number, buffer: string, colour: Uint8Array | null, maxChars: number, maxWidth: number): Blocking<TextInputResult> {
  // 0xa2148: the edit buffer, the text and its cursor
  let n = buffer.length;
  let edit = buffer + '_'; // 0x76a45 '_'
  textWidth(font, edit);
  const k = shell.keyInput!;
  const m = mouse();
  let label: TextLabel | null = labelCreate(font, x, y, edit, colour);
  const finish = (accepted: number): TextInputResult => {
    edit = edit.slice(0, n);
    if (label) labelDestroy(label);
    label = null;
    return { accepted, text: edit };
  };
  for (;;) {
    animUpdateAll();
    yield* mouseUpdate(m);
    if (mouseLeftClicked(m) === 1) return finish(1);
    // input_poll_key, inlined
    let got: number;
    if (!kbhit()) {
      k.key = 0;
      k.arrived = 0;
      got = 0;
    } else {
      k.key = 0;
      const c = getch();
      if (c === 0) {
        k.key |= 0x8000;
        k.key |= getch();
      } else k.key = c;
      k.arrived = 1;
      got = k.key === 0x1b ? 3 : 1;
    }
    if (got === 0) continue;
    const key = k.key;
    if (key === 0x0d) return finish(1);
    if (key === 0x1b) return finish(0);
    if (key === 0x08) {
      if (n === 0) continue;
      n--;
      edit = edit.slice(0, n) + '_';
      if (label) labelDestroy(label);
      label = labelCreate(font, x, y, edit, colour);
      continue;
    }
    if (key < 0x20 || key > 0x7f || key === 0x7e || n === maxChars) continue;
    if (fontCharWidth(font, key) === 0) continue;
    const tried = edit.slice(0, n) + String.fromCharCode(key) + '_';
    n++;
    if (textWidth(font, tried) >= maxWidth) {
      // too wide: the cursor goes back over the character
      n--;
      edit = edit.slice(0, n) + '_';
      continue;
    }
    edit = tried;
    if (label) labelDestroy(label);
    label = labelCreate(font, x, y, edit, colour);
  }
}
