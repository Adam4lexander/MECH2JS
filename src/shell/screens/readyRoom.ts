/**
 * State 0xb, the ready room (decompiled/mw2shell/src/career/ready_room.c):
 * CLAN HALL, MECH LAB, STAR CONFIG and MISSION BRIEFING, with the Trial
 * Protocol lockouts, and - for the FREEBIRTHTOAD pilot only - the sixteen
 * campaign missions as buttons.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { divergence } from '../../core/provenance.ts';
import { mpackDbGetItem, type MPackDb } from '../../data/formats/mpack.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animFreeAll, animIsRunning, animSetFlags, animStart, animStartFree, animUpdateAll } from '../anim/anims.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit } from '../ui/buttonBar.ts';
import { mouseLeftClicked, mouseSetPosition, mouseUpdate } from '../ui/mouse.ts';
import { messageBox } from '../ui/messageBox.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { Sample, soundSampleCreate, soundSampleDestroy, soundSamplePlay, soundSampleSetVolume } from '../sound/samples.ts';
import { careerRegistrySave } from '../career/registry.ts';
import { missionBrf2Load, type Brf2Planet } from '../career/brf2.ts';
import { careerMission, currentPilot, pilotField, pilotName, setPilotField } from '../career/missions.ts';
import { starConfigure, starMemberChassis } from '../handoff/stars.ts';
import { chassisEntry } from '../handoff/starFiles.ts';
import { screenRowBackground, screenRowButtonCount, screenRowButtons } from './screenRows.ts';
import { shellScreens } from './registry.ts';

/** The current pilot's own mission is a Trial of Position (careerMissionTables[pilot's career][missionIndex].isTrial == 1). */
function onTrial(): boolean {
  const p = currentPilot();
  return careerMission(pilotField(p, 'career'), pilotField(p, 'missionIndex')).isTrial === 1;
}

/**
 * The table holograms on the CD are named with one letter - SMK\AWOMSTBL /
 * AJFMSTBL the Dire Wolf (code 'da'), AWODSTBL / AJFDSTBL the Timber Wolf
 * ('mc'), identified by comparing their last frames with the mech lab's
 * awomp/ajfmp chassis shapes (a first guess from the letters, M for Mad Cat
 * and D for Daishi, had them the wrong way round) - where the shell
 * asks for awo%stbl with the two-letter code: a nine-character name, which
 * DOS truncates (AWOMCSTB) and never finds. So the shipped game never
 * shows them. The port tries these names after the original's: the Dire
 * Wolf's for the Dire Wolf, and the Timber Wolf's for every other chassis,
 * which have none of their own.
 *
 * @portOnly
 * @divergence the table hologram plays - the Dire Wolf's for the Dire Wolf, the Timber Wolf's for the rest; the original's lookup never finds one
 */
function tableHologramName(career: number, animCode: string): string | null {
  if (career !== 0 && career !== 1) return null;
  const letter = animCode === 'da' ? 'm' : 'd';
  divergence('the MECH LAB table hologram: the CD names it with one letter, which the shell\'s awo%stbl never finds', 'screen_ready_room');
  return `${career === 0 ? 'awo' : 'ajf'}${letter}stbl`;
}

/**
 * (db, career, &commandLine, previousState). Sound: DATABASE item 100 at
 * volume 50. The grid animation (awogrid1 / ajfgrid1, then awogrid2 /
 * ajfgrid2 looping); Wolf puts the pointer at (435, 360); Jade Falcon
 * coming from the hall plays its door (ajfv8trd). Buttons
 * (readyRoomScreenRows[career]; all 20 only for the pilot named
 * FREEBIRTHTOAD, else 4): 0 CLAN HALL -> 1 (Jade Falcon: the door closes,
 * ajfv8tru, first); 1 MECH LAB -> 9 after the chassis animation
 * (awo%stbl / ajf%stbl of the selected member's chassis, the Rifleman IIC
 * when none) - on a Trial only 'Trial Protocol: X0769-Q ...'; 2 STAR
 * CONFIG -> 0xd, on a Trial only "Your 'Mech has been selected for you";
 * 3 MISSION BRIEFING -> 0 after awobrief / ajfbrief; 4..19 set
 * missionIndex to button - 4, save the registry, load that mission and go
 * to the briefing the same way. A state waits for its animation to finish.
 *
 * @mw2shell screen_ready_room 0x00037a50
 * @fidelity exact
 */
