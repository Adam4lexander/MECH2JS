/**
 * The document viewer: a stack of pages with EXIT / PREV PAGE / NEXT PAGE
 * buttons and a centred title, whose \A words are buttons that open a
 * linked page in a nested viewer. The Clan archive (state 5) reads its
 * pages from ARCHWO.MW2 / ARCHJF.MW2; the briefing's SITUATION and the
 * debriefing hand it pages they laid out themselves.
 * decompiled/mw2shell/src/archive/archive_db.c and screens/shell_263d0.c;
 * the page format is in decompiled/mw2shell/README.md, "The Clan archive".
 *
 * The page loader's buffers (the title at 0x916d8, a line at 0x918d8, a
 * link's string at 0x91cd8, a text block at 0x91ed8) are JS strings: each
 * is rewritten before it is read. The original's text block buffer has no
 * bound; how far the longest pages (64 KB) run past it is not modelled.
 */
import { mpackDbGetItem, mpackDbOpen, mpackDbReadAt, mpackDbReadLine, mpackDbReadString, type MPackDb } from '../../data/formats/mpack.ts';
import { dosFileLoad } from '../../engine/dosFiles.ts';
import { unestablished } from '../../core/provenance.ts';
import { shell } from '../state.ts';
import { ShellExit, type Blocking } from '../host/blocking.ts';
import { videoDriverFree, type VideoDriver } from '../video/driver.ts';
import { ButtonBar, buttonBarAdd, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonBarRemove, buttonBarTruncate, buttonDefsAt, type ButtonDef } from '../ui/buttonBar.ts';
import { labelCreateUnder, labelDestroy, labelsClear, type FontHolder, type TextLabel } from '../ui/labels.ts';
import { mouseInjectClick, mouseLeftClicked, mouseUpdate, type Mouse } from '../ui/mouse.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { soundSamplePlay } from '../sound/samples.ts';
import { Page, pageDestroy, pageInit, pageHide, pageRestart, pageSetPicture, pageTypeStep, textLayoutPage } from '../text/page.ts';
import { strDupNonempty, collectionAppend, collectionGet } from '../util/collection.ts';

/** A 0x0400 record as the loader keeps it (malloc(6)). */
export interface ArchiveLink {
  /** +0: the record's ordinal + 4 - the button index of the \A words that name it */
  id: number;
  /** +4: the page item it opens (a short) */
  page: number;
}

/** @portOnly the 0x1bd-byte viewer as a live object */
export class ArchiveViewer {
  /** +0x00 */
  mouse: Mouse | null = null;
  /** +0x04 */
  driver: VideoDriver | null = null;
  /** +0x08 */
  bar: ButtonBar | null = null;
  /** +0x0c the archive the pages come from; NULL for a viewer over pages handed to it */
  archive: MPackDb | null = null;
  /** +0x10 DATABASE.MW2, passed through to nested viewers */
  database: MPackDb | null = null;
  /** +0x14 the page font */
  font: FontHolder | null = null;
  /** +0x20 the title, centred at (320, 50) in font27 */
  titleLabel: TextLabel | null = null;
  /** +0x24 */
  links: ArchiveLink[] = [];
  /** +0x28 the pages' colour table: [0] 0xff, [1] 5, the identity after */
  colour = new Uint8Array(256);
  /** +0x128 1: the viewer opened the archive (and closes it) */
  ownsArchive = 0;
  /** +0x129 the button definitions (an address in the image): 0 EXIT, 1 PREV PAGE, 2 NEXT PAGE, 3 BACK */
  defs = 0;
  /** +0x12d how many button_bar_create takes */
  defCount = 0;
  /** +0x131 */
  pages: Page[] = [];
  /** +0x135 the page shown */
  current = -1;
  /** +0x139 */
  page: Page | null = null;
  /** +0x13d the archive's file name, then '~' + the page's title */
  title = '';
}

