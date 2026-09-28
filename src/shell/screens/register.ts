/**
 * State 0xc, the pilot register (decompiled/mw2shell/src/career/register.c):
 * the career's ten MW2REG.CFG slots on the left, and on the right one of
 * two widget panels - PILOT INFO (registerPilotInfoPanel) or LAUNCH OLD
 * MISSION's list of the missions the pilot has completed
 * (registerMissionListPanel), which replays the one picked.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem, type MPackDb } from '../../data/formats/mpack.ts';
import { quirk } from '../../core/provenance.ts';
import { x87TruncStore } from '../../core/int/x87.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { mem } from '../memory.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animUpdateAll } from '../anim/anims.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonDisable, buttonEnable } from '../ui/buttonBar.ts';
import { labelCreateUnder, labelDestroy, type TextLabel } from '../ui/labels.ts';
import { mouseDoubleClicked, mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { messageBox } from '../ui/messageBox.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { textInput } from '../ui/textInput.ts';
import { registerWidgetClick, registerWidgetDraw, widgetField, widgetPanelFreeLabels, widgetPanelHit, widgetPanelLayout, widgetValueString } from '../ui/widgets.ts';
import { Sample, soundSampleCreate, soundSampleDestroy, soundSamplePlay, soundSampleSetVolume } from '../sound/samples.ts';
import { careerRegistryLoad, careerRegistrySave, pilotRecord } from '../career/registry.ts';
import { missionBrf2Load, type Brf2Planet } from '../career/brf2.ts';
import { careerMission, currentPilot, PILOT, pilotField, pilotName, rankTitle, setCurrentPilot, setPilotField } from '../career/missions.ts';
import { starConfigure, starSetMember } from '../handoff/stars.ts';
import { clock, strupr, rand, srand } from '../clib.ts';
import { screenRowBackground, screenRowButtons } from './screenRows.ts';
import { shellScreens } from './registry.ts';

const PILOT_INFO = SHELL_LABEL.registerPilotInfoPanel;
const MISSION_LIST = SHELL_LABEL.registerMissionListPanel;

export const register = registerGlobals(
  'registerScreen',
  {
    /**
     * Each slot's name label, by the record's address: the original keeps
     * the TextLabel pointer in the record's +0x38 (which career_registry_load
     * clears); the port keeps it here and leaves +0x38 zero.
     */
    nameLabels: new Map<number, TextLabel>(),
  },
  () => {
    register.nameLabels = new Map();
  },
  'mw2shell',
);

/** registerCareer (0xa6754): the career screen_register was entered with, which the draw functions index the campaigns by. */
function registerCareer(): number {
  return mem().i32(SHELL_LABEL.registerCareer);
}

/**
 * A heading row: the row's value (a string - '~RANK', '~HONOR',
 * '~MISSION', '~Select Mission') at (x, y) in font28, under the
 * animations.
 *
 * @mw2shell register_draw_heading 0x00038130
 * @fidelity exact
 */
export const registerDrawHeading = registerWidgetDraw('register_draw_heading', 0x00038130, (row) =>
  labelCreateUnder(shell.font28!, widgetField(row, 'x'), widgetField(row, 'y'), widgetValueString(row), null),
);

/**
 * A mission-list row (value = mission 0..15): the mission's title centred
 * in the row's width, in font32 - only for missions already completed
 * (value < currentPilot->missionIndex); otherwise no label.
 *
 * @mw2shell register_draw_mission_row 0x00038150
 * @fidelity exact
 */
export const registerDrawMissionRow = registerWidgetDraw('register_draw_mission_row', 0x00038150, (row) => {
  const value = widgetField(row, 'value');
  if (pilotField(currentPilot(), 'missionIndex') <= value) return null;
  // 0x77c85 '~%s'
  const text = `~${careerMission(registerCareer(), value).title}`;
  return labelCreateUnder(shell.font32!, widgetField(row, 'x') + ((widgetField(row, 'w') / 2) | 0), widgetField(row, 'y'), text, null);
});

/**
 * PILOT INFO's and the mission list's first row: currentPilot's name,
 * centred on x, in font27.
 *
 * @mw2shell register_draw_pilot_name 0x000381d0
 * @fidelity exact
 */
export const registerDrawPilotName = registerWidgetDraw('register_draw_pilot_name', 0x000381d0, (row) =>
  // 0x77c89 '~%s'
  labelCreateUnder(shell.font27!, widgetField(row, 'x'), widgetField(row, 'y'), `~${pilotName(currentPilot())}`, null),
);