export function* screenReadyRoom(db: MPackDb, career: number, commandLine: { value: string }, previous: number): Blocking<number> {
  const d = driver();
  const ms = mouse();
  const wav = mpackDbGetItem(db, 100);
  const sample = soundSampleCreate(new Sample(), shell.soundSystem!, wav, wav?.length ?? 0);
  let waitSlot = -1;
  soundSampleSetVolume(sample, 0x32);
  screenLoadBackground(d, db, screenRowBackground(SHELL_LABEL.readyRoomScreenRows, career));
  // 0x77ba6 'FREEBIRTHTOAD'
  const count = pilotName(currentPilot()) === 'FREEBIRTHTOAD' ? screenRowButtonCount(SHELL_LABEL.readyRoomScreenRows, career) : 4;
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, screenRowButtons(SHELL_LABEL.readyRoomScreenRows, career, count), count);
  if (career === 0) {
    // 0x77bb4 'awogrid1'
    yield* animStart(0, 'awogrid1', 0x12f, 0x149, 0x44, 0);
    mouseSetPosition(ms, 0x1b3, 0x168);
  } else if (career === 1) {
    // 0x77bbd 'ajfgrid1', 0x77bc6 'ajfv8trd'
    yield* animStart(0, 'ajfgrid1', 0x115, 0x155, 0x44, 0);
    if (previous === career) yield* animStart(0x10, 'ajfv8trd', 1, 0x6c, 2, 0);
  }
  let next = -1;
  /** The grid's loop, restarted whenever it is not running (0x77b94 'awogrid2', 0x77b9d 'ajfgrid2'). */
  const gridLoop = function* (): Blocking<void> {
    if (animIsRunning(0) !== 0) return;
    if (career === 0) yield* animStart(0, 'awogrid2', 0x12f, 0x149, 0x48, 0);
    else if (career === 1) yield* animStart(0, 'ajfgrid2', 0x115, 0x155, 0x48, 0);
  };
  /** MISSION BRIEFING's animation (0x77c72 'awobrief', 0x77c7b 'ajfbrief'), then state 0. */
  const briefing = function* (): Blocking<void> {
    if (career === 0) waitSlot = yield* animStartFree('awobrief', 0x69, 100, 6, 0);
    else if (career === 1) waitSlot = yield* animStartFree('ajfbrief', 0x6b, 0x69, 6, 0);
    next = 0;
  };
  for (;;) {
    yield* gridLoop();
    animUpdateAll();
    yield* mouseUpdate(ms);
    if (waitSlot !== -1) {
      if (animIsRunning(waitSlot) === 0) break;
      continue;
    }
    const hit = buttonBarHit(bar, ms.x, ms.y);
    switch (hit) {
      case -1:
        break;
      case 0:
        if (mouseLeftClicked(ms) === 1) {
          next = 1;
          if (career === 1) {
            while (animIsRunning(0x10) !== 0) {
              yield* gridLoop();
              animUpdateAll();
              yield* mouseUpdate(ms);
            }
            // 0x77c69 'ajfv8tru'
            waitSlot = yield* animStart(0x10, 'ajfv8tru', 1, 0x6c, 2, 0);
          }
        }
        break;
      case 1:
        if (mouseLeftClicked(ms) === 1) {
          // 0x77bcf "Trial Protocol: X0769-Q|Keshik to determine appropriate|'Mech for trial.#Ok"
          if (onTrial()) yield* messageBox("Trial Protocol: X0769-Q|Keshik to determine appropriate|'Mech for trial.#Ok", 0);
          else if (career === 0 || career === 1) {
            animSetFlags(0, 0x40000000, 0x40000000);
            let chassis = starMemberChassis(-1);
            if (chassis < 0) chassis = 7;
            // 0x77c1b 'awo%stbl', 0x77c24 'ajf%stbl'
            const name = `${career === 0 ? 'awo' : 'ajf'}${chassisEntry(chassis).animCode}stbl`;
            waitSlot = career === 0 ? yield* animStart(0, name, 0x131, 0xb9, 6, 0) : yield* animStart(0, name, 0x114, 0xa4, 6, 0);
            const hologram = waitSlot === -1 ? tableHologramName(career, chassisEntry(chassis).animCode) : null;
            if (hologram) waitSlot = career === 0 ? yield* animStart(0, hologram, 0x131, 0xb9, 6, 0) : yield* animStart(0, hologram, 0x114, 0xa4, 6, 0);
            next = 9;
            soundSamplePlay(sample);
          } else {
            next = 9;
            soundSamplePlay(sample);
          }
        }
        break;
      case 2:
        if (mouseLeftClicked(ms) === 1) {
          // 0x77c2d "Your 'Mech has been|selected for you.|Prepare for Trial!#Ok"
          if (onTrial()) yield* messageBox("Your 'Mech has been|selected for you.|Prepare for Trial!#Ok", 0);
          else next = 0xd;
        }
        break;
      case 3:
        if (mouseLeftClicked(ms) === 1) yield* briefing();
        break;
      default:
        if (mouseLeftClicked(ms) === 1) {
          setPilotField(currentPilot(), 'missionIndex', hit - 4);
          careerRegistrySave();
          commandLine.value = careerMission(career, hit - 4).scenario ?? '';
          starConfigure(0, 0, 3, 1, 100);
          void (missionBrf2Load(commandLine.value, true, false) satisfies Brf2Planet | null);
          yield* briefing();
        }
    }
    if (next === -1) next = yield* shellMenu();
    if (next !== -1 && waitSlot === -1) break;
  }
  animFreeAll();
  buttonBarDestroy(bar);
  soundSampleDestroy(sample);
  return next;
}

shellScreens.register(0xb, (l) => screenReadyRoom(l.db, l.career.value, l.commandLine, l.previous));
