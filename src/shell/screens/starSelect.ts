/**
 * State 0xd, the star screen (decompiled/mw2shell/src/mechlab/
 * star_select.c): the current star's three members over a formation grid,
 * each with a panel of pilot name, chassis and tonnage; the Keshik limits
 * above (README "The star screen").
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import type { MPackDb } from '../../data/formats/mpack.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { fieldOffset, mem, structSize } from '../memory.ts';
import { driver, mouse, shell } from '../state.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenLoadBackground } from '../video/background.ts';
import { animFreeAll, animSetFlags, animStart, animUnhide, animUpdateAll } from '../anim/anims.ts';
import { ButtonBar, buttonBarCreate, buttonBarDestroy, buttonBarHit, buttonDisable, buttonEnable } from '../ui/buttonBar.ts';
import { labelCreate, labelCreateUnder, labelDestroy, labelsClear, type TextLabel } from '../ui/labels.ts';
import { mouseDoubleClicked, mouseLeftClicked, mouseUpdate } from '../ui/mouse.ts';
import { shellMenu } from '../ui/shellMenu.ts';
import { fontCharWidth, textInput } from '../ui/textInput.ts';
import { soundSamplePlay } from '../sound/samples.ts';
import { careerMission, currentPilot, pilotField } from '../career/missions.ts';
import { currentStar, starMember } from '../handoff/stars.ts';
import { chassisEntry } from '../handoff/starFiles.ts';
import { screenRowBackground, screenRowButtons } from './screenRows.ts';
import { shellScreens } from './registry.ts';

const STAR = {
  formation: fieldOffset('StarRecord', 'formation'),
  selected: fieldOffset('StarRecord', 'selected'),
  maxMechs: fieldOffset('StarRecord', 'maxMechs'),
  memberCount: fieldOffset('StarRecord', 'memberCount'),
  maxTonnage: fieldOffset('StarRecord', 'maxTonnage'),
  pilotName: fieldOffset('StarMember', 'pilotName'),
};
const SLOT = {
  size: structSize('StarSlot'),
  member: fieldOffset('StarSlot', 'member'),
  spriteX: fieldOffset('StarSlot', 'spriteX'),
  spriteY: fieldOffset('StarSlot', 'spriteY'),
  panel: fieldOffset('StarSlot', 'panel'),
};

export const starSelect = registerGlobals(
  'starSelectScreen',
  {
    /** starPanelLabels (0xa7124): per slot, the pilot, chassis and tonnage labels */
    panelLabels: [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ] as Array<Array<TextLabel | null>>,
    /** starLimitLabels (0xa715c): formation, mission, maximum 'Mechs, KDMT, total mass */
    limitLabels: [null, null, null, null, null] as Array<TextLabel | null>,
  },
  () => {
    starSelect.panelLabels = [0, 1, 2].map(() => [null, null, null]);
    starSelect.limitLabels = [null, null, null, null, null];
  },
  'mw2shell',
);

/** starSlotLayout[formation * 3 + slot]: its address (the layout the screen pointed starSlotLayout at). */
function slotAt(formation: number, slot: number): number {
  return mem().u32(SHELL_LABEL.starSlotLayout) + (formation * 3 + slot) * SLOT.size;
}

/** starPanelX[panel] / starPanelY[panel], through the pointers the screen set. */
function panelXY(panel: number): { x: number; y: number } {
  const m = mem();
  return { x: m.i32(m.u32(SHELL_LABEL.starPanelX) + panel * 4), y: m.i32(m.u32(SHELL_LABEL.starPanelY) + panel * 4) };
}

function dropLabel(l: TextLabel | null): void {
  if (l) labelDestroy(l);
}