/** defs[i] of the viewer's table. */
function viewerDef(v: ArchiveViewer, i: number): ButtonDef {
  return buttonDefsAt(v.defs + i * 0x1c, 1)[0]!;
}

/** Each of the page's regions as a button, index region id + 4, no label (the "" at 0x75ce0 / 0x75ce1 duplicated to NULL). */
function addRegionButtons(v: ArchiveViewer, page: Page): void {
  for (let i = 0; i < page.regions.length; i++) {
    const r = collectionGet(page.regions, i)!;
    const def: ButtonDef = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, labelX: 0, labelY: 0, label: strDupNonempty('') };
    buttonBarAdd(v.bar!, def, r.id + 4, v.bar!.outline);
  }
}

/** The loader's fatal exits: the driver freed, the message printed, exit(1). */
function fatal(v: ArchiveViewer, message: string): never {
  if (v.driver) videoDriverFree(v.driver);
  unestablished(`archive_page_load: ${message.trim()} - exit(1)`, 'archive_page_load');
  throw new ShellExit(1);
}

/** One opcode record of an archive page, as archive_page_load reads it. @portOnly */
export type ArchiveOp =
  | { op: 0x0200; lines: string[]; next: number }
  | { op: 0x0300; item: number; second: number; next: number }
  | { op: 0x0400; page: number; name: string; next: number }
  | { op: 0xff00; next: number }
  | { op: number; next: number };

/**
 * Reads the record at `offset` of page item `item` exactly as
 * archive_page_load does: the opcode, then for 0x0200 its lines through
 * mpack_db_read_line until one stops at the NUL (that last read's text is
 * not kept, and the offset steps each kept line's length + 1, then 1 for
 * the NUL); 0x0300 two bytes; 0x0400 a u16 and a C string. `next` is the
 * offset after it.
 *
 * @portOnly archive_page_load's reads, shared with the listing test
 */
export function archiveReadOp(db: MPackDb, item: number, offset: number): ArchiveOp {
  const b = mpackDbReadAt(db, item, offset, 2)!;
  const op = b[0]! | (b[1]! << 8);
  let at = offset + 2;
  if (op === 0x0200) {
    const lines: string[] = [];
    for (;;) {
      const r = mpackDbReadLine(db, item, at)!;
      if (r.stop === 2) break;
      lines.push(r.text);
      at += r.text.length + 1;
    }
    return { op, lines, next: at + 1 };
  }
  if (op === 0x0300) {
    const t = mpackDbReadAt(db, item, at, 2)!;
    return { op, item: t[0]!, second: t[1]!, next: at + 2 };
  }
  if (op === 0x0400) {
    const t = mpackDbReadAt(db, item, at, 2)!;
    const page = ((t[0]! | (t[1]! << 8)) << 16) >> 16;
    at += 2;
    const name = mpackDbReadString(db, item, at) ?? '';
    return { op, page, name, next: at + name.length + 1 };
  }
  return { op, next: at };
}

/**
 * (viewer, driver, mouse, database, name, font, item, open, archive, pages,
 * defs, count): builds a viewer and shows its first page. Every label on
 * screen is hidden first; the bar is defs[0 .. count-1] plus defs[3] as
 * button 3. With open 1 the archive `name` is opened (else `archive` is
 * used). With `pages`, those pages are the document. Otherwise page item
 * `item` is read: 0x0100 and the title (anything else is fatal); then
 * records until 0xff00 - 0x0200 a text block (its lines joined, each
 * line's newline dropped: the space put after it is overwritten by the
 * next line, so only the last line keeps one; sound103 plays once 0x800
 * characters have been read), laid out into as many pages as it needs
 * (left 0x58, y 0x46, width 0x1d2, height 0xde); 0x0300 a picture on the
 * current page (a new one if there is none); 0x0400 a link, kept as
 * {ordinal + 4, page}. An unknown record is fatal. mouse_update runs
 * before each record, after each line read and before each page layout.
 *
 * @mw2shell archive_page_load 0x00027a20
 * @fidelity exact
 * @divergence the fatal exits print nothing (the message is logged as unestablished) and throw ShellExit(1)
 */
