/**
 * The shell's modal dialog (decompiled/mw2shell/src/screens/shell_263d0.c).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem } from '../../data/formats/mpack.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { database, driver, mouse, shell } from '../state.ts';
import { screenDrawText, videoDriverErase, videoDriverShape } from '../video/driver.ts';
import type { Blocking } from '../host/blocking.ts';
import { mouseLeftClicked, mouseUpdate } from './mouse.ts';
import { inputPollKey } from './keys.ts';
import { textWidth } from './labels.ts';

const ITEM = structSize('MenuItem');
const M = {
  x0: fieldOffset('MenuItem', 'x0'),
  y0: fieldOffset('MenuItem', 'y0'),
  x1: fieldOffset('MenuItem', 'x1'),
  y1: fieldOffset('MenuItem', 'y1'),
  textX: fieldOffset('MenuItem', 'textX'),
  textY: fieldOffset('MenuItem', 'textY'),
  text: fieldOffset('MenuItem', 'text'),
  pressed: fieldOffset('MenuItem', 'pressed'),
};

/** @portOnly menuItems[i] (0x90490, six 0x9c-byte items shared with shell_menu): its address */
export function menuItem(i: number): number {
  return SHELL_LABEL.menuItems + i * ITEM;
}

/** @portOnly a menuItems field */
export function mi(i: number, f: keyof typeof M): number {
  return mem().i32(menuItem(i) + M[f]);
}

/** @portOnly sets a menuItems field */
export function setMi(i: number, f: keyof typeof M, v: number): void {
  mem().setI32(menuItem(i) + M[f], v);
}

/** @portOnly menuItems[i].text */
export function miText(i: number): string {
  return mem().cstr(menuItem(i) + M.text, 128);
}

/** The line buffer message_box draws each line from (0x90450). */
const LINE_BUFFER = 0x40;

/**
 * (text, defaultButton): lines separated by '|', then '#', then button
 * labels separated by '|'. DATABASE.MW2 item 6 is drawn at (172, 165,
 * 296 x 150), the lines centred on x 320 from y 197, 16 px apart, the
 * buttons 61 px apart centred on 320 at y 276. A click on a button, Enter
 * or Esc (the default button), or a key equal to a button's first letter
 * chooses; returns the button's index.
 *
 * @mw2shell message_box 0x000263d0
 * @fidelity exact
 */
export function* messageBox(text: string, defaultButton: number): Blocking<number> {
  const d = driver();
  const m = mouse();
  const ui = shell.uiFont!;
  const shapes = mpackDbGetItem(database(), 6)!;
  videoDriverShape(d, shapes, 2, 0xac, 0xa5, 0x128, 0x96);
  let p = 0;
  const at = (k = 0) => (p + k < text.length ? text.charCodeAt(p + k) : 0);
  let y = 0xc5;
  while (at() !== 0 && at() !== 0x23) {
    let line = '';
    while (at() !== 0 && at() !== 0x7c && at() !== 0x23) line += text[p++];
    // copied into the buffer at 0x90450 first
    void LINE_BUFFER;
    const w = textWidth(ui, line);
    screenDrawText(d, 0x140 - ((w / 2) | 0), y, ui.drawFont, line);
    y += 0x10;
    if (at() === 0x7c) p++;
  }
  let count = 0;
  for (;;) {
    const c = at();
    p++;
    if (c === 0) break;
    let label = '';
    while (at() !== 0 && at() !== 0x7c) label += text[p++];
    mem().strcpy(menuItem(count) + M.text, label);
    count++;
  }
  let x = (count - 1) * -0x1e + 0x140;
  for (let i = 0; i < count; i++) {
    setMi(i, 'textX', x);
    setMi(i, 'textY', 0x114);
    setMi(i, 'x0', x - 0x1a);
    setMi(i, 'x1', x + 0x1a);
    setMi(i, 'y0', 0x114 - 0xd);
    setMi(i, 'y1', 0x114 + 0xd);
    setMi(i, 'textY', 0x114 - ((ui.height / 2) | 0));
    const w = textWidth(ui, miText(i));
    x += 0x3d;
    setMi(i, 'pressed', 0);
    setMi(i, 'textX', mi(i, 'textX') - ((w / 2) | 0));
  }
  let result = defaultButton;
  let pressed = -1;
  for (;;) {
    // (the original's loop re-enters here without resetting `pressed` while the button is held)
    for (let i = 0; i < count; i++) {
      videoDriverShape(d, shapes, mi(i, 'pressed'), mi(i, 'x0'), mi(i, 'y0'), 0x40, 0x18);
      screenDrawText(d, mi(i, 'textX'), mi(i, 'textY'), ui.drawFont, miText(i));
    }
    yield* mouseUpdate(m);
    const key = inputPollKey(shell.keyInput!);
    if (key !== 0) {
      if (key === 3) break;
      if (key === 1) {
        const k = shell.keyInput!.key;
        if (k === 0xd) break;
        const up = toUpper(k);
        let chosen = -1;
        for (let i = 0; i < count; i++) {
          if (up === toUpper(miText(i).charCodeAt(0) || 0)) {
            chosen = i;
            break;
          }
        }
        if (chosen >= 0) {
          result = chosen;
          break;
        }
      }
    }
    const mx = m.x;
    const my = m.y;
    if (m.leftDown !== 0) {
      if (mouseLeftClicked(m) === 1) {
        for (let i = 0; i < count; i++) {
          if (mi(i, 'x0') <= mx && mx <= mi(i, 'x1') && mi(i, 'y0') <= my && my <= mi(i, 'y1')) {
            setMi(i, 'pressed', 1);
            pressed = i;
            break;
          }
        }
      } else if (m.leftDown === 1 && pressed >= 0) {
        const inside = !(mx < mi(pressed, 'x0') || mi(pressed, 'x1') < mx || my < mi(pressed, 'y0') || mi(pressed, 'y1') < my);
        setMi(pressed, 'pressed', inside ? 1 : 0);
      }
      continue;
    }
    if (pressed >= 0) {
      if (mi(pressed, 'x0') <= mx && mx <= mi(pressed, 'x1') && mi(pressed, 'y0') <= my && my <= mi(pressed, 'y1')) {
        result = pressed;
        break;
      }
      setMi(pressed, 'pressed', 0);
    }
    pressed = -1;
  }
  videoDriverErase(d, 0xac, 0xa5, 0x128, 0x96);
  return result;
}

/** toupper, for ASCII. */
export function toUpper(c: number): number {
  return c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
}
