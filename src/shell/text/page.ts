/**
 * The shell's text pages (decompiled/mw2shell/src/screens/text_markup.c):
 * text_layout_page breaks marked-up text into TextLabels, one per line,
 * inside a box - the 0x34-byte Page - and the page is typed out one
 * character a frame. Briefings, debriefings and the Clan archive are all
 * pages. The markup is in decompiled/mw2shell/README.md, "Page text
 * markup".
 *
 * The line and word buffers of the original (0xa7174, 0xa7574, 0xa7974)
 * are JS strings here: text_layout_page resets them on every call, so
 * nothing in them outlives it. The three pending-code flags do outlive a
 * call, and stay in the shell's memory (layout*Pending).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { quirk } from '../../core/provenance.ts';
import { mem } from '../memory.ts';
import { shell } from '../state.ts';
import type { VideoDriver } from '../video/driver.ts';
import { labelDestroy, labelHide, labelSetTypewriter, textLabelInit, textLabelTypeChar, textWidth, TextLabel, type FontHolder } from '../ui/labels.ts';
import { Picture, pictureDestroy, pictureInit, pictureHide, pictureShow } from '../ui/picture.ts';
import { soundSamplePlay, soundSampleStop, type Sample } from '../sound/samples.ts';
import { collectionAppend, collectionGet } from '../util/collection.ts';

/** A clickable region a \Axx word leaves in the page (malloc(0x14)). */
export interface PageRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** the xx of \Axx: link xx of the archive page */
  id: number;
}

/** @portOnly the 0x34-byte Page (an int array in the original) as a live object */
export class Page {
  /** [0] the lines, one TextLabel each */
  lines: TextLabel[] = [];
  /** [1] the colour table every line is created with */
  colour: Uint8Array | null = null;
  /** [2] the font lines are measured and drawn in */
  font: FontHolder | null = null;
  /** [3] */
  left = 0;
  /** [4] the y of the last line laid (starts one line height above the box) */
  y = 0;
  /** [5] the width a line may take, from left (page_init's comment calls it the right edge; text_layout_page compares it with the pen's offset from left) */
  width = 0;
  /** [6] y + height, set only for a height >= 0; <= 0 means no limit */
  bottom = 0;
  /** [7] font height + 2 */
  lineHeight = 0;
  /** [8] (+0x20) the picture page_set_picture attaches */
  picture: Picture | null = null;
  /** [9] */
  driver: VideoDriver | null = null;
  /** [10] (+0x28) the typing sound: sound77 */
  sound: Sample | null = null;
  /** [0xc] (+0x30) the \A regions */
  regions: PageRegion[] = [];
}

/**
 * (page, font, driver, colour, left, y, width, height): an empty page with
 * a 50-line and a 10-region collection, sound77 as its typing sound, and
 * y one line height above the given y, so the first line lands on it.
 *
 * @mw2shell page_init 0x0003c410
 * @fidelity exact
 * @divergence with a negative height the original leaves [6] as malloc left it; the port's is 0 (no limit)
 */
export function pageInit(page: Page, font: FontHolder, driver: VideoDriver, colour: Uint8Array | null, left: number, y: number, width: number, height: number): Page {
  page.font = font;
  page.driver = driver;
  page.left = left;
  page.y = y;
  page.width = width;
  page.sound = shell.sound77;
  page.regions = [];
  if (height > -1) page.bottom = height + page.y;
  page.picture = null;
  page.colour = colour;
  page.lineHeight = font.height + 2;
  page.y -= page.lineHeight;
  page.lines = [];
  return page;
}

/** C atoi over the few characters a markup code copies (leading white space, a sign, digits). */
function cAtoi(s: string): number {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || (s.charCodeAt(i) >= 9 && s.charCodeAt(i) <= 13))) i++;
  let neg = false;
  if (s[i] === '-' || s[i] === '+') neg = s[i++] === '-';
  let n = 0;
  while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39) n = (n * 10 + (s.charCodeAt(i++) - 0x30)) | 0;
  return neg ? -n : n;
}

/** sprintf's %03d. */
function pad03(n: number): string {
  return n < 0 ? '-' + String(-n).padStart(2, '0') : String(n).padStart(3, '0');
}

/** A C string held in a JS string: up to its first NUL. */
function cut(s: string): string {
  const i = s.indexOf('\0');
  return i < 0 ? s : s.slice(0, i);
}

/**
 * (box, text): lays text into the box and returns the rest of it for the
 * next page (after a \S, or when the box is full), or null at the end.
 *
 * Words run to a space or a backslash (each character & 0x7f); the spaces
 * after a word go with it. Codes (either case): \N ends the line, \C
 * centres it (spaces in front, when it ends), \S ends the page, \T moves
 * the pen to the next tab stop and puts "\t" before the next word, \Axx
 * makes the next word region xx (it is prefixed "\a"), \Bnnn and \Gnnn
 * come back as the next word "\b%03d" / "\g%03d" (the pen moves back nnn -
 * for \G too), any other \x keeps the backslash and drops the x. A word
 * that does not fit wraps to a new line. Every line becomes a TextLabel in
 * the box's colour and font at (left, y).
 *
 * Reproduced as the original has them: the text's last word is dropped
 * unless a space or backslash follows it; a word too wide for an empty
 * line is dropped; the line being built when \S or a full box ends the
 * page is dropped; a region of a word that wrapped gets the previous
 * line's y.
 *
 * @mw2shell text_layout_page 0x0003ca70
 * @fidelity exact
 */
