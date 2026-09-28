/**
 * State 0, the mission briefing (decompiled/mw2shell/src/handoff/
 * mission_prep.c): the mission's BRF1 stream's orders, typed out, with
 * ABORT, SITUATION (the rest of the orders in the document viewer),
 * LAUNCH, and - for the pilot FERRARI only - SKIP. README "The briefing
 * screen (state 0)".
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import type { MPackDb } from '../../data/formats/mpack.ts';
import { unestablished } from '../../core/provenance.ts';
import { mem } from '../memory.ts';
import { database, driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonDefsAt, buttonDisable } from '../ui/buttonBar.ts';
import { inputFlush } from '../ui/keys.ts';
import { mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { Page, pageDestroy, pageHide, pageRestart, pageTypeStep } from '../text/page.ts';
import { ArchiveViewer, archivePageLoad, archiveViewerDestroy, archiveViewerFrame } from '../archive/viewer.ts';
import { ordersTextBuild } from '../career/orders.ts';
import { currentPilot, pilotField, pilotName } from '../career/missions.ts';
import { collectionRemove, collectionGet, struprString } from '../util/collection.ts';
import { SCREEN_ROW, screenRowAt, screenRowBackground, screenRowButtonCount, screenRowButtonsAddr } from './screenRows.ts';
import { shellScreens } from './registry.ts';

/**
 * The stream the briefing reads: the mission name's first four letters (to
 * a '.'), '_'-padded, + 'BRF1', upper-cased (yellSCN1 -> YELLBRF1); on
 * mission 15 with rank 6 or more KTWOBRF1 (Wolf) or KTJFBRF1 (Jade
 * Falcon).
 */
function briefingStream(missionName: string, career: number): string {
  const pilot = currentPilot();
  let mission = 0;
  let rank = 0;
  if (pilot === 0) unestablished('screen_briefing: no current pilot (the original reads missionIndex and rank through NULL)', 'screen_briefing');
  else {
    mission = pilotField(pilot, 'missionIndex');
    rank = pilotField(pilot, 'rank');
  }
  let name = '';
  if (mission === 0xf && rank >= 6) {
    // 0x733f4 'KTWOBRF1', 0x733fd 'KTJFBRF1'
    if (career === 0) name = 'KTWOBRF1';
    else if (career === 1) name = 'KTJFBRF1';
    else unestablished('screen_briefing: mission 15, rank 6+, career 2 - the stream name buffer is left as the stack held it', 'screen_briefing');
  } else {
    let i = 0;
    for (; i < 4; i++) {
      const c = i < missionName.length ? missionName.charCodeAt(i) : 0;
      if (c === 0 || c === 0x2e) break;
      name += missionName[i];
    }
    for (; i < 4; i++) name += '_';
    // 0x73406 'BRF1'
    name += 'BRF1';
  }
  // strupr (strupr) on the stack buffer
  return struprString(name);
}

/**
 * (db, missionName, career): the orders are laid out first (box by career:
 * Wolf 88, 30, 454 x 400; Jade Falcon 98, 51, 403 x 372; career 2 88, 30,
 * 454 x 408, in pageFont); with no page at all it returns 10 at once.
 * Otherwise the career's background, the first page on its own (the rest
 * are SITUATION's), the keyboard drained, and briefingScreenRows[career]'s
 * buttons - its count rewritten to 3 in the table unless the pilot is
 * FERRARI, so only FERRARI gets SKIP; SITUATION is disabled when there is
 * no second page. Each pass: mouse_update, a character typed, the bar
 * polled - ABORT 0xb (the ready room), SITUATION (the page taken down, the
 * viewer over the other pages until it returns something other than 5:
 * -3 and 8 are kept as the result, anything else comes back here), LAUNCH
 * 10, SKIP 3 (the debriefing) - and shell_menu when nothing decided.
 *
 * @mw2shell screen_briefing 0x0001c080
 * @fidelity exact
 */
export function* screenBriefing(db: MPackDb, missionName: string, career: number): Blocking<number> {
  const m = mem();
  const pages: Page[] = [];
  let x: number;
  let y: number;
  let width: number;
  let height: number;
  if (career >>> 0 <= 0) {
    x = 0x58;
    y = 0x1e;
    width = 0x1c6;
    height = 400;
  } else if (career === 1) {
    x = 0x62;
    y = 0x33;
    width = 0x193;
    height = 0x174;
  } else {
    x = 0x58;
    y = 0x1e;
    width = 0x1c6;
    height = 0x198;
  }
  const stream = briefingStream(missionName, career);
  // 0x7a684 '': \Q becomes nothing (and tmp.out is written)
  ordersTextBuild(pages, x, y, width, height, stream, shell.pageFont!, '');
  const page = collectionGet(pages, 0);
  if (!page) return 10;
  const d = driver();
  const rows = SHELL_LABEL.briefingScreenRows;
  screenLoadBackground(d, db, screenRowBackground(rows, career));
  collectionRemove(pages, page, 0);
  inputFlush(shell.keyInput!);
  const pilot = currentPilot();
  // 0x7340b 'FERRARI'
  if (pilot === 0 || pilotName(pilot) !== 'FERRARI') m.setI32(screenRowAt(rows, career) + SCREEN_ROW.buttonCount, 3);
  const buttons = () => buttonDefsAt(screenRowButtonsAddr(rows, career), screenRowButtonCount(rows, career));
  let bar: ButtonBar = buttonBarCreate(new ButtonBar(), d, shell.pageFont, 0, buttons(), screenRowButtonCount(rows, career));
  if (pages.length === 0) buttonDisable(bar, 1);
  let next = -1;
  pageRestart(page);
  const ms = mouse();
  do {
    yield* mouseUpdate(ms);
    pageTypeStep(page);
    switch (buttonBarHit(bar, ms.x, ms.y)) {
      case 0:
        if (mouseLeftClicked(ms) === 1) next = 0xb;
        break;
      case 1:
        if (mouseLeftClicked(ms) === 1) {
          pageHide(page);
          buttonBarDestroy(bar);
          const situation = SHELL_LABEL.briefingSituationRows;
          // 0x73413 '': the viewer opens no archive
          const v = yield* archivePageLoad(
            new ArchiveViewer(),
            d,
            ms,
            database(),
            '',
            shell.archiveFont!,
            -1,
            0,
            null,
            pages,
            screenRowButtonsAddr(situation, career),
            screenRowButtonCount(situation, career),
          );
          let r: number;
          do {
            r = yield* archiveViewerFrame(v);
            if (r === -3) next = -3;
            if (r === 8) next = 8;
          } while (r === 5);
          archiveViewerDestroy(v);
          bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, buttons(), screenRowButtonCount(rows, career));
          pageRestart(page);
        }
        break;
      case 2:
        if (mouseLeftClicked(ms) === 1) next = 10;
        break;
      case 3:
        if (mouseLeftClicked(ms) === 1) next = 3;
        break;
    }
    if (next === -1) next = yield* shellMenu();
  } while (next === -1);
  pageDestroy(page);
  buttonBarDestroy(bar);
  return next;
}

shellScreens.register(0, (l) => screenBriefing(l.db, l.commandLine.value, l.career.value));
