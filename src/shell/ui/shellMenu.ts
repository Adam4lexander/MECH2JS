/**
 * The pop-up menu every screen polls each pass (decompiled/mw2shell/src/
 * screens/options.c): NEW ALLEGIANCE, COMBAT VARIABLES, COCKPIT CONTROLS,
 * HALL OF HONOR, THE KESHIK, FLEE TO DOS.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem } from '../../data/formats/mpack.ts';
import { mem } from '../memory.ts';
import { database, driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenDrawText, videoDriverErase, videoDriverPaletteRestore, videoDriverPaletteSave, videoDriverShape } from '../video/driver.ts';
import { animUpdateAll } from '../anim/anims.ts';
import { mouseLeftClicked, mouseRightClicked, mouseUpdate } from './mouse.ts';
import { inputPollKey } from './keys.ts';
import { textWidth } from './labels.ts';
import { menuItem, mi, miText, setMi, toUpper } from './messageBox.ts';
import { menuScreens } from './menuScreens.ts';

/** 0x90e50: the palette the menu keeps while a sub-screen puts up its own. */
const savedPalette = new Uint8Array(768);

/** The six items laid out: text at x 320 centred, y 157 + 33 i; hit boxes x +-122, y +-16. */
function layoutMenu(): void {
  const f31 = shell.font31!;
  let y = 0x9d;
  for (let i = 0; i < 6; i++) {
    mem().strcpy(menuItem(i) + 0x18, mem().ptrStr(SHELL_LABEL.shellMenuItems + i * 4) ?? '');
    setMi(i, 'textX', 0x140);
    setMi(i, 'textY', y);
    setMi(i, 'x0', 0x140 - 0x7a);
    setMi(i, 'x1', 0x140 + 0x79);
    setMi(i, 'y0', y - 0x10);
    setMi(i, 'y1', y + 0x10);
    setMi(i, 'textY', y - ((f31.height / 2) | 0));
    const w = textWidth(f31, miText(i));
    setMi(i, 'pressed', 0);
    setMi(i, 'textX', 0x140 - ((w / 2) | 0));
    y += 0x21;
  }
}

