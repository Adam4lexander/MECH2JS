/**
 * The shell's mouse object (main keeps it at 0x91164; 0x43 bytes, Mouse in
 * mw2shell_types.h): the pointer's position and buttons, and the clicks -
 * a button going down this frame. decompiled/mw2shell/src/ui/mouse.c.
 *
 * mouse_update is the shell's frame boundary: every screen loop calls it
 * once per pass, and it presents the frame before reading the mouse. The
 * port's version is a generator that yields there, so the host can show the
 * frame and deliver input before the pass reads it.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mem } from '../memory.ts';
import { timerRead } from '../host/timer.ts';
import { FRAME, type Blocking } from '../host/blocking.ts';
import { screenDrawText, videoDriverErase, videoDriverPresent, type VideoDriver } from '../video/driver.ts';
import { cursorSetShape, cursorShow, cursorShutdown, mouseDriverSetPosition, mouseDriverStart, mouseReadState } from '../video/cursor.ts';
import type { FontHolder } from './labels.ts';

/** @portOnly the Mouse struct as a live object (field names from Mw2shellTypes.java) */
export class Mouse {
  /** +0x00 the pointer's shape table */
  cursor: Uint8Array | null = null;
  /** +0x04 */
  driver: VideoDriver | null = null;
  /** +0x08 */
  font: FontHolder | null = null;
  /** +0x0c the developer readout's width */
  readoutWidth = 0;
  /** +0x10 */
  leftClicked = 0;
  /** +0x14 */
  rightClicked = 0;
  /** +0x18 */
  middleClicked = 0;
  /** +0x1c */
  doubleClicked = 0;
  /** +0x1f */
  lastClickTime = 0;
  /** +0x2b */
  x = 0;
  /** +0x2f */
  y = 0;
  /** +0x33 */
  leftDown = 0;
  /** +0x37 */
  rightDown = 0;
  /** +0x3b */
  middleDown = 0;
  /** +0x3f */
  present = 0;
}

/**
 * (mouse, driver, font, cursor): zeroes the state and, when the driver has
 * a mouse, marks it present and puts up the pointer (shape 0 of cursor).
 *
 * @mw2shell mouse_init 0x000376a0
 * @fidelity exact
 */
export function mouseInit(m: Mouse, driver: VideoDriver, font: FontHolder | null, cursor: Uint8Array | null): Mouse {
  m.middleClicked = 0;
  m.driver = driver;
  m.font = font;
  m.cursor = cursor;
  m.rightClicked = 0;
  m.leftClicked = 0;
  m.lastClickTime = 0;
  m.readoutWidth = 0;
  m.x = 0;
  m.y = 0;
  m.leftDown = 0;
  m.rightDown = 0;
  m.middleDown = 0;
  m.doubleClicked = 0;
  m.present = 0;
  if (mouseDriverStart(driver.width, driver.height) !== 0) {
    m.present = 1;
    if (cursor) cursorSetShape(cursor, 0);
    cursorShow();
  }
  return m;
}

/**
 * Moves the pointer, if there is a mouse.
 *
 * @mw2shell mouse_set_position 0x00037740
 * @fidelity exact
 */
export function mouseSetPosition(m: Mouse, x: number, y: number): void {
  if (m.present !== 0) mouseDriverSetPosition(x, y);
}

/**
 * Shuts the driver side down (movie_play does it around a movie).
 *
 * @mw2shell mouse_shutdown 0x00037760
 * @fidelity exact
 */
export function mouseShutdown(m: Mouse): Mouse {
  if (m.present !== 0) cursorShutdown();
  return m;
}

/**
 * @mw2shell mouse_double_clicked 0x00037780
 * @fidelity exact
 */
export function mouseDoubleClicked(m: Mouse): number {
  return m.doubleClicked;
}

/**
 * The left button went down this frame - the click every screen tests after
 * button_bar_hit.
 *
 * @mw2shell mouse_left_clicked 0x000377a0
 * @fidelity exact
 */
export function mouseLeftClicked(m: Mouse): number {
  return m.leftClicked;
}

/**
 * @mw2shell mouse_right_clicked 0x000377b0
 * @fidelity exact
 */
export function mouseRightClicked(m: Mouse): number {
  return m.rightClicked;
}

/**
 * Fakes a press: 0 left, 1 middle, 2 right.
 *
 * @mw2shell mouse_inject_click 0x00037880
 * @fidelity exact
 */
export function mouseInjectClick(m: Mouse, button: number): void {
  if (button === 0) {
    m.leftDown = 1;
    m.leftClicked = 1;
  } else if (button >>> 0 < 2) {
    m.middleDown = 1;
    m.middleClicked = 1;
  } else if (button === 2) {
    m.rightDown = 1;
    m.rightClicked = 1;
  }
}

/**
 * Once per pass: when the shell was not launched by MECH2 the right button
 * shows a '(x,y)' developer readout; the frame is presented; the mouse is
 * read; each button's click is its up-to-down change; a left click within
 * 201 ms of the last one that was not a double click is a double click.
 *
 * @mw2shell mouse_update 0x000378a0
 * @fidelity exact
 * @divergence yields to the host between presenting the frame and reading the mouse
 */
export function* mouseUpdate(m: Mouse): Blocking<void> {
  const d = m.driver!;
  if (mem().i32(SHELL_LABEL.simLaunchEnabled) === 0 && m.rightDown === 1) {
    const text = `(${m.x},${m.y})`;
    if (m.readoutWidth !== 0) videoDriverErase(d, 0x230, 0x14, m.readoutWidth, m.font!.height);
    m.readoutWidth = screenDrawText(d, 0x230, 0x14, m.font!.drawFont, text);
  }
  videoDriverPresent(d);
  yield FRAME;
  const left = m.leftDown;
  const right = m.rightDown;
  const middle = m.middleDown;
  if (m.present !== 0) {
    const s = mouseReadState();
    m.x = s.x;
    m.y = s.y;
    m.leftDown = s.left;
    m.rightDown = s.right;
    m.middleDown = s.middle;
  }
  m.leftClicked = m.leftDown === 1 && left === 0 ? 1 : 0;
  m.rightClicked = m.rightDown === 1 && right === 0 ? 1 : 0;
  m.middleClicked = m.middleDown === 1 && middle === 0 ? 1 : 0;
  m.doubleClicked = 0;
  if (m.leftDown === 1 && left === 0) {
    if ((timerRead() - m.lastClickTime) >>> 0 < 0xc9) m.doubleClicked = 1;
    else m.lastClickTime = timerRead();
  }
}