export function* archivePageLoad(
  v: ArchiveViewer,
  driver: VideoDriver,
  mouse: Mouse,
  database: MPackDb | null,
  name: string,
  font: FontHolder,
  item: number,
  open: number,
  archive: MPackDb | null,
  pages: Page[] | null,
  defs: number,
  count: number,
): Blocking<ArchiveViewer> {
  v.titleLabel = null;
  v.page = null;
  v.links = [];
  v.current = -1;
  v.driver = driver;
  v.mouse = mouse;
  v.database = database;
  v.font = font;
  v.ownsArchive = open & 0xff;
  v.title = name;
  v.defs = defs;
  v.defCount = count;
  v.pages = [];
  labelsClear(driver, 0);
  v.bar = buttonBarCreate(new ButtonBar(), driver, font, 0, buttonDefsAt(defs, count), count);
  buttonBarAdd(v.bar, viewerDef(v, 3), 3, v.bar.outline);
  if (v.ownsArchive === 1) {
    const bytes = dosFileLoad(v.title);
    // 0x75d46 'Could not open archive database\n'
    if (!bytes) fatal(v, 'Could not open archive database\n');
    v.archive = mpackDbOpen(v.title, bytes);
  } else v.archive = archive;
  if (pages !== null) {
    for (let i = 0; i < pages.length; i++) collectionAppend(v.pages, collectionGet(pages, i)!);
    v.current = 0;
    archivePrevPage(v);
    return v;
  }
  const db = v.archive!;
  const head = mpackDbReadAt(db, item, 0, 2);
  // 0x75ce2 'Could not access Archive DB entry\n'
  if (!head) fatal(v, 'Could not access Archive DB entry\n');
  // 0x75d05 'Cmd Title not found\n', 0x75d1a 'Found: %d\n'
  if ((head[0]! | (head[1]! << 8)) !== 0x0100) fatal(v, 'Cmd Title not found\n');
  const title = mpackDbReadString(db, item, 2) ?? '';
  let offset = 2 + title.length + 1;
  // 0x75d25 '~': the title is centred
  v.title = '~' + title;
  let current: Page | null = null;
  let played = 0;
  let total = 0;
  let ordinal = 0;
  const newPage = (): Page => {
    const p = pageInit(new Page(), v.font!, v.driver!, v.colour, 0x58, 0x46, 0x1d2, 0xde);
    collectionAppend(v.pages, p);
    return p;
  };
  for (;;) {
    yield* mouseUpdate(v.mouse!);
    const rec = archiveReadOp(db, item, offset);
    if (rec.op === 0x0200) {
      const lines = (rec as { lines: string[] }).lines;
      // 0x91ed8, from the "" at 0x75d27
      let text = '';
      for (let i = 0; i <= lines.length; i++) {
        // the read that stopped at the NUL is the last, and keeps nothing
        yield* mouseUpdate(v.mouse!);
        if (i === lines.length) break;
        const line = lines[i]!;
        total += line.length;
        if (played === 0 && total >= 0x800) {
          if (shell.sound103) soundSamplePlay(shell.sound103);
          played = 1;
        }
        text = text.slice(0, text.length - (text.length > 0 ? 1 : 0)) + line + ' ';
      }
      v.colour[0] = 0xff;
      v.colour[1] = 5;
      for (let i = 2; i < 0x100; i++) v.colour[i] = i;
      let rest: string | null = null;
      do {
        if (current === null || rest !== null) current = newPage();
        yield* mouseUpdate(v.mouse!);
        rest = textLayoutPage(current, rest ?? text);
      } while (rest !== null);
      current = null;
    } else if (rec.op === 0x0300) {
      const r = rec as { item: number };
      const shapes = mpackDbGetItem(db, r.item);
      if (current === null) current = newPage();
      if (!shapes) unestablished('archive_page_load: a picture item outside the archive (the original hands picture_init what its locals held)', 'archive_page_load');
      else pageSetPicture(current, shapes, shapes.length);
    } else if (rec.op === 0x0400) {
      const r = rec as { page: number };
      const link: ArchiveLink = { id: ordinal + 4, page: r.page };
      ordinal++;
      collectionAppend(v.links, link);
    } else if (rec.op === 0xff00) {
      archivePrevPage(v);
      return v;
    } else {
      // 0x75d28 'Unknown Archive Command Code\n'
      fatal(v, 'Unknown Archive Command Code\n');
    }
    offset = rec.next;
  }
}

