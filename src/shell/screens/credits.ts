/**
 * THE KESHIK, item 4 of shell_menu: the credits scrolling up over the
 * amwlogo1 loop (decompiled/mw2shell/src/screens/credits.c).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { driver, mouse, shell } from '../state.ts';
import { mem } from '../memory.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenPaintPicture } from '../video/background.ts';
import { screenDrawText, videoDriverErase } from '../video/driver.ts';
import { BackgroundMovie, movieBackgroundClose, movieBackgroundStep, movieOpenBackground } from '../anim/movies.ts';
import { textWidth } from '../ui/labels.ts';
import { inputFlush, inputPollKey } from '../ui/keys.ts';
import { mouseLeftClicked, mouseRightClicked, mouseUpdate } from '../ui/mouse.ts';
import { menuScreens } from '../ui/menuScreens.ts';

/** creditsLines' entries (0x610 bytes of pointers) */
const LINES = 0x184;
/** 0x8d190: the colour table '~' lines are drawn through */
const TILDE_REMAP = 0x8d190;

/**
 * The DOS date as dos_getdate fills it: {day, month, year}. The host's
 * clock is the machine's.
 *
 * @portOnly the real-time clock under dos_getdate
 */
function dosDate(): { day: number; month: number; year: number } {
  const now = new Date();
  return { day: now.getDate(), month: now.getMonth() + 1, year: now.getFullYear() };
}

/**
 * DATABASE picture 5 painted over the screen; the erase fill turned off;
 * the amwlogo1 loop at (120, 4). A colour table at 0x8d190 is built: 0 ->
 * 0xff, 1 -> 0x10, every other colour itself. Unless the date is October
 * 1995 or earlier in 1995, the first line starting '>SHELL P' is replaced
 * by '~SHELL PROGRAMMING by REDLINE GAMES' (0x7ca5c) in the table itself.
 *
 * Then, each step: 125..459 erased back to the background, the lines
 * drawn 20 px apart from y (460 at the start, 1 px higher each step),
 * those at y 105..459 only, centred on x 320 - '<' in font27, '>' in
 * font28, '~' in font27 through the 0x8d190 table, each without its first
 * character, anything else whole in font32 - then the strips at 105 and
 * 460 erased; the movie stepped and the mouse updated twice per step, a
 * click, right click or key ending it after either. The first line drawn
 * each step is the last one above y 105 the step before, so the list keeps
 * scrolling, empty, after the last line.
 *
 * @mw2shell credits_screen 0x00021400
 * @fidelity exact
 */
export function* creditsScreen(): Blocking<void> {
  const d = driver();
  const m = mem();
  inputFlush(shell.keyInput!);
  screenPaintPicture(d, 5);
  d.fillColour = 0;
  // 0x73fc4 'amwlogo1'
  const movie = yield* movieOpenBackground(new BackgroundMovie(), m.cstr(0x73fc4), 0x78, 4);
  m.setU8(TILDE_REMAP, 0xff);
  m.setU8(TILDE_REMAP + 1, 0x10);
  for (let i = 2; i < 0x100; i++) m.setU8(TILDE_REMAP + i, i);
  const date = dosDate();
  if (10 < date.month || date.year !== 0x7cb) {
    // 0x73fcd '>SHELL P', compared case-sensitively over 8 characters
    const key = m.cstr(0x73fcd);
    for (let i = 0; i < LINES; i++) {
      const at = SHELL_LABEL.creditsLines + i * 4;
      const s = m.ptrStr(at);
      if (s !== null && s.slice(0, 8) === key) {
        m.setI32(at, 0x7ca5c);
        break;
      }
    }
  }
  const font27 = shell.font27!;
  const font28 = shell.font28!;
  const font32 = shell.font32!;
  let first = 0;
  let top = 0x1cc;
  for (;;) {
    videoDriverErase(d, 0, 0x7d, 0x280, 0x14f);
    let y = first * 0x14 + top;
    top--;
    if (first < LINES) {
      for (let i = first; i < LINES; i++, y += 0x14) {
        if (0x1cc <= y) break;
        if (y < 0x69) {
          first = i;
          continue;
        }
        const s = m.ptrStr(SHELL_LABEL.creditsLines + i * 4);
        if (s === null) continue;
        const rest = s.slice(1);
        const c = s.charCodeAt(0);
        if (c === 0x3c) screenDrawText(d, 0x140 - cdiv(textWidth(font27, rest), 2), y, font27.drawFont, rest);
        else if (c === 0x3e) screenDrawText(d, 0x140 - cdiv(textWidth(font28, rest), 2), y, font28.drawFont, rest);
        else if (c === 0x7e) screenDrawText(d, 0x140 - cdiv(textWidth(font27, rest), 2), y, font27.drawFont, rest, m.view(TILDE_REMAP, 0x100));
        else screenDrawText(d, 0x140 - cdiv(textWidth(font32, s), 2), y, font32.drawFont, s);
      }
    }
    videoDriverErase(d, 0, 0x69, 0x280, 0x14);
    videoDriverErase(d, 0, 0x1cc, 0x280, 0x14);
    let done = false;
    for (let half = 0; half < 2 && !done; half++) {
      movieBackgroundStep(movie);
      yield* mouseUpdate(mouse());
      done = mouseRightClicked(mouse()) === 1 || mouseLeftClicked(mouse()) === 1 || inputPollKey(shell.keyInput!) !== 0;
    }
    if (done) break;
  }
  movieBackgroundClose(movie);
  d.fillColour = -1;
}

menuScreens.register(4, creditsScreen);
