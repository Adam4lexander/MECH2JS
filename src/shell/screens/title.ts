/**
 * State 8, the title: where a fresh session starts
 * (decompiled/mw2shell/src/career/pilots.c).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem, type MPackDb } from '../../data/formats/mpack.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonDefsAt } from '../ui/buttonBar.ts';
import { mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { messageBox } from '../ui/messageBox.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { animFreeAll, animStartFree, animUpdateAll } from '../anim/anims.ts';
import { Sample, soundSampleCreate, soundSampleDestroy, soundSamplePlay, soundSampleRamp, soundSampleRampStep, soundSampleSetLooping } from '../sound/samples.ts';

/**
 * (db, &career): background item 1, the four title buttons, the amwlogo1
 * loop (anim_start_free flags 10: loop, decoded into the background),
 * DATABASE item 74 looping under a ramp from silence up to 30, one unit
 * every 500 passes. TRIALS OF GRIEVANCE -> career 2, state 7; WOLF / JADE
 * FALCON CLAN HALL -> career 0 / 1, state 0xf (the landing movie); EXIT
 * asks 'Embrace cowardice?' and on Yes returns -3. Otherwise whatever
 * shell_menu returns.
 *
 * @mw2shell screen_title 0x0002a410
 * @fidelity exact
 */
export function* screenTitle(db: MPackDb, career: { value: number }): Blocking<number> {
  const d = driver();
  screenLoadBackground(d, db, 1);
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, buttonDefsAt(SHELL_LABEL.titleButtons, 4), 4);
  // 0x76a20 'amwlogo1'
  yield* animStartFree('amwlogo1', 0x6f, 0x21, 10, 0);
  const wav = mpackDbGetItem(db, 0x4a);
  const sample = soundSampleCreate(new Sample(), shell.soundSystem!, wav, wav?.length ?? 0);
  soundSampleSetLooping(sample);
  soundSamplePlay(sample);
  soundSampleRamp(sample, 500, 1000, 0, 0x1e);
  let next = -1;
  do {
    soundSampleRampStep(sample);
    animUpdateAll();
    const m = mouse();
    yield* mouseUpdate(m);
    switch (buttonBarHit(bar, m.x, m.y)) {
      case 0:
        if (mouseLeftClicked(m) === 1) {
          next = 7;
          career.value = 2;
        }
        break;
      case 1:
        if (mouseLeftClicked(m) === 1) {
          next = 0xf;
          career.value = 0;
        }
        break;
      case 2:
        if (mouseLeftClicked(m) === 1) {
          next = 0xf;
          career.value = 1;
        }
        break;
      case 3:
        // 0x76a29 'Embrace cowardice?#Yes|No'
        if (mouseLeftClicked(m) === 1 && (yield* messageBox('Embrace cowardice?#Yes|No', 1)) === 0) next = -3;
        break;
    }
    if (next === -1) next = yield* shellMenu();
  } while (next === -1);
  animFreeAll();
  buttonBarDestroy(bar);
  soundSampleDestroy(sample);
  return next;
}