export function textLayoutPage(box: Page, text: string): string | null {
  const m = mem();
  const font = box.font!;
  const tabStop = (i: number) => m.i32(SHELL_LABEL.tabStops + i * 4);
  const len = cut(text).length;
  const at = (i: number) => (i < len ? text.charCodeAt(i) : 0);
  // 0xa7174: the line being built
  let line = '';
  // 0xa7574: the current word
  let word = '';
  let pos = 0;
  // the pen's offset from box.left
  let x = 0;
  let tabs = 0;
  let centre = 0;
  let region = -1;
  // \B / \G's number
  let num = -1;
  const skipSpaces = () => {
    while (pos < len && at(pos) === 0x20) pos++;
  };
  const addLine = () => {
    const label = textLabelInit(new TextLabel(), line, box.left, box.y, box.colour, font);
    collectionAppend(box.lines, label);
    line = '';
  };
  const addRegion = (wrapped: number, w: number) => {
    const r: PageRegion = { x0: 0, y0: 0, x1: 0, y1: 0, id: region };
    if (wrapped === 1) {
      r.x0 = box.left;
      r.y0 = box.y;
    } else {
      r.x0 = box.left + x - w;
      r.y0 = box.y + font.height;
    }
    r.x1 = r.x0 + w;
    r.y1 = r.y0 + box.lineHeight;
    collectionAppend(box.regions, r);
    region = -1;
  };
  let kind: number;
  do {
    const tokenStart = pos;
    // ---- the next token ----
    if (pos >= len) kind = 0;
    else if (m.u8(SHELL_LABEL.layoutBackPending) === 1) {
      m.setU8(SHELL_LABEL.layoutBackPending, 0);
      word = '\\b' + pad03(num);
      kind = 4;
    } else if (m.u8(SHELL_LABEL.layoutColumnPending) === 1) {
      m.setU8(SHELL_LABEL.layoutColumnPending, 0);
      word = '\\g' + pad03(num);
      kind = 4;
    } else {
      // the characters are stored one by one: one that & 0x7f makes 0 ends the C string early
      let raw = '';
      for (;;) {
        while (pos < len && at(pos) !== 0x20 && at(pos) !== 0x5c) raw += String.fromCharCode(at(pos++) & 0x7f);
        if (pos >= len) {
          kind = 0;
          break;
        }
        const c = at(pos);
        if ((c === 0x5c || c === 0x20) && raw.length > 0) {
          let spaces = 0;
          while (pos < len && at(pos) === 0x20) {
            pos++;
            spaces++;
          }
          raw = cut(raw) + ' '.repeat(spaces);
          kind = 4;
          break;
        }
        if (c !== 0x5c) {
          // a space with no word before it: pos does not move, so the original loops here for ever
          quirk('text_layout_page: a space with no word before it (text starting with a space) never advances', 'text_layout_page');
          throw new Error('text_layout_page: a leading space - the original never returns');
        }
        const code = at(pos + 1);
        if (code === 0x54 || code === 0x74) {
          // T t
          pos += 2;
          skipSpaces();
          kind = 5;
        } else if (code === 0x47 || code === 0x67) {
          // G g
          num = cAtoi(String.fromCharCode(at(pos + 2), at(pos + 3), at(pos + 4)).replace(/\0.*$/, ''));
          m.setU8(SHELL_LABEL.layoutColumnPending, 1);
          pos += 5;
          skipSpaces();
          kind = 8;
        } else if (code === 0x42 || code === 0x62) {
          // B b
          num = cAtoi(String.fromCharCode(at(pos + 2), at(pos + 3), at(pos + 4)).replace(/\0.*$/, ''));
          m.setU8(SHELL_LABEL.layoutBackPending, 1);
          pos += 5;
          skipSpaces();
          kind = 7;
        } else if (code === 0x53 || code === 0x73) {
          // S s
          pos += 2;
          skipSpaces();
          kind = 3;
        } else if (code === 0x4e || code === 0x6e) {
          // N n
          pos += 2;
          skipSpaces();
          kind = 1;
        } else if (code === 0x43 || code === 0x63) {
          // C c
          pos += 2;
          skipSpaces();
          kind = 2;
        } else if (code === 0x41 || code === 0x61) {
          // A a
          m.setU8(SHELL_LABEL.layoutRegionFlag, 1);
          region = cAtoi(String.fromCharCode(at(pos + 2), at(pos + 3)).replace(/\0.*$/, ''));
          pos += 4;
          skipSpaces();
          kind = 6;
        } else {
          // any other code: the backslash joins the word, the letter is dropped
          raw += '\\';
          pos += 2;
          continue;
        }
        break;
      }
      word = cut(raw);
    }
    // ---- what it does ----
    let wrapped = 0;
    switch (kind) {
      case 1: {
        // \N
        const w = textWidth(font, word);
        if (centre === 1) {
          const pad = cdiv(cdiv(box.width - x, 2), textWidth(font, ' '));
          centre = 0;
          line = ' '.repeat(Math.max(0, pad)) + line;
        }
        if (box.bottom > 0 && box.y + box.lineHeight > box.bottom) return text.slice(pos);
        box.y += box.lineHeight;
        if (line.length > 0) addLine();
        x = 0;
        if (region !== -1) addRegion(wrapped, w);
        break;
      }
      case 2:
        centre = 1;
        break;
      case 3:
        return text.slice(pos);
      case 4: {
        const w = textWidth(font, word);
        const token = word;
        word = '\\t'.repeat(tabs);
        tabs = 0;
        if (region !== -1) word += '\\a';
        word += token;
        if (num !== -1) {
          x -= num;
          num = -1;
        }
        if (textWidth(font, word) + x > box.width) {
          box.y += box.lineHeight;
          if (line.length > 0) {
            addLine();
            line = word;
            x = textWidth(font, word);
          } else x = 0;
          wrapped = 1;
        } else {
          line += word;
          x += w;
          wrapped = 0;
        }
        if (region !== -1) addRegion(wrapped, textWidth(font, word));
        if (box.bottom > 0 && box.y + box.lineHeight > box.bottom) return text.slice(tokenStart);
        break;
      }
      case 5: {
        // \T: the first stop past the pen, else the last (640)
        tabs++;
        let i = 0;
        for (;;) {
          if (i === 18) {
            x = tabStop(18);
            break;
          }
          if (x < tabStop(i)) {
            x = tabStop(i);
            break;
          }
          i++;
        }
        break;
      }
      case 6:
      case 7:
      case 8:
        break;
      default:
        word = '';
        tabs = 0;
    }
  } while (kind !== 0);
  // the end of the text: the word (always empty by now) and the last line
  const w = textWidth(font, word);
  if (word.length > 0) {
    line += word;
    x += w;
  }
  box.y += box.lineHeight;
  if (line.length > 0) addLine();
  if (region !== -1) addRegion(0, w);
  return null;
}