/**
 * (formation, slot, bar): redraws one slot of the current star. The panel
 * comes from the current star's own formation's layout, the member from
 * `formation`'s. The slot's three labels go; CHANGE MECH for the panel is
 * disabled. A member below memberCount gets its panel animation (1 +
 * panel) shown, the button enabled, its chassis sprite (starSpriteFormat
 * with the chassis's animCode, slot 10 + slot, bottom-centred) and three
 * labels at the panel's place, 12 px apart: the pilot's name - cut, in the
 * star record itself, to the characters that fit 92 px of font32 - the
 * chassis's name and '%d.00 T' (its tonnage, also kept in
 * starMemberTonnage). Otherwise the sprite is freed and the panel hidden.
 *
 * @mw2shell star_slot_draw 0x0003aeb0
 * @fidelity exact
 */
export function* starSlotDraw(formation: number, slot: number, bar: ButtonBar): Blocking<void> {
  const m = mem();
  const labels = starSelect.panelLabels[slot]!;
  dropLabel(labels[0]!);
  dropLabel(labels[1]!);
  dropLabel(labels[2]!);
  labels[0] = labels[1] = labels[2] = null;
  const star = currentStar();
  const own = slotAt(m.i32(star + STAR.formation), slot);
  const panel = m.i32(own + SLOT.panel);
  const member = m.i32(slotAt(formation, slot) + SLOT.member);
  buttonDisable(bar, panel + 6);
  if (member >= m.i32(star + STAR.memberCount)) {
    animSetFlags(slot + 10, 0x40000000, 0x40000000);
    animSetFlags(panel + 1, 0x20, 0x20);
    return;
  }
  animUnhide(panel + 1);
  buttonEnable(bar, panel + 6);
  const chassis = m.i32(starMember(star, member));
  const c = chassisEntry(chassis);
  const sprite = (m.ptrStr(SHELL_LABEL.starSpriteFormat) ?? '').replace('%s', c.animCode);
  yield* animStart(slot + 10, sprite, m.i32(own + SLOT.spriteX), m.i32(own + SLOT.spriteY), 0x88, 0);
  const { x, y } = panelXY(panel);
  // the name, cut where font_char_width(font32, c) sums past 0x5c, copied via 0xa6f1c back into the record
  const nameAt = starMember(star, member) + STAR.pilotName;
  const name = m.cstr(nameAt, 16);
  let width = 0;
  let cut = '';
  for (const ch of name) {
    width += fontCharWidth(shell.font32!, ch.charCodeAt(0));
    if (width > 0x5c) break;
    cut += ch;
  }
  m.strcpy(nameAt, cut);
  labels[0] = labelCreate(shell.font32!, x, y, m.cstr(nameAt, 16), null);
  labels[1] = labelCreate(shell.font32!, x, y + 0xc, c.displayName, null);
  m.setI32(SHELL_LABEL.starMemberTonnage + member * 4, c.tonnage);
  // 0x77e03 '%d.00 T'
  labels[2] = labelCreate(shell.font32!, x, y + 0x18, `${c.tonnage}.00 T`, null);
}

/**
 * (career): the five lines above the grid, each replacing its previous
 * label, centred on x 320: the formation's name (font27, y 4), the mission
 * ('~Mission: Trial of Grievance' for career 2, else the pilot's next
 * mission's title; y 35), "Maximum 'Mechs in current Star" (y 50), the
 * Keshik Defined Maximum Tonnage (y 65) and the Current Total Mass of the
 * Star - starMemberTonnage summed over memberCount (y 80).
 *
 * @mw2shell star_limits_show 0x0003b1f0
 * @fidelity exact
 */
