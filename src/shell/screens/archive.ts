/**
 * State 5, the Clan archive (decompiled/mw2shell/src/screens/
 * shell_263d0.c): the career's archive - ARCHWO.MW2 for Wolf, ARCHJF.MW2
 * for Jade Falcon - opened at its home page in the document viewer.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import type { MPackDb } from '../../data/formats/mpack.ts';
import { mem } from '../memory.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { ArchiveViewer, archivePageLoad, archiveViewerDestroy, archiveViewerFrame } from '../archive/viewer.ts';
import { screenRowBackground, screenRowButtonsAddr } from './screenRows.ts';
import { shellScreens } from './registry.ts';

/**
 * (db, career): archiveScreenRows[career]'s background, then the viewer on
 * archiveNames[career], page item 1 (the home page), with that row's
 * buttons - a count of 1 (EXIT; the viewer adds BACK, PREV and NEXT PAGE
 * itself). It runs until the viewer stops returning 5; -5 (EXIT) becomes
 * -2, back to the state before.
 *
 * @mw2shell screen_archive 0x00026b50
 * @fidelity exact
 */
export function* screenArchive(db: MPackDb, career: number): Blocking<number> {
  const d = driver();
  screenLoadBackground(d, db, screenRowBackground(SHELL_LABEL.archiveScreenRows, career));
  const name = mem().ptrStr(SHELL_LABEL.archiveNames + career * 4) ?? '';
  const v = yield* archivePageLoad(new ArchiveViewer(), d, mouse(), db, name, shell.archiveFont!, 1, 1, null, null, screenRowButtonsAddr(SHELL_LABEL.archiveScreenRows, career), 1);
  let r: number;
  do {
    r = yield* archiveViewerFrame(v);
    if (r === -5) r = -2;
  } while (r === 5);
  archiveViewerDestroy(v);
  return r;
}

shellScreens.register(5, (l) => screenArchive(l.db, l.career.value));
