/**
 * State 3, the debriefing (decompiled/mw2shell/src/handoff/mission_result.c):
 * where a mission's outcome reaches the career. It reads what MW2.EXE left
 * on the disk - MW2MSN.CFG (a MissionRecord) and MW2CAR.CFG (MissionTallies)
 * - lists the objectives, scores the mission's honor, promotes and advances
 * the pilot, saves MW2REG.CFG, and shows it all as the \Q text of the
 * mission's DBFS (won) or DBFF stream. README "MW2MSN.CFG and MW2CAR.CFG",
 * "Honor: how the debriefing scores a mission", "MW2DIF.CFG".
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import type { MPackDb } from '../../data/formats/mpack.ts';
import { dosFileLoad } from '../../engine/dosFiles.ts';
import { watcomQsort } from '../../engine/qsort.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { database, driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animUpdateAll } from '../anim/anims.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonDefsAt, buttonDisable } from '../ui/buttonBar.ts';
import { inputFlush } from '../ui/keys.ts';
import { labelsClear, textWidth } from '../ui/labels.ts';
import { mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { messageBox } from '../ui/messageBox.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { Page, pageDestroy, pageHide, pageInit, pageRestart, pageTypeStep } from '../text/page.ts';
import { ArchiveViewer, archivePageLoad, archiveViewerDestroy, archiveViewerFrame } from '../archive/viewer.ts';
import { ordersTextBuild } from '../career/orders.ts';
import { careerRegistryLoad, careerRegistrySave } from '../career/registry.ts';
import { careerMission, currentPilot, pilotField, pilotName, setPilotField } from '../career/missions.ts';
import { starRecord } from '../handoff/stars.ts';
import { collectionGet, collectionRemove, struprString } from '../util/collection.ts';
import { screenRowBackground, screenRowButtonCount, screenRowButtonsAddr } from './screenRows.ts';
import { shellScreens } from './registry.ts';

/** The MissionRecord (0x9d4) and, straight after it on the stack, the MissionTallies (0x50): screen_debriefing's frame at esp and esp + 0x9d4. */
const MSN_SIZE = structSize('MissionRecord');
const CAR_SIZE = structSize('MissionTallies');
const OBJ_SIZE = structSize('MissionObjectiveRecord');
const MSN = {
  objectiveCount: fieldOffset('MissionRecord', 'objectiveCount'),
  result: fieldOffset('MissionRecord', 'result'),
  objectives: fieldOffset('MissionRecord', 'objectives'),
};
const OBJ = {
  succeeded: fieldOffset('MissionObjectiveRecord', 'succeeded'),
  category: fieldOffset('MissionObjectiveRecord', 'category'),
  changedAt: fieldOffset('MissionObjectiveRecord', 'changedAt'),
  text: fieldOffset('MissionObjectiveRecord', 'text'),
};
const CAR = {
  playerKillsEnemyMech: fieldOffset('MissionTallies', 'playerKillsEnemyMech'),
  shotsFired: fieldOffset('MissionTallies', 'shotsFired'),
  enemyMechHits: fieldOffset('MissionTallies', 'enemyMechHits'),
  enemyMechsDestroyed: fieldOffset('MissionTallies', 'enemyMechsDestroyed'),
  wingmenDestroyed: fieldOffset('MissionTallies', 'wingmenDestroyed'),
  playerKillsEnemyOther: fieldOffset('MissionTallies', 'playerKillsEnemyOther'),
  enemyOthersDestroyed: fieldOffset('MissionTallies', 'enemyOthersDestroyed'),
};
const PILOT_SIZE = structSize('PilotRecord');
/** simOptions (0x7d40c): the MW2DIF.CFG bytes sim_options_read loaded. */
const OPT = {
  unlimitedAmmo: fieldOffset('SimOptions', 'unlimitedAmmo'),
  invulnerability: fieldOffset('SimOptions', 'invulnerability'),
  collisionDamage: fieldOffset('SimOptions', 'collisionDamage'),
  heatTracking: fieldOffset('SimOptions', 'heatTracking'),
  difficulty: fieldOffset('SimOptions', 'difficulty'),
};

/** A byte of simOptions. */
function option(f: keyof typeof OPT): number {
  return mem().u8(SHELL_LABEL.simOptions + OPT[f]);
}

