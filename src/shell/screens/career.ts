/**
 * State 1, the Clan hall (decompiled/mw2shell/src/career/career.c): the
 * career's hall with its animated furniture, and five hotspots - CADET
 * TRAINING, ARCHIVE HOLOPROJECTOR, READY ROOM, REGISTER, EXIT.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem, type MPackDb } from '../../data/formats/mpack.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animFreeAll, animPlayToEnd, animStart, animStartFree, animUpdateAll } from '../anim/anims.ts';
import { moviePlayInline } from '../anim/movies.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit } from '../ui/buttonBar.ts';
import { mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { messageBox } from '../ui/messageBox.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { Sample, soundSampleCreate, soundSampleDestroy, soundSamplePlay, soundSampleSetLooping, soundSampleSetVolume } from '../sound/samples.ts';
import { currentPilot, pilotField } from '../career/missions.ts';
import { screenRowBackground, screenRowButtons } from './screenRows.ts';
import { shellScreens } from './registry.ts';

/**
 * (db, career, pilotAccepted, previousState). With no pilot accepted it
 * plays the register movie (aworgstr / ajfrgstr) and returns 0xc at once.
 * Otherwise the hall (careerScreenRows[career]): Wolf starts awoball,
 * awoarcht and awolite1..3 and loops DATABASE item 79 at volume 50; Jade
 * Falcon starts ajfball and ajfarcht and the doors by where the player
 * came from - ajf8orl1 after training, ajf8orr1 after the ready room, both
 * after the register. CADET TRAINING -> 0xe (Jade Falcon: the left door
 * plays out, then ajf8torl); ARCHIVE -> 5 after the holoprojector
 * (awoholop / ajfholop) and sound 103; READY ROOM -> 0xb while
 * missionIndex < 16 (Jade Falcon: the right door, then ajf8torr), else
 * 'This pilot has already won the game.' and 0x10, the ending; REGISTER
 * -> 0xc after the register movie; EXIT -> 8.
 *
 * @mw2shell screen_career 0x0001dbe0
 * @fidelity exact
 */
export function* screenCareer(db: MPackDb, career: number, pilotAccepted: number, previous: number): Blocking<number> {
  const d = driver();
  const ms = mouse();
  let sample: Sample | null = null;
  screenLoadBackground(d, db, screenRowBackground(SHELL_LABEL.careerScreenRows, career));
  animFreeAll();
  if ((pilotAccepted & 0xff) === 0) {
    yield* mouseUpdate(ms);
    // 0x734f0 'aworgstr', 0x734f9 'ajfrgstr'
    if (career === 0) yield* moviePlayInline('aworgstr');
    else if (career === 1) yield* moviePlayInline('ajfrgstr');
    return 0xc;
  }
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, screenRowButtons(SHELL_LABEL.careerScreenRows, career, 5), 5);
  if (career === 0) {
    // 0x73502 'awoball', 0x7350a 'awoarcht', 0x73513 / 0x7351c / 0x73525 'awolite1..3'
    yield* animStart(0, 'awoball', 0x5b, 0x17c, 10, 0);
    yield* animStart(1, 'awoarcht', 0x148, 0x14c, 0x4a, 0);
    yield* animStart(2, 'awolite1', 0, 0x118, 0x4a, 0);
    yield* animStart(3, 'awolite2', 0x9e, 300, 0x4a, 0);
    yield* animStart(4, 'awolite3', 0x244, 0x113, 0x4a, 0);
    const wav = mpackDbGetItem(db, 0x4f);
    sample = soundSampleCreate(new Sample(), shell.soundSystem!, wav, wav?.length ?? 0);
    soundSampleSetVolume(sample, 0x32);
    soundSampleSetLooping(sample);
  } else if (career === 1) {
    // 0x7352e 'ajfball', 0x73536 'ajfarcht'
    yield* animStart(0, 'ajfball', 400, 0x180, 0x4a, 0);
    yield* animStart(1, 'ajfarcht', 0xdc, 0x118, 0x4a, 0);
    // 0x7353f / 0x73551 'ajf8orl1', 0x73548 / 0x7355a 'ajf8orr1'
    if (previous === 0xe) yield* animStart(2, 'ajf8orl1', 0, 0, 2, 0);
    else if (previous === 0xb) yield* animStart(3, 'ajf8orr1', 0x194, 1, 2, 0);
    else if (previous === 0xc) {
      yield* animStart(2, 'ajf8orl1', 0, 0, 0x42, 0);
      yield* animStart(3, 'ajf8orr1', 0x194, 1, 2, 0);
    }
  }
  if (sample) soundSamplePlay(sample);
  let next = -1;
  do {
    animUpdateAll();
    yield* mouseUpdate(ms);
    switch (buttonBarHit(bar, ms.x, ms.y)) {
      case 0:
        if (mouseLeftClicked(ms) === 1) {
          next = 0xe;
          if (career === 1) {
            yield* animPlayToEnd(2);
            // 0x73563 'ajf8torl' (x, y 0; flags 2 left in ECX by the call before)
            yield* animPlayToEnd(yield* animStartFree('ajf8torl', 0, 0, 2, 0));
          }
        }
        break;
      case 1:
        if (mouseLeftClicked(ms) === 1) {
          next = 5;
          // 0x7356c 'awoholop', 0x73575 'ajfholop'
          if (career === 0) yield* animPlayToEnd(yield* animStart(1, 'awoholop', 0x14c, 0xe8, 2, 0));
          else if (career === 1) yield* animPlayToEnd(yield* animStart(1, 'ajfholop', 0xd1, 0xca, 2, 0));
          soundSamplePlay(shell.sound103!);
        }
        break;
      case 2:
        if (mouseLeftClicked(ms) === 1) {
          if (pilotField(currentPilot(), 'missionIndex') < 0x10) {
            next = 0xb;
            if (career === 1) {
              yield* animPlayToEnd(3);
              // 0x735aa 'ajf8torr' (x 0x194 left in EDX, y the career)
              yield* animPlayToEnd(yield* animStartFree('ajf8torr', 0x194, 1, 2, 0));
            }
          } else {
            next = 0x10;
            // 0x7357e 'This pilot has|already won the game.#Finale'
            yield* messageBox('This pilot has|already won the game.#Finale', 0);
          }
        }
        break;
      case 3:
        if (mouseLeftClicked(ms) === 1) {
          animFreeAll();
          next = 0xc;
          // 0x735b3 'aworgstr', 0x735bc 'ajfrgstr'
          if (career === 0) yield* moviePlayInline('aworgstr');
          else if (career === 1) yield* moviePlayInline('ajfrgstr');
        }
        break;
      case 4:
        if (mouseLeftClicked(ms) === 1) next = 8;
        break;
    }
    if (next === -1) next = yield* shellMenu();
  } while (next === -1);
  animFreeAll();
  buttonBarDestroy(bar);
  if (sample) soundSampleDestroy(sample);
  return next;
}

shellScreens.register(1, (l) => screenCareer(l.db, l.career.value, l.accepted.value, l.previous));