export function starLimitsShow(career: number): void {
  const m = mem();
  const l = starSelect.limitLabels;
  const star = currentStar();
  dropLabel(l[0]!);
  l[0] = labelCreateUnder(shell.font27!, 0x140, 4, m.ptrStr(SHELL_LABEL.formationNames + m.i32(star + STAR.formation) * 8), null);
  dropLabel(l[1]!);
  // 0x77e0b '~Mission: Trial of Grievance', 0x77e28 '~Mission: %s'
  const mission = career === 2 ? '~Mission: Trial of Grievance' : `~Mission: ${careerMission(career, pilotField(currentPilot(), 'missionIndex')).title}`;
  l[1] = labelCreateUnder(shell.font32!, 0x140, 0x23, mission, null);
  dropLabel(l[2]!);
  // 0x77e35 "~Maximum 'Mechs in current Star: %d"
  l[2] = labelCreateUnder(shell.font32!, 0x140, 0x32, `~Maximum 'Mechs in current Star: ${m.i32(star + STAR.maxMechs)}`, null);
  dropLabel(l[3]!);
  // 0x77e59 "~Keshik Defined Maximum Tonnage (KDMT) per 'Mech: %d.00 T"
  l[3] = labelCreateUnder(shell.font32!, 0x140, 0x41, `~Keshik Defined Maximum Tonnage (KDMT) per 'Mech: ${m.i32(star + STAR.maxTonnage)}.00 T`, null);
  dropLabel(l[4]!);
  let total = 0;
  for (let i = 0; i < m.i32(star + STAR.memberCount); i++) total = (total + m.i32(SHELL_LABEL.starMemberTonnage + i * 4)) | 0;
  // 0x77e93 '~Current Total Mass of the Star: %d.00 T'
  l[4] = labelCreateUnder(shell.font32!, 0x140, 0x50, `~Current Total Mass of the Star: ${total}.00 T`, null);
}

/** The per-career art: [slot, name, x, y, flags] for slots 0..9 (listing/screen_anims.txt). */
const ART: Array<Array<[string, number, number, number]>> = [
  [
    // 0x77ebc.. 'awogrid' 'awostr1..3' 'wwobkg' 'wwodsgn' 'wwocn' 'wwocp' 'wwovn' 'wwovp'
    ['awogrid', 0x8c, 0x136, 0x4a],
    ['awostr1', 0x49, 0x9e, 0x44],
    ['awostr2', 0x131, 0x7d, 0x44],
    ['awostr3', 500, 0xb5, 0x44],
    ['wwobkg', 0xdb, 0x1ad, 2],
    ['wwodsgn', 0x197, 0x19a, 0x4a],
    ['wwocn', 0x122, 0x1b1, 100],
    ['wwocp', 0xf0, 0x1b3, 100],
    ['wwovn', 300, 0x1ad, 100],
    ['wwovp', 0xdc, 0x1b0, 100],
  ],
  [
    // 0x77f03.. 'ajfgrid' 'ajfstr1..3' 'wjfbkg' 'wjfdsgn' 'wjfcn' 'wjfcp' 'wjfvn' 'wjfvp'
    ['ajfgrid', 0x6c, 0x132, 0x4a],
    ['ajfstr1', 0x27, 0xa4, 0x44],
    ['ajfstr2', 0x110, 0x77, 0x44],
    ['ajfstr3', 0x1e7, 0xd1, 0x44],
    ['wjfbkg', 0xd8, 0x1b2, 2],
    ['wjfdsgn', 0x171, 0x1a0, 0x48],
    ['wjfcn', 0x11e, 0x1b6, 100],
    ['wjfcp', 0xf2, 0x1b6, 100],
    ['wjfvn', 0x128, 0x1b2, 100],
    ['wjfvp', 0xdc, 0x1b5, 100],
  ],
  [
    // 0x77f4a.. 'aiagrid' 'aiastr1' x3 'wiabkg2' 'wiadsgn' 'wiacn' 'wiacp' 'wiavn' 'wiavp'
    ['aiagrid', 0x6c, 0x132, 0x4a],
    ['aiastr1', 0x49, 0x9e, 0x44],
    ['aiastr1', 0x131, 0x7d, 0x44],
    ['aiastr1', 500, 0xb5, 0x44],
    ['wiabkg2', 0xdb, 0x19e, 4],
    ['wiadsgn', 0x19f, 0x1a1, 0x24],
    ['wiacn', 0x109, 0x1ae, 0x24],
    ['wiacp', 0xee, 0x1b5, 0x24],
    ['wiavn', 0x12e, 0x1af, 0x24],
    ['wiavp', 0xdf, 0x1b5, 0x24],
  ],
];

