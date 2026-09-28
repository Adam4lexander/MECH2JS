/**
 * State 0xe, cadet training (decompiled/mw2shell/src/screens/shell_3d980.c):
 * six training missions per career, offered once the intro animation has
 * played; a pick launches the sim.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem, type MPackDb } from '../../data/formats/mpack.ts';
import { mem } from '../memory.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animFreeAll, animIsRunning, animPlayToEnd, animStart, animUpdateAll } from '../anim/anims.ts';
import { ButtonBar, buttonBarAdd, buttonBarCreate, buttonBarDestroy, buttonBarHit } from '../ui/buttonBar.ts';
import { mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { Sample, soundSampleCreate, soundSampleDestroy, soundSamplePlay, soundSampleSetLooping, soundSampleSetVolume } from '../sound/samples.ts';
import { missionBrf2Load, type Brf2Planet } from '../career/brf2.ts';
import { clock, srand } from '../clib.ts';
import { screenRowBackground, screenRowButtonCount, screenRowButtons } from './screenRows.ts';
import { shellScreens } from './registry.ts';

/**
 * (db, career, &missionName). DATABASE item 76 loops at volume 50. The
 * intro (awotrnwn at (453, 0) / ajftrnwn at (416, 0), flags 0x42) plays in
 * slot 0 and *trnwa at (72, 224) in slot 3; the bar
 * (trainingScreenRows[career]) starts with button 0 alone, and buttons 1..
 * are added once slot 0 has stopped. Whenever slot 3 is idle a countdown
 * runs, and at 0 plays *trnwb, then *trnwa next time, alternating (20 000
 * passes apart). Button 0 -> 1; button n stores
 * trainingMissionTables[career][n - 1] as the mission, loads its BRF2 (the
 * launch animation only), plays the door (*trndr, slot 16) to the end and
 * returns 10.
 *
 * @mw2shell screen_training 0x0003d980
 * @fidelity exact
 */
export function* screenTraining(db: MPackDb, career: number, missionName: { value: string }): Blocking<number> {
  const d = driver();
  const ms = mouse();
  let countdown = -1;
  let alternate = 0;
  let added = 0;
  const wav = mpackDbGetItem(db, 0x4c);
  const sample = soundSampleCreate(new Sample(), shell.soundSystem!, wav, wav?.length ?? 0);
  soundSampleSetVolume(sample, 0x32);
  soundSampleSetLooping(sample);
  screenLoadBackground(d, db, screenRowBackground(SHELL_LABEL.trainingScreenRows, career));
  let next = -1;
  if (career === 0) {
    // 0x78064 'awotrnwn', 0x7806d 'awotrnwa'
    yield* animStart(0, 'awotrnwn', 0x1c5, 0, 0x42, 0);
    yield* animStart(3, 'awotrnwa', 0x48, 0xe0, 2, 0);
  } else if (career === 1) {
    // 0x78076 'ajftrnwn', 0x7807f 'ajftrnwa'
    yield* animStart(0, 'ajftrnwn', 0x1a0, 0, 0x42, 0);
    yield* animStart(3, 'ajftrnwa', 0x48, 0xe0, 2, 0);
  }
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, screenRowButtons(SHELL_LABEL.trainingScreenRows, career, 1), 1);
  soundSamplePlay(sample);
  srand(clock());
  do {
    if (added === 0 && animIsRunning(0) === 0) {
      added = 1;
      const count = screenRowButtonCount(SHELL_LABEL.trainingScreenRows, career);
      const defs = screenRowButtons(SHELL_LABEL.trainingScreenRows, career, count);
      for (let i = 1; i < count; i++) buttonBarAdd(bar, defs[i]!, i, 0);
    }
    if (animIsRunning(3) === 0) {
      if (countdown === 0) {
        // 0x78088 'awotrnwa' / 0x78091 'awotrnwb', 0x7809a 'ajftrnwa' / 0x780a3 'ajftrnwb'
        if (career === 0) {
          yield* animStart(3, alternate !== 0 ? 'awotrnwa' : 'awotrnwb', 0x48, 0xe0, 2, 0);
          alternate = 1 - alternate;
        } else if (career === 1) {
          yield* animStart(3, alternate !== 0 ? 'ajftrnwa' : 'ajftrnwb', 0x48, 0xe0, 2, 0);
          alternate = 1 - alternate;
        }
      }
      if (--countdown < 0) countdown = 20000;
    }
    animUpdateAll();
    yield* mouseUpdate(ms);
    const hit = buttonBarHit(bar, ms.x, ms.y);
    if (hit === 0) {
      if (mouseLeftClicked(ms) === 1) next = 1;
    } else if (hit !== -1 && mouseLeftClicked(ms) === 1) {
      const table = mem().u32(SHELL_LABEL.trainingMissionTables + career * 4);
      missionName.value = mem().ptrStr(table + (hit - 1) * 4) ?? '';
      next = 10;
      void (missionBrf2Load(missionName.value, false, false) satisfies Brf2Planet | null);
      // 0x780ac 'awotrndr', 0x780b5 'ajftrndr'
      if (career === 0) yield* animStart(0x10, 'awotrndr', 0x230, 0xa8, 2, 0);
      else if (career === 1) yield* animStart(0x10, 'ajftrndr', 0x21c, 0xa8, 2, 0);
      yield* animPlayToEnd(0x10);
    }
    if (next === -1) next = yield* shellMenu();
  } while (next === -1);
  animFreeAll();
  buttonBarDestroy(bar);
  soundSampleDestroy(sample);
  return next;
}

shellScreens.register(0xe, (l) => screenTraining(l.db, l.career.value, l.commandLine));