/**
 * PILOT INFO: rankTitles[currentPilot->rank] in font27.
 *
 * @mw2shell register_draw_rank 0x00038210
 * @fidelity exact
 */
export const registerDrawRank = registerWidgetDraw('register_draw_rank', 0x00038210, (row) =>
  // 0x77c8d '~%s'
  labelCreateUnder(shell.font27!, widgetField(row, 'x'), widgetField(row, 'y'), `~${rankTitle(pilotField(currentPilot(), 'rank'))}`, null),
);

/**
 * PILOT INFO: currentPilot->careerHonor in font27.
 *
 * @mw2shell register_draw_honor 0x00038260
 * @fidelity exact
 */
export const registerDrawHonor = registerWidgetDraw('register_draw_honor', 0x00038260, (row) =>
  // 0x77c91 '~%d'
  labelCreateUnder(shell.font27!, widgetField(row, 'x'), widgetField(row, 'y'), `~${pilotField(currentPilot(), 'careerHonor') | 0}`, null),
);

/**
 * PILOT INFO: the title of the pilot's next mission,
 * careerMissionTables[registerCareer][missionIndex] ('Retired' at 16), in
 * font27.
 *
 * @mw2shell register_draw_mission 0x000382a0
 * @fidelity exact
 */
export const registerDrawMission = registerWidgetDraw('register_draw_mission', 0x000382a0, (row) =>
  // 0x77c95 '~%s'
  labelCreateUnder(shell.font27!, widgetField(row, 'x'), widgetField(row, 'y'), `~${careerMission(registerCareer(), pilotField(currentPilot(), 'missionIndex')).title}`, null),
);

/**
 * The mission-list rows' clickFn: a bare ret. screen_register tests the
 * rows itself (widget_panel_hit) for LAUNCH OLD MISSION.
 *
 * @mw2shell register_click_nothing 0x00038300
 * @fidelity exact
 */
export const registerClickNothing = registerWidgetClick('register_click_nothing', 0x00038300, function* () {});

/** The slot pointer the button (1..10) stands for: registerSlots[button - 1]. */
function slotOf(button: number): number {
  return mem().u32(SHELL_LABEL.registerSlots + (button - 1) * 4);
}

/** Replaces every in-use slot's name label: font27 at (42, 92 + 35 k), under the animations. */
function drawSlotNames(): void {
  let y = 0x5c;
  for (let k = 0; k < 10; k++, y += 0x23) {
    const slot = mem().u32(SHELL_LABEL.registerSlots + k * 4);
    if (pilotField(slot, 'inUse') === 0) continue;
    const old = register.nameLabels.get(slot);
    if (old) labelDestroy(old);
    register.nameLabels.set(slot, labelCreateUnder(shell.font27!, 0x2a, y, pilotName(slot), null));
  }
}

/** Clears every slot's selected flag. */
function clearSelected(): void {
  for (let k = 0; k < 10; k++) setPilotField(mem().u32(SHELL_LABEL.registerSlots + k * 4), 'selected', 0);
}

/** A double from the image (the honor formula's constants at 0x77cb7 / 0x77cbf). */
function imageDouble(addr: number): number {
  const b = mem().view(addr, 8);
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
}

/**
 * A new pilot's honor: `fild rand; fmul [0x77cb7] (1/32767); fmul [0x77cbf]
 * (1000); fadd 1000; trunc`. The FPU runs at 53-bit precision (core/int/
 * x87.ts), so doubles in this order are exact: rand() = 32767 gives 2000.
 * CORRECTION (2026-09-28): this was computed in a 64-bit significand, on
 * the assumption the FPU kept FNINIT's precision, and gave 1999 there.
 */
function newPilotHonor(r: number): number {
  const scale = imageDouble(0x77cbf);
  return x87TruncStore(r * imageDouble(0x77cb7) * scale + scale);
}

/**
 * (db, career, &pilotAccepted, &commandLine). The career's ten registry
 * records are slots 1..10 (0..9 Wolf, 10..19 Jade Falcon); the first
 * selected in-use one becomes currentPilot, other selected flags are
 * cleared. Buttons (registerScreenRows[career], 15): 0 NEW ALLEGIANCE ->
 * 8 with no pilot; 1..10 a slot - an empty one takes a name (text_input,
 * 14 characters in 300 px, upper-cased; Esc keeps what was typed) and, if
 * one was typed, becomes a new pilot
 * (in use, mission 0, rank 0, honor 1000 + rand() * 1000 / 32767, the
 * tallies zeroed) and is selected; an occupied one is selected, and a
 * double click on it accepts at once (-> 1); 11 ACCEPT -> 1 with the
 * pilot accepted; 12 DELETE MECHWARRIOR asks 'Terminate MechWarrior?' and
 * frees the slot; 13 LAUNCH OLD MISSION swaps PILOT INFO for the mission
 * list, where a completed mission's row loads it (its BRF2 stars, the
 * pilot as member 0) and returns 10 - a replay; 14 PILOT INFO swaps back.
 * Leaving saves the registry.
 *
 * @mw2shell screen_register 0x00038310
 * @fidelity partial
 * @divergence the slots' name labels are kept beside the records, so MW2REG.CFG carries 0 at +0x38 where the original saved a heap pointer (cleared again by every load)
 */