/** The test the debriefing makes three times, inline: unlimited ammo or invulnerability on, or collision damage off. */
function alteredReality(): boolean {
  if (option('unlimitedAmmo') === 1) return true;
  if (option('invulnerability') === 1) return true;
  return option('collisionDamage') === 0;
}

/** A double of the image (the constants at 0x75b25 / 0x75b2d). */
function imageDouble(addr: number): number {
  const b = mem().view(addr, 8);
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
}

/** A decimal string ("123.4500", "1.25e-7" or "1.25e+2") rounded to `places` decimals, ties to even. */
function roundDecimal(s: string, places: number): string {
  let digits: string;
  let intLen: number;
  const e = s.indexOf('e');
  if (e >= 0) {
    const mant = s.slice(0, e);
    const dot = mant.indexOf('.');
    digits = mant.replace('.', '');
    intLen = (dot < 0 ? mant.length : dot) + Number(s.slice(e + 1));
  } else {
    const dot = s.indexOf('.');
    digits = s.replace('.', '');
    intLen = dot < 0 ? s.length : dot;
  }
  if (intLen < 0) {
    digits = '0'.repeat(-intLen) + digits;
    intLen = 0;
  }
  while (digits.length < intLen + places + 1) digits += '0';
  const kept = digits.slice(0, intLen + places);
  const next = digits.charCodeAt(intLen + places) - 0x30;
  const rest = digits.slice(intLen + places + 1);
  let n = BigInt(kept === '' ? '0' : kept);
  if (next > 5 || (next === 5 && (/[1-9]/.test(rest) || (n & 1n) === 1n))) n += 1n;
  const t = n.toString().padStart(places + 1, '0');
  return places === 0 ? t : `${t.slice(0, t.length - places)}.${t.slice(t.length - places)}`;
}

/**
 * Watcom's printf %.1f of a double v >= 0, as the debriefing prints the hit
 * percentage and the difficulty multiplier. Its conversion was run under
 * an x86 emulator (180,900 values h / s * 100, s <= 600): with the FPU at
 * reduced precision it matches rounding v to 15 significant digits and then
 * to one decimal, ties to even (6.25 -> 6.2, 18.75 -> 18.8); at the x87's
 * full 64 bits it matches rounding v's exact value, ties to even. The two
 * differ only where v lies within ~1e-14 of a .x5 (26 of those values,
 * 23/80 -> 28.749999999999996: 28.8 or 28.7). The shell runs its FPU at
 * 53 bits (the start-up routine at 0x59f93 loads the control word 0x127f
 * from 0x87478), which the emulator does not reproduce, so where the two
 * differ the result is not established.
 *
 * @portOnly Watcom's printf %f conversion (clib, not ported), for one decimal
 */
function watcomFixed1(v: number): string {
  const reduced = roundDecimal(v.toPrecision(15), 1);
  const exact = roundDecimal(v.toFixed(60), 1);
  if (reduced !== exact) unestablished(`printf %.1f of ${v}: ${reduced} or ${exact}, by the FPU's precision`, 'screen_debriefing');
  return reduced;
}

/** sprintf's %03d. */
function pad03(n: number): string {
  return n < 0 ? '-' + String(-n).padStart(2, '0') : String(n).padStart(3, '0');
}

/** sprintf's %02d. */
function pad02(n: number): string {
  return n < 0 ? String(n) : String(n).padStart(2, '0');
}

/**
 * The comparator qsort is given over the objective pointers: by changedAt
 * (+0xc), ascending; an objective with a negative time ('DNF') goes after
 * any other - the first one's is tested first, so two negative times give 1.
 *
 * @mw2shell debriefing_objective_compare 0x00021e90
 * @fidelity exact
 */
export function debriefingObjectiveCompare(a: number, b: number, frame: DataView): number {
  const ta = frame.getInt32(a + OBJ.changedAt, true);
  const tb = frame.getInt32(b + OBJ.changedAt, true);
  if (ta < 0) return 1;
  if (tb < 0) return -1;
  if (ta > tb) return 1;
  if (ta < tb) return -1;
  return 0;
}