/**
 * (db, career). The career's art (Wolf, Jade Falcon, or career 2's)
 * and its layout: starSlotLayout, starSpriteFormat and starPanelX / Y
 * point at the career's tables (career 2 uses Wolf's layout and panels
 * with the aiasc%s sprites). Buttons (starSelectScreenRows[career], 9):
 * 0 EXIT CONFIG -> 0xb; 1 MECH LAB -> 9, browsing (mechlabForMember 0);
 * 2 / 3 NEXT / PREV FORMATION; 4 / 5 ADD / DELETE STARMATE (up to maxMechs,
 * down to 1); 6..8 CHANGE MECH for that panel's member -> 9 with
 * mechlabForMember 1. The bottom bar's button art shows while the button
 * is held. A click on a panel's pilot name (100 x 10 px at the panel)
 * edits that member's name (text_input, 15 characters in 100 px) - members up to
 * memberCount, member 0 only in career 2. A double click on a sprite with
 * a chassis (x +-50, the 100 px above its y) is CHANGE MECH for its member.
 *
 * @mw2shell screen_star_select 0x0003b420
 * @fidelity exact
 */
export function* screenStarSelect(db: MPackDb, career: number): Blocking<number> {
  const m = mem();
  const d = driver();
  const ms = mouse();
  screenLoadBackground(d, db, screenRowBackground(SHELL_LABEL.starSelectScreenRows, career));
  const bar = buttonBarCreate(new ButtonBar(), d, shell.uiFont, 0, screenRowButtons(SHELL_LABEL.starSelectScreenRows, career, 9), 9);
  if (career >= 0 && career <= 2) {
    const art = ART[career]!;
    for (let i = 0; i < art.length; i++) {
      const [name, x, y, flags] = art[i]!;
      yield* animStart(i, name, x, y, flags, 0);
    }
    const wolfish = career !== 1;
    m.setI32(SHELL_LABEL.starPanelX, wolfish ? SHELL_LABEL.starPanelXWolf : SHELL_LABEL.starPanelXJadeFalcon);
    m.setI32(SHELL_LABEL.starPanelY, wolfish ? SHELL_LABEL.starPanelYWolf : SHELL_LABEL.starPanelYJadeFalcon);
    m.setI32(SHELL_LABEL.starSlotLayout, wolfish ? SHELL_LABEL.starSlotsWolf : SHELL_LABEL.starSlotsJadeFalcon);
    m.setI32(SHELL_LABEL.starSpriteFormat, [SHELL_LABEL.starSpriteFormatWolf, SHELL_LABEL.starSpriteFormatJadeFalcon, SHELL_LABEL.starSpriteFormatGrievance][career]!);
  }
  let next = -1;
  for (let i = 0; i < 3; i++) {
    starSelect.panelLabels[i] = [null, null, null];
    yield* starSlotDraw(m.i32(currentStar() + STAR.formation), i, bar);
  }
  starSelect.limitLabels = [null, null, null, null, null];
  starLimitsShow(career);
  const redrawAll = function* (): Blocking<void> {
    for (let i = 0; i < 3; i++) yield* starSlotDraw(m.i32(currentStar() + STAR.formation), i, bar);
    starLimitsShow(career);
  };
  for (;;) {
    animUpdateAll();
    yield* mouseUpdate(ms);
    const hit = buttonBarHit(bar, ms.x, ms.y);
    if (career === 2) animSetFlags(5, 0x20, 0x20);
    else animSetFlags(5, 1, 1);
    animSetFlags(6, 0x20, 0x20);
    animSetFlags(7, 0x20, 0x20);
    animSetFlags(8, 0x20, 0x20);
    animSetFlags(9, 0x20, 0x20);
    const star = currentStar();
    switch (hit) {
      case 0:
        if (mouseLeftClicked(ms) === 1) next = 0xb;
        break;
      case 1:
        if (career === 2) animUnhide(5);
        else animSetFlags(5, 1, 0);
        if (mouseLeftClicked(ms) === 1) {
          soundSamplePlay(shell.sound102!);
          m.setI32(SHELL_LABEL.mechlabForMember, 0);
          next = 9;
        }
        break;
      case 2:
      case 3:
      case 4:
      case 5:
        if (ms.leftDown === 1) animUnhide(hit + 4);
        if (mouseLeftClicked(ms) === 1) {
          soundSamplePlay(shell.sound101!);
          if (hit === 2) {
            const f = m.i32(star + STAR.formation) + 1;
            m.setI32(star + STAR.formation, f);
            if (f >= 6) m.setI32(star + STAR.formation, 0);
          } else if (hit === 3) {
            const f = m.i32(star + STAR.formation) - 1;
            m.setI32(star + STAR.formation, f);
            if (f < 0) m.setI32(star + STAR.formation, 5);
          } else if (hit === 4) {
            const n = m.i32(star + STAR.memberCount);
            if (n < m.i32(star + STAR.maxMechs)) m.setI32(star + STAR.memberCount, n + 1);
          } else {
            const n = m.i32(star + STAR.memberCount);
            if (n > 1) m.setI32(star + STAR.memberCount, n - 1);
          }
          yield* redrawAll();
        }
        break;
      case 6:
      case 7:
      case 8:
        if (mouseLeftClicked(ms) === 1) {
          soundSamplePlay(shell.sound101!);
          for (let k = 0; k < 3; k++) {
            const row = slotAt(m.i32(star + STAR.formation), k);
            if (hit - 6 === m.i32(row + SLOT.panel)) {
              m.setI32(star + STAR.selected, m.i32(row + SLOT.member));
              next = 9;
              m.setI32(SHELL_LABEL.mechlabForMember, 1);
            }
          }
        }
        break;
    }
    if (mouseLeftClicked(ms) === 1) {
      const x = ms.x;
      const y = ms.y;
      for (let k = 0; k < 3; k++) {
        const s = currentStar();
        const row = slotAt(m.i32(s + STAR.formation), k);
        const member = m.i32(row + SLOT.member);
        if (member > m.i32(s + STAR.memberCount)) continue;
        if (member === 0 && career !== 2) continue;
        const p = panelXY(m.i32(row + SLOT.panel));
        if (p.x > x || x >= p.x + 100 || y < p.y || y >= p.y + 10) continue;
        dropLabel(starSelect.panelLabels[k]![0]!);
        const nameAt = starMember(currentStar(), member) + STAR.pilotName;
        m.strcpy(nameAt, (yield* textInput(shell.uiFont!, p.x, p.y, m.cstr(nameAt, 16), null, 0xf, 0x64)).text);
        starSelect.panelLabels[k]![0] = labelCreate(shell.font32!, p.x, p.y, m.cstr(nameAt, 16), null);
        break;
      }
    }
    if (mouseDoubleClicked(ms) !== 0) {
      const s = currentStar();
      let found = -1;
      for (let k = 2; k >= 0; k--) {
        const row = slotAt(m.i32(s + STAR.formation), k);
        const sx = m.i32(row + SLOT.spriteX);
        const sy = m.i32(row + SLOT.spriteY);
        if (sx - 0x32 <= ms.x && ms.x <= sx + 0x32 && sy - 100 <= ms.y && ms.y <= sy) {
          const member = m.i32(row + SLOT.member);
          if (m.i32(starMember(s, member)) >= 0) {
            found = member;
            break;
          }
        }
      }
      if (found >= 0) {
        m.setI32(SHELL_LABEL.mechlabForMember, 1);
        next = 9;
        m.setI32(s + STAR.selected, found);
      }
    }
    if (next === -1) next = yield* shellMenu();
    if (next !== -1) {
      buttonBarDestroy(bar);
      animFreeAll();
      labelsClear(d, 1);
      return next;
    }
  }
}

shellScreens.register(0xd, (l) => screenStarSelect(l.db, l.career.value));