export function* screenRegister(db: MPackDb, career: number, accepted: { value: number }, commandLine: { value: string }): Blocking<number> {
  const m = mem();
  const d = driver();
  const ms = mouse();
  let missionList = 0;
  m.setI32(SHELL_LABEL.registerCareer, career);
  srand(clock());
  screenLoadBackground(d, db, screenRowBackground(SHELL_LABEL.registerScreenRows, career));
  careerRegistryLoad();
  setCurrentPilot(0);
  const first = career === 1 ? 10 : 0;
  for (let k = 0; k < 10; k++) {
    const rec = pilotRecord(first + k);
    m.setI32(SHELL_LABEL.registerSlots + k * 4, rec);
    if (currentPilot() === 0 && pilotField(rec, 'selected') !== 0) {
      if (pilotField(rec, 'inUse') === 1) {
        setCurrentPilot(rec);
        continue;
      }
    } else if (currentPilot() === 0) continue;
    setPilotField(rec, 'selected', 0);
  }
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, screenRowButtons(SHELL_LABEL.registerScreenRows, career, 0xf), 0xf);
  m.setI32(SHELL_LABEL.registerNextState, -1);
  accepted.value = 0;
  drawSlotNames();
  if (currentPilot() === 0) {
    buttonDisable(bar, 0xb);
    buttonDisable(bar, 0xc);
    buttonDisable(bar, 0xd);
    buttonDisable(bar, 0xe);
  } else {
    widgetPanelLayout(PILOT_INFO);
    buttonDisable(bar, 0xe);
    if (pilotField(currentPilot(), 'missionIndex') === 0) buttonDisable(bar, 0xd);
  }
  animUpdateAll();
  yield* mouseUpdate(ms);
  const wav = mpackDbGetItem(db, 0x51);
  const sample = soundSampleCreate(new Sample(), shell.soundSystem!, wav, wav?.length ?? 0);
  soundSampleSetVolume(sample, 0x1e);
  soundSamplePlay(sample);
  const next = () => m.i32(SHELL_LABEL.registerNextState);
  const setNext = (v: number) => m.setI32(SHELL_LABEL.registerNextState, v);
  for (;;) {
    animUpdateAll();
    yield* mouseUpdate(ms);
    let hit = buttonBarHit(bar, ms.x, ms.y);
    if (mouseLeftClicked(ms) === 1) {
      if (missionList !== 0) {
        const row = widgetPanelHit(MISSION_LIST, ms.x, ms.y);
        if (row !== 0 && widgetField(row, 'clickFn') !== 0) {
          const mission = widgetField(row, 'value');
          if (mission < pilotField(currentPilot(), 'missionIndex')) {
            commandLine.value = careerMission(career, mission).scenario ?? '';
            starConfigure(0, 0, 3, 1, 100);
            void (missionBrf2Load(commandLine.value, true, false) satisfies Brf2Planet | null);
            starConfigure(1, 0, 0, 0, 100);
            starConfigure(0, -1, -1, -1, -1);
            starSetMember(0, null, pilotName(currentPilot()));
            setNext(10);
          }
        }
      }
      // the dispatch; a text entry ended by a click that is still held dispatches that click's button too
      for (let redo = true; redo; ) {
        redo = false;
        if (hit === 0) {
          setCurrentPilot(0);
          setNext(8);
        } else if (hit >= 1 && hit <= 10) {
          const slot = slotOf(hit);
          if (pilotField(slot, 'inUse') === 0) {
            buttonDisable(bar, 0xb);
            buttonDisable(bar, 0xc);
            buttonDisable(bar, 0xd);
            buttonDisable(bar, 0xe);
            missionList = 0;
            widgetPanelFreeLabels(MISSION_LIST);
            widgetPanelFreeLabels(PILOT_INFO);
            setCurrentPilot(0);
            m.setU8(slot + PILOT.pilotName, 0);
            const typed = yield* textInput(shell.font27!, 0x2a, (hit - 1) * 0x23 + 0x5c, m.cstr(slot + PILOT.pilotName, 16), null, 0xe, 0x12c);
            m.strcpy(slot + PILOT.pilotName, typed.text);
            strupr(slot + PILOT.pilotName);
            if (m.u8(slot + PILOT.pilotName) !== 0) {
              setPilotField(slot, 'inUse', 1);
              setPilotField(slot, 'missionIndex', 0);
              setCurrentPilot(slot);
              setPilotField(slot, 'rank', 0);
              const r = rand();
              setPilotField(slot, 'killTally', 0);
              setPilotField(slot, 'enemyMechHits', 0);
              setPilotField(slot, 'shotsFired', 0);
              setPilotField(slot, 'field24', 0);
              setPilotField(slot, 'careerHonor', newPilotHonor(r));
              clearSelected();
              setPilotField(slot, 'selected', 1);
              drawSlotNames();
              buttonEnable(bar, 0xb);
              buttonEnable(bar, 0xc);
              widgetPanelLayout(PILOT_INFO);
            }
            if (ms.leftDown === 1) {
              hit = buttonBarHit(bar, ms.x, ms.y);
              redo = true;
            }
          } else {
            setCurrentPilot(slot);
            clearSelected();
            setPilotField(slot, 'selected', 1);
            if (mouseDoubleClicked(ms) === 0) {
              buttonEnable(bar, 0xb);
              buttonEnable(bar, 0xc);
              if (pilotField(currentPilot(), 'missionIndex') === 0) buttonDisable(bar, 0xd);
              else buttonEnable(bar, 0xd);
              buttonDisable(bar, 0xe);
              widgetPanelFreeLabels(MISSION_LIST);
              widgetPanelFreeLabels(PILOT_INFO);
              missionList = 0;
              widgetPanelLayout(PILOT_INFO);
            } else {
              setNext(1);
              accepted.value = 1;
            }
          }
        } else if (hit === 0xb) {
          if (currentPilot() !== 0) {
            setNext(1);
            accepted.value = 1;
          }
        } else if (hit === 0xc) {
          // 0x77c99 'Terminate MechWarrior?#Yes|No'
          if (currentPilot() === 0 || (yield* messageBox('Terminate MechWarrior?#Yes|No', 1)) !== 1) {
            const pilot = currentPilot();
            if (pilot === 0) quirk('DELETE MECHWARRIOR with no pilot writes through a NULL currentPilot (the button is disabled then)', 'screen_register');
            else {
              setPilotField(pilot, 'inUse', 0);
              // strcpy from 0x77c84 ''
              m.strcpy(pilot + PILOT.pilotName, '');
              const label = register.nameLabels.get(pilot);
              if (label) {
                labelDestroy(label);
                register.nameLabels.delete(pilot);
              }
            }
            widgetPanelFreeLabels(PILOT_INFO);
            widgetPanelFreeLabels(MISSION_LIST);
            setCurrentPilot(0);
            buttonDisable(bar, 0xb);
            buttonDisable(bar, 0xc);
            buttonDisable(bar, 0xd);
            missionList = 0;
            buttonDisable(bar, 0xe);
          }
        } else if (hit === 0xd) {
          buttonDisable(bar, 0xd);
          buttonEnable(bar, 0xe);
          widgetPanelFreeLabels(PILOT_INFO);
          missionList = 1;
          widgetPanelLayout(MISSION_LIST);
        } else if (hit === 0xe) {
          if (pilotField(currentPilot(), 'missionIndex') !== 0) buttonEnable(bar, 0xd);
          buttonDisable(bar, 0xe);
          widgetPanelFreeLabels(MISSION_LIST);
          missionList = 0;
          widgetPanelLayout(PILOT_INFO);
        }
      }
    }
    if (next() === -1) setNext(yield* shellMenu());
    if (next() !== -1) {
      widgetPanelFreeLabels(MISSION_LIST);
      widgetPanelFreeLabels(PILOT_INFO);
      careerRegistrySave();
      buttonBarDestroy(bar);
      soundSampleDestroy(sample);
      for (let k = 0; k < 10; k++) {
        const slot = m.u32(SHELL_LABEL.registerSlots + k * 4);
        const label = register.nameLabels.get(slot);
        if (label) {
          labelDestroy(label);
          register.nameLabels.delete(slot);
        }
      }
      return next();
    }
  }
}

shellScreens.register(0xc, (l) => screenRegister(l.db, l.career.value, l.accepted, l.commandLine));