/**
 * Frees a viewer: every page taken down (and destroyed when the viewer
 * read them from an archive), the bar, the archive if it opened it, and
 * the title.
 *
 * @mw2shell archive_viewer_destroy 0x00028150
 * @fidelity exact
 * @divergence the archive's bytes are the host's: closing it frees nothing
 */
export function archiveViewerDestroy(v: ArchiveViewer): ArchiveViewer {
  for (let i = 0; i < v.pages.length; i++) {
    const p = collectionGet(v.pages, i)!;
    pageHide(p);
    if (v.archive !== null && p !== null) pageDestroy(p);
  }
  if (v.bar) buttonBarDestroy(v.bar);
  if (v.ownsArchive === 1 && v.archive) {
    // mpack_db_close
  }
  if (v.titleLabel) labelDestroy(v.titleLabel);
  return v;
}

/**
 * Back one page (and the start: page_load and HOME call it with the
 * current page one past where they want it). The page left is taken down
 * and, for an archive, its link buttons (index 4 up) removed. On page 0
 * PREV PAGE goes and the title is put up again; NEXT PAGE is there while
 * a later page is; the new page's regions become buttons, and it types
 * out again.
 *
 * @mw2shell archive_prev_page 0x00026ca0
 * @fidelity exact
 */
export function archivePrevPage(v: ArchiveViewer): void {
  const bar = v.bar!;
  if (v.pages.length === 1) buttonBarRemove(bar, 2);
  if (v.current > 0 && v.current < v.pages.length) {
    pageHide(collectionGet(v.pages, v.current)!);
    if (v.archive !== null) buttonBarTruncate(bar, 4);
  }
  v.current--;
  if (v.current < 0) v.current = 0;
  if (v.current === 0) {
    buttonBarRemove(bar, 1);
    if (v.titleLabel) labelDestroy(v.titleLabel);
    v.titleLabel = labelCreateUnder(shell.font27!, 0x140, 0x32, v.title, null);
  }
  if (v.current < v.pages.length && v.pages.length > 1) {
    buttonBarRemove(bar, 2);
    buttonBarAdd(bar, viewerDef(v, 2), 2, bar.outline);
  }
  if (v.pages.length > 0) {
    v.page = collectionGet(v.pages, v.current);
    addRegionButtons(v, v.page!);
    pageRestart(v.page!);
  }
}

/**
 * (viewer, button): the link whose id is the button's index opens its page
 * in a nested viewer over the same archive, run here until it says -2
 * (back: 5 is returned and this viewer carries on) or something other
 * than 5 (returned as it is). The page on screen is taken down first; no
 * such link returns -2.
 *
 * @mw2shell archive_follow_link 0x00027050
 * @fidelity exact
 */
