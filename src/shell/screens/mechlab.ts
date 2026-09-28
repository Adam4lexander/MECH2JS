/**
 * State 9, the mech lab (decompiled/mw2shell/src/mechlab/mechlab.c): a
 * chassis and one of its variants, browsed with NEXT / PREV CHASSIS and
 * VARIANT, shown read-only (mechlabDesignPanel) or edited under CUSTOMIZE
 * (mechlabCustomizingPanel and the component panels, shell/mechlab/
 * panels.ts) and saved as mek\<prefix>NNusr.mek. README "'Mech variants:
 * stock and user .mek files" and "Design rules the mech lab enforces".
 *
 * main enters it from the ready room (its MECH LAB button) and the star
 * screen (MECH LAB, CHANGE MECH or a double click on a 'Mech), passing the
 * previous state. Only from the star screen with mechlabForMember set is
 * the lab choosing for one member: then EXIT LAB, CUSTOMIZE, ACCEPT MECH
 * and DELETE are disabled and STAR CONFIG assigns the variant (refused
 * over the Keshik maximum). Otherwise the player's own member (0) is
 * selected and ACCEPT MECH assigns the variant and returns to the
 * previous state.
 */
import { SHELL_LABEL as L } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem, type MPackDb } from '../../data/formats/mpack.ts';
import { dosFileRemove, dosFindFiles } from '../../engine/dosFiles.ts';
import { quirk } from '../../core/provenance.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { fieldOffset, mem } from '../memory.ts';
import { database, driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { strnicmp } from '../project.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animFreeAll, animSetFlags, animStart, animUnhide, animUpdateAll } from '../anim/anims.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonDisable, buttonEnable } from '../ui/buttonBar.ts';
import { labelDestroy } from '../ui/labels.ts';
import { mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { messageBox } from '../ui/messageBox.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { setWidgetLabel, widgetLabel, widgetPanelHit, widgetPanelLayout, widgetPanelRedraw, widgetRowClick, WIDGET_ROW } from '../ui/widgets.ts';
import { Sample, soundSampleCreate, soundSampleDestroy, soundSamplePlay, soundSampleSetLooping, soundSampleSetVolume } from '../sound/samples.ts';
import { projectTablLookup } from '../career/orders.ts';
import { chassisEntry } from '../handoff/starFiles.ts';
import { starMemberChassis, starMemberMekName, starRecord, starSetMember, starMember } from '../handoff/stars.ts';
import { grievanceChassisCount } from './grievance.ts';
import { g, mechlabLoadMek, mechlabPackMek, mechlabWriteMek, s } from '../mechlab/design.ts';
import { mechlabUi } from '../mechlab/panels.ts';
import { screenRowBackground, screenRowButtonCount, screenRowButtons } from './screenRows.ts';
import { shellScreens } from './registry.ts';

/** mechlabVariants: 200 names of 13 bytes. */
const VARIANT = 0xd;
const VARIANTS = 200;

export const mechlabScreen = registerGlobals(
  'mechlabScreen',
  {
    /** 0xa6370: the chassis's name sample (chassisTable[].nameSound), replaced on every chassis change */
    nameSample: null as Sample | null,
  },
  () => {
    mechlabScreen.nameSample = null;
  },
  'mw2shell',
);

/** mechlabVariants[i]'s address. */
function variantAt(i: number): number {
  return L.mechlabVariants + i * VARIANT;
}

/**
 * The variant list for the chassis with `prefix`: cleared; slot 0
 * '<prefix>00std'; slots 1..99 '<prefix>NNstd' where MW2.PRJ's TABL 6 has
 * the name; slots 100 + NN the files 'mek\<prefix>??usr.mek' (the name's
 * 4th and 5th characters give NN; the name cut to 8).
 *
 * @portOnly the list screen_mechlab builds inline five times
 */
export function mechlabListVariants(prefix: string): void {
  const m = mem();
  m.fill(L.mechlabVariants, 0, VARIANTS * VARIANT);
  // 0x76e4d / 0x76e57 '%s%02dstd'
  m.strcpy(L.mechlabVariantName, `${prefix}00std`);
  m.strcpy(variantAt(0), m.cstr(L.mechlabVariantName));
  for (let i = 1; i < 100; i++) {
    m.strcpy(L.mechlabVariantName, `${prefix}${String(i).padStart(2, '0')}std`);
    if (projectTablLookup(m.cstr(L.mechlabVariantName), 6) >= 0) m.strcpy(variantAt(i), m.cstr(L.mechlabVariantName));
  }
  // 0x76e61 'mek\%s??usr.mek'
  m.strcpy(L.mechlabVariantName, `mek\\${prefix}??usr.mek`);
  for (const found of dosFindFiles(m.cstr(L.mechlabVariantName))) {
    // find_t.name: its 4th and 5th characters, '0'-based, + 100
    const slot = (found.charCodeAt(3) - 0x30) * 10 + found.charCodeAt(4) + 0x34;
    m.strncpy(variantAt(slot), found, 8);
    m.setU8(variantAt(slot) + 8, 0);
  }
}

/** '~' + the chassis's displayName into mechlabChassisTitle. */
function chassisTitle(): void {
  mem().strcpy(L.mechlabChassisTitle, '~' + chassisEntry(g(L.mechlabChassis)).displayName);
}

/** The chassis animation (slot 16): hidden, then restarted from mechlabChassisAnimFormat and the animCode. */
function* startChassisAnim(): Blocking<void> {
  const m = mem();
  m.strcpy(L.mechlabAnimName, (m.ptrStr(L.mechlabChassisAnimFormat) ?? '').replace('%s', chassisEntry(g(L.mechlabChassis)).animCode));
  animSetFlags(0x10, 0x40000000, 0x40000000);
  yield* animStart(0x10, m.cstr(L.mechlabAnimName), g(L.mechlabChassisAnimX), g(L.mechlabChassisAnimY), 0x88, 0xe);
}

/** The chassis's name sample, replacing the last one, played at volume 40. */
function playNameSample(item: number): void {
  const wav = mpackDbGetItem(database(), item);
  if (mechlabScreen.nameSample) soundSampleDestroy(mechlabScreen.nameSample);
  const sample = soundSampleCreate(new Sample(), shell.soundSystem!, wav, wav?.length ?? 0);
  mechlabScreen.nameSample = sample;
  soundSampleSetVolume(sample, 0x28);
  soundSamplePlay(sample);
}

/** Frees a panel's labels (the pointer is left). */
function freeLabels(table: number): void {
  if (table === 0) return;
  for (let row = table; mem().i32(row) !== -1; row += WIDGET_ROW) {
    const l = widgetLabel(row);
    if (l) {
      labelDestroy(l);
      setWidgetLabel(row, null);
    }
  }
}

/** mechlab_load_mek of the selected slot, the chassis title, the right panel dropped, the left redrawn. */
function reloadVariant(): void {
  mechlabLoadMek(variantAt(g(L.mechlabVariant)));
  chassisTitle();
  freeLabels(mem().u32(L.mechlabPanel));
  s(L.mechlabPanel, 0);
  widgetPanelRedraw(mem().u32(L.mechlabSummaryPanel));
}

/** The per-career art: [slot, name, x, y, flags] (anim_start's immediates, strings 0x76f4d ..). */
const ART: Array<Array<[number, string, number, number, number]>> = [
  [
    [0, 'awogrid', 0x8c, 0x136, 0x4a],
    [1, 'wwomp1', 0xc, 0x34, 0x42],
    [10, 'wwomp4ar', 0xd8, 0x34, 100],
    [0xb, 'wwomp7cr', 0x1b4, 0x34, 100],
    [0xc, 'wwomp4mp', 0x4b, 0xab, 0x21],
    [0xd, 'wwomp5wa', 0xd8, 0x34, 100],
    [0xe, 'wwomp1es', 0x1b4, 0x34, 0x42],
    [4, 'wwobkg', 0xdb, 0x1ad, 2],
    [5, 'wwostar', 0x197, 0x19a, 0x4a],
    [6, 'wwocn', 0x122, 0x1b1, 100],
    [7, 'wwocp', 0xf0, 0x1b3, 100],
    [8, 'wwovn', 300, 0x1ad, 100],
    [9, 'wwovp', 0xdc, 0x1b0, 100],
  ],
  [
    [0, 'ajfgrid', 0x6c, 0x132, 0x4a],
    [1, 'wjfmp1', 0xc, 0x34, 0x42],
    [10, 'wjfmp4ar', 0xd8, 0x34, 100],
    [0xb, 'wjfmp7cr', 0x1b4, 0x34, 100],
    [0xc, 'wjfmp4mp', 0x4b, 0xab, 0x21],
    [0xd, 'wjfmp5wa', 0xd8, 0x34, 100],
    [0xe, 'wjfmp1es', 0x1b4, 0x34, 0x42],
    [4, 'wjfbkg', 0xd8, 0x1b2, 2],
    [5, 'wjfstar', 0x171, 0x1a0, 8],
    [6, 'wjfcn', 0x11e, 0x1b6, 100],
    [7, 'wjfcp', 0xf2, 0x1b6, 100],
    [8, 'wjfvn', 0x128, 0x1b2, 100],
    [9, 'wjfvp', 0xdc, 0x1b5, 100],
  ],
  [
    [0, 'aiagrid', 0x6c, 0x132, 0x4a],
    [1, 'wiamp1', 0xc, 0x34, 0x42],
    [10, 'wiamp4ar', 0xd8, 0x34, 100],
    [0xb, 'wiamp7cr', 0x1b4, 0x34, 100],
    [0xc, 'wiamp4mp', 0x4b, 0xab, 0x21],
    [0xd, 'wiamp5wa', 0xd8, 0x34, 100],
    [0xe, 'wiamp1es', 0x1b4, 0x34, 0x42],
    [4, 'wiabkg1', 0xdb, 0x19e, 4],
    [5, 'wiastar', 0x19d, 0x1a1, 0x24],
    [6, 'wiacn', 0x109, 0x1ae, 0x24],
    [7, 'wiacp', 0xee, 0x1b5, 0x24],
    [8, 'wiavn', 0x12e, 0x1af, 0x24],
    [9, 'wiavp', 0xdf, 0x1b5, 0x24],
  ],
];

/**
 * SAVE: refused with unassigned criticals or over weight (the screen stays
 * in CUSTOMIZE: 0); with no free user slot 'Too many mechs' (1); otherwise
 * the design goes to the first free slot k >= 100 as '<prefix>NNusr.mek'
 * (NN = k - 100), which becomes the selected variant (1).
 */
function* save(): Blocking<number> {
  const m = mem();
  if (g(L.mechlabUnplaced) !== -1) {
    // 0x76e71
    yield* messageBox("Invalid 'Mech specification:|Unassigned criticals detected.#Ok", 0);
    return 0;
  }
  if (g(L.designMass) > g(L.designMaxMass)) {
    // 0x76eb0
    yield* messageBox("Invalid 'Mech specification:|Chassis can not support|current mass.#Ok", 0);
    return 0;
  }
  let k = 100;
  while (k < VARIANTS && m.u8(variantAt(k)) !== 0) k++;
  if (k >= VARIANTS) {
    // 0x76ef6
    yield* messageBox('Error: Too many mechs|of this variant to save.#Ok', 0);
    return 1;
  }
  // 0x76f28 '%s%02dusr.mek'
  m.strcpy(L.mechlabSaveName, `${chassisEntry(g(L.mechlabChassis)).prefix}${String(k - 100).padStart(2, '0')}usr.mek`);
  m.strcpy(variantAt(k), m.cstr(L.mechlabSaveName));
  m.strncpy(variantAt(k), m.cstr(L.mechlabSaveName), 8);
  m.setU8(variantAt(k) + 8, 0);
  const bytes = mechlabPackMek();
  // 0x76dff 'mek\%s'
  m.strcpy(L.mechlabSavePath, `mek\\${m.cstr(L.mechlabSaveName)}`);
  if (mechlabWriteMek(m.cstr(L.mechlabSaveName), bytes) === 0) {
    // 0x76f36
    yield* messageBox("Error saving 'Mech.#Ok", 0);
  } else s(L.mechlabVariant, k);
  return 1;
}

/**
 * (db, career, previous). Buttons (mechlabScreenRows[career], 11): 0 EXIT
 * LAB -> 0xb; 1 STAR CONFIG -> 0xd (assigning the variant first when
 * choosing for a member); 2 / 3 NEXT / PREV CHASSIS over mechlabChassisCount
 * (15, or grievance_chassis_count's in career 2), with the chassis's name
 * sample; 4 / 5 NEXT / PREV VARIANT over the filled slots, wrapping; 6
 * CUSTOMIZE, only with a free user slot: the title 'User Variant #N', the
 * customizing summary and the ENGINE panel, only SAVE and ABORT enabled; 7
 * ACCEPT MECH assigns the variant and returns the previous state; 8 SAVE /
 * 9 ABORT leave CUSTOMIZE (SAVE only once the design is valid) and reload
 * the list and the variant; 10 DELETE (user slots) removes the file after
 * 'Delete this 'Mech?' and moves to the next filled slot. A click is
 * offered first to the left column's rows (no redraw), then to the right
 * panel's (both panels redrawn). The stale disables at entry test the
 * chassis and variant of the previous visit.
 *
 * @mw2shell screen_mechlab 0x000339e0
 * @fidelity exact
 */
export function* screenMechlab(db: MPackDb, career: number, previous: number): Blocking<number> {
  const m = mem();
  const d = driver();
  const ms = mouse();
  const forMember = g(L.mechlabForMember) !== 0 && previous === 0xd;
  s(L.mechlabForMember, 0);
  mechlabScreen.nameSample = null;
  const clickWav = mpackDbGetItem(database(), 0x50);
  const click = soundSampleCreate(new Sample(), shell.soundSystem!, clickWav, clickWav?.length ?? 0);
  mechlabUi.clickSample = click;
  soundSampleSetVolume(click, 0x28);
  const loopWav = mpackDbGetItem(db, 0x4b);
  const loop = soundSampleCreate(new Sample(), shell.soundSystem!, loopWav, loopWav?.length ?? 0);
  // created looping and never played
  soundSampleSetLooping(loop);
  m.setU8(L.mechlabTextNormal, 0xff);
  m.setU8(L.mechlabTextSelected, 0xff);
  m.setU8(L.mechlabTextWarning, 0xff);
  for (let i = 1; i < 0x100; i++) {
    m.setU8(L.mechlabTextWarning + i, i);
    m.setU8(L.mechlabTextSelected + i, i);
    m.setU8(L.mechlabTextNormal + i, i);
  }
  m.setU8(L.mechlabTextNormal + 1, 6);
  m.setU8(L.mechlabTextWarning + 1, 8);
  m.setU8(L.mechlabTextSelected + 1, 1);
  screenLoadBackground(d, db, screenRowBackground(L.mechlabScreenRows, career));
  const count = screenRowButtonCount(L.mechlabScreenRows, career);
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, screenRowButtons(L.mechlabScreenRows, career, count), count);
  buttonDisable(bar, 8);
  buttonDisable(bar, 9);
  if (forMember) {
    buttonDisable(bar, 0);
    buttonDisable(bar, 6);
    buttonDisable(bar, 7);
    buttonDisable(bar, 10);
  } else {
    quirk('screen_mechlab: CUSTOMIZE and DELETE are disabled at entry by the chassis and variant of the previous visit (mechlabChassis / mechlabVariant are set only after)', 'screen_mechlab');
    if (g(L.mechlabChassis) >= 0xf) buttonDisable(bar, 6);
    if (g(L.mechlabVariant) < 100) buttonDisable(bar, 10);
  }
  animFreeAll();
  if (career >= 0 && career <= 2) {
    for (const [i, name, x, y, flags] of ART[career]!) yield* animStart(i, name, x, y, flags, 0);
    s(L.mechlabChassisAnimY, 0x17f);
    s(L.mechlabChassisAnimX, career === 2 ? 0x136 : 0x146);
    s(L.mechlabChassisAnimFormat, [L.mechlabAnimFormatWolf, L.mechlabAnimFormatJadeFalcon, L.mechlabAnimFormatGrievance][career]!);
    m.setU8(L.mechlabTextWarning + 1, career === 2 ? 0xca : 0x17);
  }
  if (!forMember) starSetMember(0, null, null);
  s(L.mechlabChassisCount, career === 2 ? grievanceChassisCount() : 0xf);
  s(L.mechlabVariant, 0);
  s(L.mechlabChassis, starMemberChassis(-1));
  if (g(L.mechlabChassis) < 0) s(L.mechlabChassis, 0);
  else {
    const name = starMemberMekName(-1);
    let v = (name.charCodeAt(3) - 0x30) * 10 + name.charCodeAt(4) - 0x30;
    // 0x77077 'std'
    if (strnicmp(name.slice(5), 'std', 3) !== 0) v += 100;
    s(L.mechlabVariant, v);
  }
  if (g(L.mechlabChassisCount) <= g(L.mechlabChassis)) s(L.mechlabChassis, 0);
  const star = starRecord(-1);
  const member = starMember(star, m.i32(star + fieldOffset('StarRecord', 'selected')));
  // 0x7707b '~CALLSIGN: %s (%d.00 T MAX)'
  m.strcpy(L.mechlabCallsign, `~CALLSIGN: ${m.cstr(member + fieldOffset('StarMember', 'pilotName'), 16)} (${m.i32(star + fieldOffset('StarRecord', 'maxTonnage'))}.00 T MAX)`);
  yield* startChassisAnim();
  mechlabListVariants(chassisEntry(g(L.mechlabChassis)).prefix);
  mechlabLoadMek(variantAt(g(L.mechlabVariant)));
  chassisTitle();
  s(L.mechlabSummaryPanel, L.mechlabDesignPanel);
  widgetPanelLayout(L.mechlabDesignPanel);
  const sound = chassisEntry(g(L.mechlabChassis)).nameSound;
  if (sound >= 0) playNameSample(sound);

  let next = -1;
  for (;;) {
    animUpdateAll();
    yield* mouseUpdate(ms);
    const clicked = mouseLeftClicked(ms);
    if (clicked === 1) {
      const left = widgetPanelHit(m.u32(L.mechlabSummaryPanel), ms.x, ms.y);
      if (left !== 0) yield* widgetRowClick(left);
      else if (m.u32(L.mechlabPanel) !== 0) {
        const right = widgetPanelHit(m.u32(L.mechlabPanel), ms.x, ms.y);
        if (right !== 0) {
          yield* widgetRowClick(right);
          widgetPanelRedraw(m.u32(L.mechlabPanel));
          widgetPanelRedraw(m.u32(L.mechlabSummaryPanel));
        }
      }
    }
    const hit = buttonBarHit(bar, ms.x, ms.y);
    if (career === 2) animSetFlags(5, 0x20, 0x20);
    else animSetFlags(5, 1, 1);
    for (const i of [6, 7, 8, 9]) animSetFlags(i, 0x20, 0x20);
    const afterList = (): void => {
      if (g(L.mechlabVariant) < 100) buttonDisable(bar, 10);
      else buttonEnable(bar, 10);
    };
    switch (hit) {
      case 0:
        if (clicked === 1) next = 0xb;
        break;
      case 1:
        if (career === 2) animUnhide(5);
        else animSetFlags(5, 1, 0);
        if (clicked === 1) {
          soundSamplePlay(shell.sound102!);
          if (forMember && starSetMember(-1, m.cstr(variantAt(g(L.mechlabVariant)), 13), null) === 0) {
            // 0x77097
            yield* messageBox("'Mech exceeds|Keshik Defined Maximum Tonnage (KDMT)|for mission.#Ok", 0);
            break;
          }
          next = 0xd;
        }
        break;
      case 2:
      case 3:
        if (ms.leftDown === 1) animUnhide(hit === 2 ? 8 : 9);
        if (clicked === 1) {
          let c = g(L.mechlabChassis) + (hit === 2 ? 1 : -1);
          if (hit === 2 && g(L.mechlabChassisCount) <= c) c = 0;
          if (hit === 3 && c < 0) c = g(L.mechlabChassisCount) - 1;
          s(L.mechlabChassis, c);
          s(L.mechlabVariant, 0);
          const ns = chassisEntry(c).nameSound;
          if (ns >= 0) playNameSample(ns);
          yield* startChassisAnim();
          mechlabListVariants(chassisEntry(c).prefix);
          reloadVariant();
          if (c < 0xf) {
            if (!forMember) buttonEnable(bar, 6);
          } else buttonDisable(bar, 6);
          buttonDisable(bar, 10);
        }
        break;
      case 4:
      case 5:
        if (ms.leftDown === 1) animUnhide(hit === 4 ? 6 : 7);
        if (clicked === 1) {
          soundSamplePlay(shell.sound101!);
          let v = g(L.mechlabVariant);
          if (hit === 4) {
            v++;
            while (v < VARIANTS && m.u8(variantAt(v)) === 0) v++;
            if (v > 199) v = 0;
          } else {
            if (v === 0) v = VARIANTS;
            v--;
            while (v >= 0 && m.u8(variantAt(v)) === 0) v--;
            if (v < 0) v = 0;
          }
          s(L.mechlabVariant, v);
          reloadVariant();
          afterList();
        }
        break;
      case 6:
        if (clicked === 1) {
          let k = 100;
          while (k < VARIANTS && m.u8(variantAt(k)) !== 0) k++;
          if (k >= VARIANTS) {
            // 0x7710e
            yield* messageBox('Error: Too many mechs|of this variant to save.#Ok', 0);
            break;
          }
          // 0x77140 'User Variant #%d'
          m.strcpy(L.designTitle, `User Variant #${k - 99}`);
          animSetFlags(0, 1, 1);
          animSetFlags(0x10, 0x40000000, 0x40000000);
          freeLabels(m.u32(L.mechlabSummaryPanel));
          s(L.mechlabSummaryPanel, L.mechlabCustomizingPanel);
          widgetPanelLayout(L.mechlabCustomizingPanel);
          freeLabels(m.u32(L.mechlabPanel));
          s(L.mechlabPanel, L.mechlabEnginePanel);
          widgetPanelLayout(L.mechlabEnginePanel);
          for (const b of [0, 1, 2, 3, 4, 5, 6, 7, 10]) buttonDisable(bar, b);
          buttonEnable(bar, 8);
          buttonEnable(bar, 9);
        }
        break;
      case 7:
        if (clicked === 1) {
          if (starSetMember(-1, m.cstr(variantAt(g(L.mechlabVariant)), 13), null) === 0) {
            // 0x77151
            yield* messageBox("'Mech exceeds|Keshik Defined Maximum Tonnage (KDMT)|for mission.#Ok", 0);
          } else next = previous;
        }
        break;
      case 8:
      case 9:
        if (clicked === 1) {
          if (hit === 8 && (yield* save()) === 0) break;
          for (const i of [10, 11, 12, 13]) animSetFlags(i, 0x20, 0x20);
          animUnhide(0xe);
          yield* startChassisAnim();
          mechlabListVariants(chassisEntry(g(L.mechlabChassis)).prefix);
          mechlabLoadMek(variantAt(g(L.mechlabVariant)));
          chassisTitle();
          freeLabels(m.u32(L.mechlabPanel));
          s(L.mechlabPanel, 0);
          freeLabels(m.u32(L.mechlabSummaryPanel));
          s(L.mechlabSummaryPanel, L.mechlabDesignPanel);
          widgetPanelLayout(L.mechlabDesignPanel);
          animSetFlags(0, 1, 0);
          animUnhide(0x10);
          for (const b of [0, 1, 2, 3, 4, 5, 6, 7]) buttonEnable(bar, b);
          buttonDisable(bar, 8);
          buttonDisable(bar, 9);
          afterList();
        }
        break;
      case 10:
        // 0x770db "Delete this 'Mech?|Are you sure?#Yes|No"
        if (clicked === 1 && (yield* messageBox("Delete this 'Mech?|Are you sure?#Yes|No", 1)) !== 1) {
          // 0x77103 'mek\%s.mek'
          m.strcpy(L.mechlabText, `mek\\${m.cstr(variantAt(g(L.mechlabVariant)), 13)}.mek`);
          dosFileRemove(m.cstr(L.mechlabText));
          m.setU8(variantAt(g(L.mechlabVariant)), 0);
          let v = g(L.mechlabVariant) + 1;
          while (v < VARIANTS && m.u8(variantAt(v)) === 0) v++;
          if (v > 199) v = 0;
          s(L.mechlabVariant, v);
          reloadVariant();
          afterList();
        }
        break;
    }
    if (next === -1) next = yield* shellMenu();
    if (next !== -1) {
      freeLabels(m.u32(L.mechlabSummaryPanel));
      freeLabels(m.u32(L.mechlabPanel));
      animFreeAll();
      soundSampleDestroy(loop);
      if (mechlabScreen.nameSample) soundSampleDestroy(mechlabScreen.nameSample);
      soundSampleDestroy(click);
      buttonBarDestroy(bar);
      return next;
    }
  }
}

shellScreens.register(9, (l) => screenMechlab(l.db, l.career.value, l.previous));
