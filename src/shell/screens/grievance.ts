/**
 * State 7, the Trial of Grievance setup (decompiled/mw2shell/src/career/
 * pilots.c): two stars side by side - members, formation and Clan insignia
 * each - on one of the ten grievance scenarios, stepped with a button;
 * LAUNCH writes instmap1.bwd with both insignia and launches the sim.
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { mpackDbGetItem, type MPackDb } from '../../data/formats/mpack.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { fieldOffset, mem } from '../memory.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animFreeAll, animIsRunning, animStart, animUnhide, animUpdateAll } from '../anim/anims.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonDefsAt } from '../ui/buttonBar.ts';
import { labelCreateUnder, labelDestroy, labelsClear, remapAt, type TextLabel } from '../ui/labels.ts';
import { mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { Sample, soundSampleCreate, soundSampleDestroy, soundSamplePlay, soundSamplePlayWait, soundSampleSetVolume } from '../sound/samples.ts';
import { brf2PlanetShow, missionBrf2Load, planetLabels, type Brf2Planet } from '../career/brf2.ts';
import { starConfigure, starFormation, starMemberChassis, starRecord, starSetMember } from '../handoff/stars.ts';
import { chassisEntry, instmapWrite } from '../handoff/starFiles.ts';
import { shellScreens } from './registry.ts';

export const grievance = registerGlobals(
  'grievanceScreen',
  {
    /** each member's label: grievancePlayerMembers / grievanceOpponentMembers [i].label (0xa2100 / 0xa2118, 8 bytes each) */
    memberLabels: [
      [null, null, null],
      [null, null, null],
    ] as Array<Array<TextLabel | null>>,
    /** grievancePlayerFormationLabel (0xa2144), grievanceOpponentFormationLabel (0xa2140) */
    formationLabels: [null, null] as Array<TextLabel | null>,
  },
  () => {
    grievance.memberLabels = [
      [null, null, null],
      [null, null, null],
    ];
    grievance.formationLabels = [null, null];
  },
  'mw2shell',
);

/** The members' records: {label, chassis} at 0xa2100 (player) / 0xa2118 (opponent); the chassis at +4. */
const MEMBERS = [SHELL_LABEL.grievancePlayerMembers, SHELL_LABEL.grievanceOpponentMembers];

function memberChassis(star: number, i: number): number {
  return mem().i32(MEMBERS[star]! + i * 8 + 4);
}

function setMemberChassis(star: number, i: number, v: number): void {
  mem().setI32(MEMBERS[star]! + i * 8 + 4, v);
}

/** The pilot-name cheat: Enzo 18, Hobbes 17, Calvin 16 chassis (strcmp, so case-sensitive), else 15. */
function chassisCountFor(name: string): number {
  // 0x768a0 'Enzo', 0x768a5 'Hobbes', 0x768ac 'Calvin'
  if (name === 'Enzo') return 0x12;
  if (name === 'Hobbes') return 0x11;
  if (name === 'Calvin') return 0x10;
  return 0xf;
}

/** star_record(0)->members[0].pilotName */
function playerPilotName(): string {
  return mem().cstr(starRecord(0) + fieldOffset('StarRecord', 'members') + fieldOffset('StarMember', 'pilotName'), 16);
}

/**
 * The mech lab's chassis count in the Trial of Grievance, by the player's
 * star's first pilot's name: 'Enzo' 18, 'Hobbes' 17, 'Calvin' 16, anyone
 * else 15 - the cheat that adds the Elemental, Tarantula and Battle Master
 * IIC.
 *
 * @mw2shell grievance_chassis_count 0x000295c0
 * @fidelity exact
 */
export function grievanceChassisCount(): number {
  return chassisCountFor(playerPilotName());
}