export function* archiveFollowLink(v: ArchiveViewer, id: number): Blocking<number> {
  pageHide(collectionGet(v.pages, v.current)!);
  let link: ArchiveLink | null = null;
  for (let i = 0; i < v.links.length; i++) {
    const l = collectionGet(v.links, i)!;
    if (id === l.id) {
      link = l;
      break;
    }
  }
  if (!link) return -2;
  if (v.titleLabel) {
    labelDestroy(v.titleLabel);
    v.titleLabel = null;
  }
  const nested = yield* archivePageLoad(new ArchiveViewer(), v.driver!, v.mouse!, v.database, v.title, shell.archiveFont!, link.page, 0, v.archive, null, v.defs, v.defCount);
  let r: number;
  do {
    r = yield* archiveViewerFrame(nested);
    if (r === -2) {
      archiveViewerDestroy(nested);
      return 5;
    }
  } while (r === 5);
  archiveViewerDestroy(nested);
  return r;
}

/**
 * One frame of a viewer; 5 to go on. shell_menu first (its result is
 * returned); the page types a character; the title is put back if it went.
 * PgUp, PgDn and Home press PREV PAGE (1), NEXT PAGE (2) and button 3 (a
 * click is injected). 0 EXIT returns -5; 1 goes back a page; 2 forward a
 * page (the last page drops NEXT PAGE); 3 goes to the first page, or on it
 * returns -2 (back); a click on any other button of an archive follows
 * its link.
 *
 * @mw2shell archive_viewer_frame 0x00027160
 * @fidelity exact
 */
export function* archiveViewerFrame(v: ArchiveViewer): Blocking<number> {
  const menu = yield* shellMenu();
  if (menu !== -1) return menu;
  if (v.page) pageTypeStep(v.page);
  if (!v.titleLabel) v.titleLabel = labelCreateUnder(shell.font27!, 0x140, 0x32, v.title, null);
  const m = v.mouse!;
  yield* mouseUpdate(m);
  let hit = buttonBarHit(v.bar!, m.x, m.y);
  const key = shell.keyInput!.key;
  if (key === 0x8049) {
    mouseInjectClick(m, 0);
    hit = 1;
  } else if (key === 0x8051) {
    mouseInjectClick(m, 0);
    hit = 2;
  } else if (key === 0x8047) {
    mouseInjectClick(m, 0);
    hit = 3;
  }
  const bar = v.bar!;
  switch (hit) {
    case 0:
      if (mouseLeftClicked(m) === 1) return -5;
      return 5;
    case 1:
      if (mouseLeftClicked(m) === 1) archivePrevPage(v);
      return 5;
    case 2: {
      if (mouseLeftClicked(m) !== 1) return 5;
      if (v.current >= 0 && v.current < v.pages.length - 1) {
        pageHide(collectionGet(v.pages, v.current)!);
        if (v.archive !== null) buttonBarTruncate(bar, 4);
      }
      v.current++;
      if (v.current >= v.pages.length) v.current = v.pages.length - 1;
      if (v.pages.length - 1 === v.current) buttonBarRemove(bar, 2);
      if (v.current > 0) {
        buttonBarRemove(bar, 1);
        buttonBarAdd(bar, viewerDef(v, 1), 1, bar.outline);
      }
      v.page = collectionGet(v.pages, v.current);
      if (!v.page) {
        unestablished('archive_viewer_frame: NEXT PAGE with no pages (the original reads through NULL)', 'archive_viewer_frame');
        return 5;
      }
      addRegionButtons(v, v.page);
      pageRestart(v.page);
      return 5;
    }
    case 3:
      if (mouseLeftClicked(m) !== 1) return 5;
      if (v.current === 0) return -2;
      if (v.pages.length === 1) buttonBarRemove(bar, 2);
      if (v.current > 0 && v.current < v.pages.length) {
        pageHide(collectionGet(v.pages, v.current)!);
        if (v.archive !== null) buttonBarTruncate(bar, 4);
      }
      v.current = 0;
      archivePrevPage(v);
      return 5;
    default:
      if (v.archive !== null && mouseLeftClicked(m) === 1 && hit !== -1) return yield* archiveFollowLink(v, hit);
      return 5;
  }
}