/** FLEE TO DOS: message_box inlined with 'Embrace cowardice?#Yes|No', default No. */
function* fleeToDos(): Blocking<number> {
  const d = driver();
  const m = mouse();
  const ui = shell.uiFont!;
  const shapes = mpackDbGetItem(database(), 6)!;
  videoDriverShape(d, shapes, 2, 0xac, 0xa5, 0x128, 0x96);
  const w = textWidth(ui, 'Embrace cowardice?');
  screenDrawText(d, 0x140 - ((w / 2) | 0), 0xc5, ui.drawFont, 'Embrace cowardice?');
  const labels = ['Yes', 'No'];
  let x = (labels.length - 1) * -0x1e + 0x140;
  labels.forEach((t, i) => {
    mem().strcpy(menuItem(i) + 0x18, t);
    setMi(i, 'textX', x);
    setMi(i, 'x0', x - 0x1a);
    setMi(i, 'x1', x + 0x1a);
    setMi(i, 'y0', 0x114 - 0xd);
    setMi(i, 'y1', 0x114 + 0xd);
    setMi(i, 'textY', 0x114 - ((ui.height / 2) | 0));
    setMi(i, 'pressed', 0);
    setMi(i, 'textX', x - ((textWidth(ui, t) / 2) | 0));
    x += 0x3d;
  });
  let result = 1;
  let pressed = -1;
  for (;;) {
    for (let i = 0; i < labels.length; i++) {
      videoDriverShape(d, shapes, mi(i, 'pressed'), mi(i, 'x0'), mi(i, 'y0'), 0x40, 0x18);
      screenDrawText(d, mi(i, 'textX'), mi(i, 'textY'), ui.drawFont, miText(i));
    }
    yield* mouseUpdate(m);
    const key = inputPollKey(shell.keyInput!);
    if (key === 3) break;
    if (key === 1) {
      const k = shell.keyInput!.key;
      if (k === 0xd) break;
      const i = labels.findIndex((_, j) => toUpper(k) === toUpper(miText(j).charCodeAt(0) || 0));
      if (i >= 0) {
        result = i;
        break;
      }
    }
    const inside = (i: number) => mi(i, 'x0') <= m.x && m.x <= mi(i, 'x1') && mi(i, 'y0') <= m.y && m.y <= mi(i, 'y1');
    if (m.leftDown !== 0) {
      if (mouseLeftClicked(m) === 1) {
        for (let i = 0; i < labels.length; i++) {
          if (inside(i)) {
            setMi(i, 'pressed', 1);
            pressed = i;
            break;
          }
        }
      } else if (m.leftDown === 1 && pressed >= 0) setMi(pressed, 'pressed', inside(pressed) ? 1 : 0);
      continue;
    }
    if (pressed >= 0) {
      if (inside(pressed)) {
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

/**
 * Polled each pass: -1 at once unless Esc or a right click. Then the menu
 * (DATABASE item 7 at 198, 116): the pointer or the cursor keys highlight
 * an item (in font30), a click or Enter picks it, Esc or a right click
 * closes it (-1). NEW ALLEGIANCE returns 8; FLEE TO DOS asks and on Yes
 * returns -3; the others run their screen and come back to the menu.
 *
 * @mw2shell shell_menu 0x000258e0
 * @fidelity partial
 * @divergence COMBAT VARIABLES, COCKPIT CONTROLS, HALL OF HONOR and THE KESHIK run through menuScreens, filled in as those screens are ported
 */
export function* shellMenu(): Blocking<number> {
  const d = driver();
  const k = inputPollKey(shell.keyInput!);
  if (k !== 3 && mouseRightClicked(mouse()) !== 1) return -1;
  const art = mpackDbGetItem(database(), 7)!;
  videoDriverPaletteSave(d, savedPalette);
  let result = -1;
  for (;;) {
    videoDriverShape(d, art, 0, 0xc6, 0x74, 0xf4, 0xf8);
    layoutMenu();
    for (let i = 0; i < 6; i++) screenDrawText(d, mi(i, 'textX'), mi(i, 'textY'), shell.font31!.drawFont, miText(i));
    let lastX = -1;
    let lastY = -1;
    let sel = 0;
    let shown = -1;
    let picked = -2;
    for (;;) {
      const m = mouse();
      yield* mouseUpdate(m);
      if (mouseRightClicked(m) === 1) break;
      if (lastX !== m.x || lastY !== m.y) {
        lastX = m.x;
        lastY = m.y;
        let i = 0;
        for (; i < 6; i++) if (!(m.x < mi(i, 'x0') || mi(i, 'x1') < m.x || m.y < mi(i, 'y0') || mi(i, 'y1') < m.y)) break;
        if (i !== 6) sel = i;
      }
      if (mouseLeftClicked(m) === 1) {
        if (sel === -1) break;
        if (m.x < mi(sel, 'x0') || mi(sel, 'x1') < m.x || m.y < mi(sel, 'y0') || mi(sel, 'y1') < m.y) break;
        picked = sel;
        break;
      }
      const key = inputPollKey(shell.keyInput!);
      if (key === 3) break;
      if (key === 1) {
        const c = shell.keyInput!.key;
        if (c === 0xd) {
          picked = sel;
          break;
        }
        if (c === 0x8048 || c === 0x804b) {
          if (--sel < 0) sel = 5;
        } else if (c === 0x804d || c === 0x8050) {
          if (++sel > 5) sel = 0;
        }
      }
      if (sel !== shown) {
        if (sel !== -1) screenDrawText(d, mi(sel, 'textX'), mi(sel, 'textY'), shell.font30!.drawFont, miText(sel));
        if (shown !== -1) screenDrawText(d, mi(shown, 'textX'), mi(shown, 'textY'), shell.font31!.drawFont, miText(shown));
        shown = sel;
      }
    }
    if (picked === -2) break;
    if (picked === 0) {
      result = 8;
      break;
    }
    if (picked === 5) {
      const answer = yield* fleeToDos();
      if (answer === 0) {
        result = -3;
        break;
      }
      animUpdateAll();
      continue;
    }
    yield* menuScreens.run(picked);
    videoDriverErase(d, 0, 0, 0x280, 0x1e0);
    animUpdateAll();
    videoDriverPaletteRestore(d, savedPalette);
  }
  videoDriverErase(d, 0, 0, 0x280, 0x1e0);
  animUpdateAll();
  return result;
}