/**
 * (db, career, &commandLine). Its career's background; the pages' box as
 * the briefing's (Wolf 88, 30, 454 x 400; Jade Falcon 98, 51, 403 x 372;
 * else 88, 30, 454 x 408). The registry is reloaded and MW2CAR.CFG (0x50)
 * and MW2MSN.CFG (0x9d4) are read onto the stack. Then, and again from
 * here each time the NOHERCSALLOWED keys re-score it: the keyboard drained,
 * debriefingScreenRows[career]'s buttons (EXIT, AFTERMATH, REPLAY), outside
 * career 2 a copy of the pilot record, and debriefingText built:
 * - the objectives sorted with qsort (debriefing_objective_compare) under
 *   "Time / Type / Objective / Status": mm:ss of changedAt ('DNF' when
 *   negative); Default / Primary / Secondary / Tertiary / Return Objective
 *   by category 0 / 1 / 2 / 4 / 8, else Unknown; the text with each run of
 *   control characters and spaces made one space; Failed / Successful /
 *   Unknown by succeeded 0 / 1 / other;
 * - the honor lines, each's number right-aligned at x 350: Mission
 *   Completion 5000 (0 if a primary failed), 1500 per secondary and 500 per
 *   tertiary succeeded, -4000 per wingman destroyed (after a win), 250 per
 *   enemy mech and 125 per other enemy destroyed by anyone (the player's
 *   own shown beside them as direct), 25 per ton the star is under
 *   maxMechs * maxTonnage, 750 for hits / shots of 0.7 or more (the line
 *   only when the ratio is at most 1). The pilot's killTally gains the enemy
 *   mechs destroyed by anyone and the player's own non-mech kills, and
 *   enemyMechHits and shotsFired the mission's;
 * - with heat tracking off, 'The Keshik deems it Dishonorable...' and no
 *   honor; else after a win the sum as Mission Honor and, times the
 *   difficulty's multiplier (EASY 0.8, MEDIUM 1.0, HARD 1.3), the total;
 *   'No Career Advancement with Altered Reality Enabled' and no honor with
 *   unlimited ammo or invulnerability on or collision damage off; 'Mission
 *   Failed: NO HONOR ACQUIRED' and no honor on a result of 3. A win adds it
 *   to careerHonor, which ends the text.
 * Outside career 2 the rank then gains, on a won Trial of the pilot's
 * career with none of those options and heat tracking on, the primary
 * objectives succeeded (capped at 8); a win without them advances
 * missionIndex; the registry is saved; and the text is laid out as the \Q
 * of the stream <scenario's first four letters>DBFS after a win (KTWODBFS /
 * KTJFDBFS once the pilot is Khan) or ...DBFF. The first page is shown
 * (an empty one if there is none) and typed out; AFTERMATH is disabled
 * with no second page or without a win.
 *
 * Each pass: Alt+W (0x8011) / Alt+L (0x8026), for a pilot named
 * NOHERCSALLOWED outside career 2, put the saved record back and re-score
 * as a win / a loss; mouse_update, a character typed, the bar polled -
 * EXIT 0xb (after a win outside career 2, with commandLine set to the next
 * mission's scenario - or 0x10, the ending, at mission 16), AFTERMATH (the
 * other pages in the viewer, as the briefing's SITUATION), REPLAY 0 (the
 * briefing again; after a win only on 'Are you Sure?', which puts the saved
 * record back and saves the registry) - and shell_menu when nothing
 * decided.
 *
 * @mw2shell screen_debriefing 0x00023890
 * @fidelity exact
 * @divergence the per-line scratch buffers (0x8e290 ... 0x8f190) and the sorted pointers (debriefingObjectives) are JS values; debriefingText is written to its address once complete
 */