/**
 * The two formation names (formationTitles[formation * 2]: 'Echelon Left'
 * ...) of the player's star at button 6's label position and the
 * opponent's at button 17's, in font32 through grievanceTextRemap, each
 * replacing its previous label; grievancePlayerFormation /
 * grievanceOpponentFormation take star_formation(0) / (1).
 *
 * @mw2shell grievance_draw_formations 0x00029510
 * @fidelity exact
 */
export function grievanceDrawFormations(): void {
  const m = mem();
  const buttons = buttonDefsAt(SHELL_LABEL.grievanceButtons, 0x19);
  const remap = remapAt(SHELL_LABEL.grievanceTextRemap);
  const draw = (star: number, formationAt: number, slot: number, button: number) => {
    const f = starFormation(star);
    m.setI32(formationAt, f);
    const old = grievance.formationLabels[slot];
    if (old) labelDestroy(old);
    const b = buttons[button]!;
    grievance.formationLabels[slot] = labelCreateUnder(shell.font32!, b.labelX, b.labelY, m.ptrStr(SHELL_LABEL.formationTitles + f * 8), remap);
  };
  // 0x7e95c / 0x7e960 are button 6's labelX / labelY, 0x7ea90 / 0x7ea94 button 17's
  draw(0, SHELL_LABEL.grievancePlayerFormation, 0, 6);
  draw(1, SHELL_LABEL.grievanceOpponentFormation, 1, 17);
}

/**
 * (db, &commandLine, previousState). grievanceChassisLimit from the
 * player's first pilot's name (the Enzo / Hobbes / Calvin cheat);
 * grievanceTextRemap built (ink 0x22). Sounds: DATABASE item 78 (the
 * launch) and, entered from the title, item 82 at volume 30. From the
 * title the scenario restarts at 0 and its BRF2 loads both stars; the
 * scenario is prmBlock.grievanceScenario. Background item 9; the bar
 * grievanceButtons (25). Insignia: wiawolf (slot 1) and wiajf (slot 2);
 * the members' chassis labels at buttons 3..5 / 14..16; wialanch waits
 * hidden in slot 16; the planet loops in slot 0. Buttons: 0 LAUNCH -
 * wialanch shown, item 78 played to the end, instmap1.bwd written with
 * both insignia - -> 10; 1 EXIT -> 8; 2 the next scenario (wrapping), its
 * stars and planet loaded; 3..5 / 14..16 the next chassis for a member
 * and 7..9 / 18..20 the previous, none and back round, skipping what
 * star_set_member refuses; 6 / 17 the next formation, 10 / 21 the
 * previous; 11 / 22 the next insignia (never both sides the same); 12 /
 * 23 MECH LAB (9) and 13 / 24 STAR CONFIG (0xd) for the player's /
 * opponent's star. Leaving clears every label and keeps the scenario.
 *
 * @mw2shell screen_grievance 0x00029680
 * @fidelity exact
 */