/**
 * The typewriter step for one label: 1 when it is done or empty, else
 * text_label_type_char's result.
 *
 * @mw2shell text_label_type_step 0x0003c280
 * @fidelity exact
 */
export function textLabelTypeStep(label: TextLabel): number {
  if (label.done === 1) return 1;
  if (label.text.length === 0) return 1;
  return textLabelTypeChar(label);
}

/**
 * Shows the picture, starts the typing sound, and rewinds every line into
 * typewriter mode, so the page types out again from the start.
 *
 * @mw2shell page_restart 0x0003d7f0
 * @fidelity exact
 */
export function pageRestart(page: Page): void {
  if (page.picture) pictureShow(page.picture);
  if (page.sound) soundSamplePlay(page.sound);
  for (let i = 0; i < page.lines.length; i++) {
    const label = collectionGet(page.lines, i)!;
    label.done = 0;
    label.penX = -1;
    label.charIndex = -1;
    labelSetTypewriter(label, 1);
  }
}

/**
 * Once a frame: types one character of the first line not yet done; when
 * every line is done, stops the typing sound.
 *
 * @mw2shell page_type_step 0x0003d850
 * @fidelity exact
 */
export function pageTypeStep(page: Page): number {
  for (let i = 0; i < page.lines.length; i++) {
    const label = collectionGet(page.lines, i)!;
    if (label.done === 0) return textLabelTypeStep(label);
  }
  if (page.sound) soundSampleStop(page.sound);
  return 0;
}

/**
 * Takes the page down: its picture off the background (picture_hide)
 * and every line hidden (label_hide), ready to be typed again. The
 * archive calls it when it leaves a page.
 *
 * @mw2shell page_hide 0x0003d890
 * @fidelity exact
 */
export function pageHide(page: Page): void {
  if (page.picture) pictureHide(page.picture);
  for (let i = 0; i < page.lines.length; i++) labelHide(collectionGet(page.lines, i)!);
}

/**
 * (page, shapes, size): a picture from an archive item, with sound77 as
 * its sound, becomes the page's.
 *
 * @mw2shell page_set_picture 0x0003d8d0
 * @fidelity exact
 */
export function pageSetPicture(page: Page, shapes: Uint8Array, size: number): void {
  page.picture = pictureInit(new Picture(), shapes, size, page.driver!, 0, 0, shell.sound77);
}

/**
 * Stops the typing sound, destroys every line and the picture.
 *
 * @mw2shell page_destroy 0x0003d900
 * @fidelity exact
 */
export function pageDestroy(page: Page): Page {
  if (page.sound) soundSampleStop(page.sound);
  for (let i = 0; i < page.lines.length; i++) {
    const label = collectionGet(page.lines, i);
    if (label) labelDestroy(label);
  }
  page.lines = [];
  page.regions = [];
  if (page.picture) pictureDestroy(page.picture);
  return page;
}