export function* screenDebriefing(db: MPackDb, career: number, commandLine: { value: string }): Blocking<number> {
  const m = mem();
  const d = driver();
  const ms = mouse();
  let next = -1;
  const rows = SHELL_LABEL.debriefingScreenRows;
  screenLoadBackground(d, db, screenRowBackground(rows, career));
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
  careerRegistryLoad();
  // the stack: MissionRecord at esp, MissionTallies at esp + 0x9d4
  const frame = new Uint8Array(MSN_SIZE + CAR_SIZE);
  const fv = new DataView(frame.buffer);
  let unread = false;
  // 0x75ae6 'MW2CAR.CFG', 0x75ac4 'MW2MSN.CFG' (both 'rb'); fread(buf, size, 1)
  const car = dosFileLoad('MW2CAR.CFG');
  if (car) frame.set(car.subarray(0, CAR_SIZE), MSN_SIZE);
  const msn = dosFileLoad('MW2MSN.CFG');
  if (msn) frame.set(msn.subarray(0, MSN_SIZE), 0);
  if (!car || car.length < CAR_SIZE || !msn || msn.length < MSN_SIZE) unread = true;
  if (unread) unestablished('screen_debriefing: MW2MSN.CFG or MW2CAR.CFG missing or short - the original scores the stack as it lay (the port: zeroes)', 'screen_debriefing');
  const i32 = (o: number) => fv.getInt32(o, true);
  const u16 = (o: number) => fv.getUint16(MSN_SIZE + o, true);
  const result = () => i32(MSN.result);
  const count = () => i32(MSN.objectiveCount);
  const buttons = () => buttonDefsAt(screenRowButtonsAddr(rows, career), screenRowButtonCount(rows, career));
  let saved: Uint8Array | null = null;
  /** The pilot record as it was before this scoring: rep movsd of 0x3c bytes back over currentPilot. */
  const restorePilot = () => {
    const p = currentPilot();
    if (saved === null || p === 0) {
      unestablished('screen_debriefing: restoring the pilot record with no copy taken (career 2) or no current pilot - the original copies its stack over it', 'screen_debriefing');
      return;
    }
    m.view(p, PILOT_SIZE).set(saved);
  };
  /** An int field of currentPilot, and += on it; the original goes through NULL with no pilot. */
  const pilotGet = (f: 'rank' | 'missionIndex' | 'careerHonor' | 'career'): number => {
    const p = currentPilot();
    if (p === 0) {
      unestablished(`screen_debriefing: currentPilot->${f} with no current pilot`, 'screen_debriefing');
      return 0;
    }
    return pilotField(p, f);
  };
  const pilotAdd = (f: 'rank' | 'missionIndex' | 'careerHonor' | 'killTally' | 'enemyMechHits' | 'shotsFired', v: number) => {
    const p = currentPilot();
    if (p === 0) {
      unestablished(`screen_debriefing: currentPilot->${f} += with no current pilot`, 'screen_debriefing');
      return;
    }
    setPilotField(p, f, (pilotField(p, f) + v) | 0);
  };

  rescore: for (;;) {
    // LAB_00023a09
    const pages: Page[] = [];
    inputFlush(shell.keyInput!);
    let bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, buttons(), screenRowButtonCount(rows, career));
    if (career !== 2) {
      const p = currentPilot();
      if (p === 0) unestablished('screen_debriefing: no current pilot to copy (the original copies from NULL)', 'screen_debriefing');
      else saved = m.view(p, PILOT_SIZE).slice();
    }
    // 0x759bc '': debriefingText emptied
    let text = '';
    const remap = m.view(SHELL_LABEL.debriefingRemap, 0x100);
    remap[0] = 0xff;
    for (let i = 1; i < 0x100; i++) remap[i] = i;

    // the objectives, sorted
    const n = count();
    if (n > 48) unestablished(`screen_debriefing: ${n} objectives - the pointer table holds 48 and the record 48`, 'screen_debriefing');
    const objectives: number[] = [];
    for (let i = 0; i < n; i++) objectives.push(MSN.objectives + i * OBJ_SIZE);
    watcomQsort(objectives, (a, b) => debriefingObjectiveCompare(a, b, fv), true, objectives.length);
    // 0x759bd
    text += 'Time\\g050Type\\g170Objective\\g370Status\\n\\n';
    for (const o of objectives) {
      let type: string;
      switch (fv.getUint32(o + OBJ.category, true)) {
        case 0:
          type = 'Default Objective'; // 0x759e8
          break;
        case 1:
          type = 'Primary Objective'; // 0x759fa
          break;
        case 2:
          type = 'Secondary Objective'; // 0x75a0c
          break;
        case 4:
          type = 'Tertiary Objective'; // 0x75a20
          break;
        case 8:
          type = 'Return Objective'; // 0x75a33
          break;
        default:
          type = 'Unknown'; // 0x75a44
      }
      const ok = fv.getUint32(o + OBJ.succeeded, true);
      // 0x75a57 'Failed', 0x75a4c 'Successful', 0x75a5e 'Unknown'
      const status = ok === 0 ? 'Failed' : ok === 1 ? 'Successful' : 'Unknown';
      // the text: each run of bytes <= ' ' becomes one space
      let words = '';
      let blank = false;
      let k = o + OBJ.text;
      for (; k < frame.length && frame[k] !== 0; k++) {
        const c = frame[k]!;
        if (c < 0x21) {
          if (!blank) {
            blank = true;
            words += ' ';
          }
        } else {
          blank = false;
          words += String.fromCharCode(c);
        }
      }
      if (k >= frame.length) unestablished('screen_debriefing: an objective text runs off the end of MW2CAR.CFG on the stack', 'screen_debriefing');
      const t = i32(o + OBJ.changedAt);
      // 0x75a66 'DNF', 0x75a6a '%02d:%02d'
      const time = t < 0 ? 'DNF' : `${pad02(((t / 60) | 0) % 60)}:${pad02(t % 60)}`;
      // 0x75a74 '%s\g050%s\g170%s\g370%s\n'
      text += `${time}\\g050${type}\\g170${words}\\g370${status}\\n`;
    }

    // the honor lines: '%d' of the value, its width in pageFont, then the line with the number right-aligned at 350
    const font = shell.pageFont!;
    const at350 = (value: number) => {
      const s = String(value | 0);
      return `\\g${pad03(0x15e)}\\b${pad03(textWidth(font, s))}${s}`;
    };
    let honor = 0;
    let completion = 5000;
    for (let i = 0; i < n; i++) {
      const o = MSN.objectives + i * OBJ_SIZE;
      if (i32(o + OBJ.category) === 1 && i32(o + OBJ.succeeded) === 0) completion = 0;
    }
    // 0x756cf
    text += `\\nMission Completion:${at350(completion)}\\n`;
    honor += completion;
    let secondary = 0;
    let tertiary = 0;
    for (let i = 0; i < n; i++) {
      const o = MSN.objectives + i * OBJ_SIZE;
      const c = fv.getUint32(o + OBJ.category, true);
      if (c === 2 && i32(o + OBJ.succeeded) === 1) secondary++;
      else if (c === 4 && i32(o + OBJ.succeeded) === 1) tertiary++;
    }
    if (secondary > 0) {
      honor += secondary * 1500;
      // 0x756f8
      text += `Secondary Objective Completed:\\t\\t1500\\t(x${secondary})${at350(secondary * 1500)}\\n`;
    }
    if (tertiary > 0) {
      honor += tertiary * 500;
      // 0x75737
      text += `Tertiary Objective Completed:\\t\\t500\\t(x${tertiary})${at350(tertiary * 500)}\\n`;
    }
    const wingmen = u16(CAR.wingmenDestroyed);
    if (wingmen > 0 && result() === 2) {
      const v = Math.imul(wingmen, -4000);
      honor += v;
      // 0x75775
      text += `Wingman Deaths:\\t\\t\\t\\t-4000\\t(x${wingmen})${at350(v)}\\n`;
    }
    // 0x757a6
    text += '\\t\\t\\t\\t\\t\\tdirect\\ttotal\\n';
    const mechs = u16(CAR.enemyMechsDestroyed);
    pilotAdd('killTally', mechs);
    honor += mechs * 250;
    // 0x757c5
    text += `Enemy Mechs Destroyed:\\t\\t\\t${u16(CAR.playerKillsEnemyMech)}\\t${mechs}${at350(mechs * 250)}\\n`;
    const others = u16(CAR.enemyOthersDestroyed);
    pilotAdd('killTally', u16(CAR.playerKillsEnemyOther));
    honor += others * 125;
    // 0x757fb, 'Destoyed' as the image has it
    text += `Enemy Vehicles Destoyed:\\t\\t\\t${u16(CAR.playerKillsEnemyOther)}\\t${others}${at350(others * 125)}\\n`;
    // star_record(0): the player's star, maxTonnage * maxMechs less each member's chassis tonnage
    const star = starRecord(0);
    let spare = Math.imul(m.i32(star + fieldOffset('StarRecord', 'maxTonnage')), m.i32(star + fieldOffset('StarRecord', 'maxMechs')));
    const members = m.i32(star + fieldOffset('StarRecord', 'memberCount'));
    for (let i = 0; i < members; i++) {
      const chassis = m.i32(star + fieldOffset('StarRecord', 'members') + i * structSize('StarMember'));
      if (chassis < 0) quirk('screen_debriefing: a member with no chassis reads chassisTable[-1]', 'screen_debriefing');
      spare = (spare - m.i32(SHELL_LABEL.chassisTable + chassis * structSize('ChassisEntry') + fieldOffset('ChassisEntry', 'tonnage'))) | 0;
    }
    if (spare > 0) {
      honor += spare * 25;
      // 0x75833
      text += `Star Underweight Bonus:\\t\\t\\t25\\t(x${spare} tons)${at350(spare * 25)}\\n`;
    }
    // fild / fild / fdivp, stored as a double; compared with 0.7 (0x75b2d)
    const shots = u16(CAR.shotsFired);
    const ratio = shots === 0 ? 0 : u16(CAR.enemyMechHits) / shots;
    const accuracy = ratio < imageDouble(0x75b2d) ? 0 : 750;
    if (ratio <= 1) {
      // 0x75872, ratio * 100 (0x75b25)
      text += `Hit Percentage:\\t\\t\\t\\t${watcomFixed1(ratio * imageDouble(0x75b25)).padStart(3, ' ')}${at350(accuracy)}\\n`;
      honor += accuracy;
    }
    pilotAdd('enemyMechHits', u16(CAR.enemyMechHits));
    pilotAdd('shotsFired', shots);
    // the difficulty's name (0x7589f EASY, 0x758a4 MEDIUM, 0x758ab HARD) and multiplier (0.8, 1.0, 1.3 as stored doubles)
    const difficulty = option('difficulty');
    let level = '';
    let multiplier = Number.NaN;
    if (difficulty === 0) {
      level = 'EASY';
      multiplier = new DataView(new Uint32Array([0x9999999a, 0x3fe99999]).buffer).getFloat64(0, true);
    } else if (difficulty < 2) {
      level = 'MEDIUM';
      multiplier = new DataView(new Uint32Array([0, 0x3ff00000]).buffer).getFloat64(0, true);
    } else if (difficulty === 2) {
      level = 'HARD';
      multiplier = new DataView(new Uint32Array([0xcccccccd, 0x3ff4cccc]).buffer).getFloat64(0, true);
    }
    if (option('heatTracking') === 0) {
      // 0x758b0
      text += '\\n\\cThe Keshik deems it Dishonorable to Alter Heat Tracking\\n';
      honor = 0;
    } else if (result() === 2) {
      // 0x758f1
      text += `\\nMission Honor:${at350(honor)}\\n`;
      if (Number.isNaN(multiplier)) {
        unestablished(`screen_debriefing: difficulty ${difficulty} - the multiplier and its name are left as the stack and 0x8e690 held them`, 'screen_debriefing');
        multiplier = 1;
      }
      // fild honor; fld mult; fmul st(1); fsubrp; clib_fp_trunc; fistp - at the 53-bit precision the
      // shell's start-up sets (control word 0x127f), so each step rounds as a double does
      honor = (honor + Math.trunc(honor * multiplier - honor)) | 0;
      // 0x75915
      text += `Difficulty Multiplier:\\t(${level} = ${watcomFixed1(multiplier)})${at350(honor)}\\n`;
    }
    if (alteredReality()) {
      // 0x7594a
      text += '\\n\\cNo Career Advancement with Altered Reality Enabled\\n';
      honor = 0;
    }
    if (result() === 3) {
      // 0x75983
      text += '\\n\\cMission Failed:  NO HONOR ACQUIRED\\n';
      honor = 0;
    }
    if (result() === 2) pilotAdd('careerHonor', honor);
    // 0x75a91
    text += `\\nCareer Honor:${at350(pilotGet('careerHonor'))}\\n`;
    m.strcpy(SHELL_LABEL.debriefingText, text);

    if (career !== 2) {
      // promotion: a won Trial of the pilot's career, with the options clean and heat tracking on
      let promotion = 0;
      const pilotCareer = pilotGet('career');
      if (pilotCareer !== 2 && careerMission(pilotCareer, pilotGet('missionIndex')).isTrial === 1 && !alteredReality() && result() === 2 && option('heatTracking') === 1) {
        for (let i = 0; i < n; i++) {
          const o = MSN.objectives + i * OBJ_SIZE;
          if (i32(o + OBJ.category) === 1 && i32(o + OBJ.succeeded) === 1) promotion++;
        }
      }
      pilotAdd('rank', promotion);
      if (pilotGet('rank') > 7) pilotAdd('rank', 8 - pilotGet('rank'));
      if (result() === 2 && !alteredReality()) pilotAdd('missionIndex', 1);
      careerRegistrySave();
      // the stream: the scenario's first four letters (to a '.'), '_'-padded
      let stream = '';
      let i = 0;
      for (; i < 4; i++) {
        const c = i < commandLine.value.length ? commandLine.value.charCodeAt(i) : 0;
        if (c === 0 || c === 0x2e) break;
        stream += commandLine.value[i];
      }
      for (; i < 4; i++) stream += '_';
      if (result() === 2) {
        // 0x75acf 'KTWO', 0x75ad4 'KTJF': the Khan's debriefing
        if (pilotGet('rank') >= 8) {
          if (career === 0) stream = 'KTWO';
          else if (career === 1) stream = 'KTJF';
        }
        stream += 'DBFS'; // 0x75ad9
      } else stream += 'DBFF'; // 0x75ade
      ordersTextBuild(pages, x, y, width, height, struprString(stream), font, m.cstr(SHELL_LABEL.debriefingText));
    }
    let page = collectionGet(pages, 0);
    if (page === null) page = pageInit(new Page(), font, d, null, 0, 0, 100, 100);
    else collectionRemove(pages, page, 0);
    if (pages.length === 0 || result() !== 2) buttonDisable(bar, 1);
    pageRestart(page);

    for (;;) {
      // LAB_00024d08: the NOHERCSALLOWED keys
      const key = shell.keyInput!.key;
      if (key === 0x8011 || key === 0x8026) {
        shell.keyInput!.key = 0;
        // 0x75af1 / 0x75b00 'NOHERCSALLOWED'
        if (career !== 2 && currentPilot() !== 0 && pilotName(currentPilot()) === 'NOHERCSALLOWED') {
          restorePilot();
          fv.setInt32(MSN.result, key === 0x8011 ? 2 : 3, true);
          pageDestroy(page);
          buttonBarDestroy(bar);
          labelsClear(d, 1);
          continue rescore;
        }
      }
      yield* mouseUpdate(ms);
      pageTypeStep(page);
      switch (buttonBarHit(bar, ms.x, ms.y)) {
        case 0:
          if (mouseLeftClicked(ms) === 1) {
            next = 0xb;
            if (career !== 2 && result() === 2) {
              const mission = pilotGet('missionIndex');
              if (mission < 0x10) commandLine.value = careerMission(career, mission).scenario ?? '';
              else next = 0x10;
            }
          }
          break;
        case 1:
          if (mouseLeftClicked(ms) === 1) {
            pageHide(page);
            buttonBarDestroy(bar);
            const aftermath = SHELL_LABEL.debriefingAftermathRows;
            // 0x75b0f '': the viewer opens no archive
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
              screenRowButtonsAddr(aftermath, career),
              screenRowButtonCount(aftermath, career),
            );
            let r: number;
            do {
              r = yield* archiveViewerFrame(v);
              if (r === -3) next = -3;
              if (r === 8) next = 8;
            } while (r === 5);
            archiveViewerDestroy(v);
            pageRestart(page);
            bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, buttons(), screenRowButtonCount(rows, career));
            if (next === -2) next = -1;
          }
          break;
        case 2:
          if (mouseLeftClicked(ms) === 1) {
            if (result() === 2) {
              // 0x75b10
              if ((yield* messageBox('Are you Sure?#Yes|No', 1)) === 0) {
                next = 0;
                restorePilot();
                careerRegistrySave();
              } else animUpdateAll();
            } else next = 0;
          }
          break;
      }
      if (next === -1) next = yield* shellMenu();
      if (next !== -1) {
        pageDestroy(page);
        buttonBarDestroy(bar);
        labelsClear(d, 1);
        return next;
      }
    }
  }
}

shellScreens.register(3, (l) => screenDebriefing(l.db, l.career.value, l.commandLine));