export function* screenGrievance(db: MPackDb, commandLine: { value: string }, previous: number): Blocking<number> {
  const m = mem();
  const d = driver();
  const ms = mouse();
  m.setI32(SHELL_LABEL.grievanceChassisLimit, chassisCountFor(playerPilotName()));
  const remap = remapAt(SHELL_LABEL.grievanceTextRemap);
  for (let i = 1; i < 0x100; i++) remap[i] = i;
  remap[0] = 0xff;
  remap[1] = 0x22;
  const wav78 = mpackDbGetItem(db, 0x4e);
  const launchSound = soundSampleCreate(new Sample(), shell.soundSystem!, wav78, wav78?.length ?? 0);
  let music: Sample | null = null;
  if (previous === 8) {
    const wav82 = mpackDbGetItem(db, 0x52);
    music = soundSampleCreate(new Sample(), shell.soundSystem!, wav82, wav82?.length ?? 0);
  }
  // 0x768b3 'pinkscn1'
  commandLine.value = 'pinkscn1';
  screenLoadBackground(d, db, 9);
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, buttonDefsAt(SHELL_LABEL.grievanceButtons, 0x19), 0x19);
  const buttons = buttonDefsAt(SHELL_LABEL.grievanceButtons, 0x19);
  // the planet labels (planetLabels, 0xa2130) zeroed: dropped, not destroyed
  planetLabels.labels.fill(null);
  const scenarioAt = SHELL_LABEL.prmBlock + fieldOffset('PrmBlock', 'grievanceScenario');
  if (previous === 8) m.setI32(scenarioAt, 0);
  let scenario = m.i32(scenarioAt);
  m.setI32(SHELL_LABEL.briefingPlanet, 0);
  const scenarioName = (i: number) => m.ptrStr(SHELL_LABEL.grievanceScenarios + i * 4);
  commandLine.value = scenarioName(scenario) ?? '';
  const planet: Brf2Planet | null = missionBrf2Load(commandLine.value, previous === 8, true);
  if (planet) yield* brf2PlanetShow(planet);
  const insignia = (i: number) => m.ptrStr(SHELL_LABEL.insigniaAnims + i * 4) ?? '';
  yield* animStart(1, insignia(0), 0xd, 0xcd, 6, 0);
  let insigniaB = 1;
  let insigniaA = 0;
  yield* animStart(2, insignia(1), 0x1e3, 0x149, 6, 0);
  /** A member's chassis label, from the star's current member, at its button's label position. */
  const relabel = (star: number, i: number, button: number) => {
    starConfigure(star, -1, -1, -1, -1);
    const chassis = starMemberChassis(i);
    setMemberChassis(star, i, chassis);
    const old = grievance.memberLabels[star]![i];
    if (old) labelDestroy(old);
    // 0x76899 '[none]'
    const text = chassis < 0 ? '[none]' : chassisEntry(memberChassis(star, i)).displayName;
    const b = buttons[button]!;
    grievance.memberLabels[star]![i] = labelCreateUnder(shell.font32!, b.labelX, b.labelY, text, remap);
  };
  const relabelAll = (fresh: boolean) => {
    for (let i = 0; i < 3; i++) {
      if (fresh) grievance.memberLabels[0]![i] = null;
      relabel(0, i, 3 + i);
      if (fresh) grievance.memberLabels[1]![i] = null;
      relabel(1, i, 0xe + i);
    }
    starConfigure(0, -1, -1, -1, -1);
  };
  relabelAll(true);
  grievance.formationLabels = [null, null];
  grievanceDrawFormations();
  // 0x768bc 'wialanch' (hidden, hold)
  yield* animStart(0x10, 'wialanch', 0xd1, 0x173, 0x24, 0);
  let next = -1;
  if (music) soundSampleSetVolume(music, 0x1e);
  if (music) soundSamplePlay(music);
  /** A member's chassis stepped forward (+1) or back (-1) until star_set_member takes it; then relabelled. */
  const step = (star: number, i: number, dir: number, button: number) => {
    const limit = m.i32(SHELL_LABEL.grievanceChassisLimit);
    let r: number;
    do {
      let name: string;
      const c = memberChassis(star, i) + dir;
      setMemberChassis(star, i, c);
      if (dir > 0) {
        if (c < limit) name = chassisEntry(c).prefix;
        else {
          setMemberChassis(star, i, -1);
          // 0x768c5 / 0x768c7 ''
          name = '';
        }
      } else if (c === -1) {
        // 0x768c6 / 0x768c8 ''
        name = '';
      } else {
        if (c === -2) setMemberChassis(star, i, limit - 1);
        name = chassisEntry(memberChassis(star, i)).prefix;
      }
      starConfigure(star, -1, -1, -1, -1);
      r = starSetMember(i, name, null);
    } while (r === 0);
    const chassis = starMemberChassis(i);
    setMemberChassis(star, i, chassis);
    const old = grievance.memberLabels[star]![i];
    if (old) labelDestroy(old);
    const text = chassis < 0 ? '[none]' : chassisEntry(memberChassis(star, i)).displayName;
    const b = buttons[button]!;
    grievance.memberLabels[star]![i] = labelCreateUnder(shell.font32!, b.labelX, b.labelY, text, remap);
  };
  /** A formation stepped with wrapping (0..5), then star_configure and the labels. */
  const formation = (star: number, dir: number) => {
    const at = star === 0 ? SHELL_LABEL.grievancePlayerFormation : SHELL_LABEL.grievanceOpponentFormation;
    let f = m.i32(at) + dir;
    if (dir > 0 && f >= 6) f = 0;
    if (dir < 0 && f < 0) f = 5;
    m.setI32(at, f);
    starConfigure(star, f, -1, -1, -1);
    grievanceDrawFormations();
  };
  do {
    if (animIsRunning(0) === 0) yield* animStart(0, m.ptrStr(SHELL_LABEL.planetAnims + (m.i32(SHELL_LABEL.briefingPlanet) * 2 + 1) * 4) ?? '', 0x19e, 10, 0x4a, 0);
    animUpdateAll();
    yield* mouseUpdate(ms);
    const hit = buttonBarHit(bar, ms.x, ms.y);
    if (hit >= 0 && hit <= 0x18 && mouseLeftClicked(ms) === 1) {
      switch (hit) {
        case 0:
          animUnhide(0x10);
          animUpdateAll();
          yield* mouseUpdate(ms);
          yield* soundSamplePlayWait(launchSound);
          instmapWrite(insigniaA, insigniaB);
          next = 10;
          break;
        case 1:
          next = 8;
          break;
        case 2: {
          scenario++;
          if (scenarioName(scenario) === null) scenario = 0;
          commandLine.value = scenarioName(scenario) ?? '';
          const shown: Brf2Planet | null = missionBrf2Load(commandLine.value, true, true);
          if (shown) yield* brf2PlanetShow(shown);
          relabelAll(false);
          grievanceDrawFormations();
          break;
        }
        case 3:
        case 4:
        case 5:
          step(0, hit - 3, 1, hit);
          break;
        case 6:
          formation(0, 1);
          break;
        case 7:
        case 8:
        case 9:
          step(0, hit - 7, -1, hit - 4);
          break;
        case 10:
          formation(0, -1);
          break;
        case 11:
          if (++insigniaA >= 6) insigniaA = 0;
          if (insigniaA === insigniaB) insigniaA++;
          if (insigniaA >= 6) insigniaA = 0;
          yield* animStart(1, insignia(insigniaA), 0xd, 0xcd, 6, 0);
          break;
        case 12:
          next = 9;
          starConfigure(0, -1, -1, -1, -1);
          break;
        case 13:
          next = 0xd;
          starConfigure(0, -1, -1, -1, -1);
          break;
        case 14:
        case 15:
        case 16:
          step(1, hit - 0xe, 1, hit);
          break;
        case 17:
          formation(1, 1);
          break;
        case 18:
        case 19:
        case 20:
          step(1, hit - 0x12, -1, hit - 4);
          break;
        case 21:
          formation(1, -1);
          break;
        case 22:
          if (++insigniaB >= 6) insigniaB = 0;
          if (insigniaB === insigniaA) insigniaB++;
          if (insigniaB >= 6) insigniaB = 0;
          yield* animStart(2, insignia(insigniaB), 0x1e3, 0x149, 6, 0);
          break;
        case 23:
          next = 9;
          starConfigure(1, -1, -1, -1, -1);
          break;
        case 24:
          next = 0xd;
          starConfigure(1, -1, -1, -1, -1);
          break;
      }
    }
    if (next === -1) next = yield* shellMenu();
  } while (next === -1);
  animFreeAll();
  buttonBarDestroy(bar);
  soundSampleDestroy(launchSound);
  if (music) soundSampleDestroy(music);
  labelsClear(d, 1);
  m.setI32(scenarioAt, scenario);
  return next;
}

shellScreens.register(7, (l) => screenGrievance(l.db, l.commandLine, l.previous));
