/**
 * HALL OF HONOR, item 3 of shell_menu: the registered pilots ranked over
 * the amwlogo1 loop (decompiled/mw2shell/src/screens/stats.c).
 */
import { SHELL_LABEL } from '../../generated/shell/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { watcomQsort } from '../../engine/qsort.ts';
import { driver, mouse, shell } from '../state.ts';
import { fieldOffset, mem } from '../memory.ts';
import type { Blocking } from '../host/blocking.ts';
import { screenPaintPicture } from '../video/background.ts';
import { screenDrawText } from '../video/driver.ts';
import { BackgroundMovie, movieBackgroundClose, movieBackgroundStep, movieOpenBackground } from '../anim/movies.ts';
import { inputFlush, inputPollKey } from '../ui/keys.ts';
import { mouseLeftClicked, mouseRightClicked, mouseUpdate } from '../ui/mouse.ts';
import { menuScreens } from '../ui/menuScreens.ts';
import { PILOT_COUNT, pilotRecord } from '../career/registry.ts';

const field = (at: number, name: string): number => mem().i32(at + fieldOffset('PilotRecord', name));

/**
 * qsort's comparison over two pilot records: higher rank first, then
 * higher careerHonor, then higher missionIndex; 0 when all three tie.
 *
 * @mw2shell hall_of_honor_compare 0x000281e0
 * @fidelity exact
 */
export function hallOfHonorCompare(a: number, b: number): number {
  for (const f of ['rank', 'careerHonor', 'missionIndex']) {
    if (field(b, f) < field(a, f)) return -1;
    if (field(a, f) < field(b, f)) return 1;
  }
  return 0;
}

/** careerMissionTables[career][index].title: 9-byte rows, the title pointer at +5. @portOnly */
function missionTitle(career: number, index: number): string | null {
  const m = mem();
  return m.ptrStr(m.u32(SHELL_LABEL.careerMissionTables + career * 4) + index * 9 + 5);
}

/**
 * DATABASE picture 2 painted over the screen; the erase fill turned off;
 * the amwlogo1 loop at (120, 4). The 20 registry records sorted by
 * hall_of_honor_compare (Watcom's qsort, which orders ties its own way),
 * the header row at y 150 in font28 - Pilot 0, Clan 125, Rank 200, Honor
 * 325, Kills 400, Hit % 460, Last Mission 520 - and the first 8 sorted
 * records that are in use from y 182, 16 apart, in the UI font: name,
 * clanNames[career], rankTitles[rank], careerHonor, killTally,
 * enemyMechHits * 100 / shotsFired as '%d%%' ('-' before any shot), and
 * the title of mission missionIndex - 1 ('----' at 0). Then the movie runs
 * until a click, right click or key.
 *
 * @mw2shell hall_of_honor_screen 0x00028250
 * @fidelity exact
 */
export function* hallOfHonorScreen(): Blocking<void> {
  const d = driver();
  const m = mem();
  inputFlush(shell.keyInput!);
  screenPaintPicture(d, 2);
  d.fillColour = 0;
  // 0x75d68 'amwlogo1'
  const movie = yield* movieOpenBackground(new BackgroundMovie(), m.cstr(0x75d68), 0x78, 4);
  const order = Array.from({ length: PILOT_COUNT }, (_, i) => pilotRecord(i));
  watcomQsort(order, hallOfHonorCompare);
  const head = shell.font28!.drawFont;
  // 'Pilot' 'Clan' 'Rank' 'Honor' 'Kills' 'Hit %' 'Last Mission'
  const heads: [number, number][] = [[0, 0x75d71], [0x7d, 0x75d77], [200, 0x75d7c], [0x145, 0x75d81], [400, 0x75d87], [0x1cc, 0x75d8d], [0x208, 0x75d93]];
  for (const [x, s] of heads) screenDrawText(d, x, 0x96, head, m.cstr(s));
  const font = shell.uiFont!.drawFont;
  let y = 0xb6;
  for (let k = 0; k < 8; k++) {
    const p = order[k]!;
    if (field(p, 'inUse') === 0) continue;
    const career = field(p, 'career');
    screenDrawText(d, 0, y, font, m.cstr(p + fieldOffset('PilotRecord', 'pilotName'), 16));
    screenDrawText(d, 0x7d, y, font, m.ptrStr(SHELL_LABEL.clanNames + career * 4));
    screenDrawText(d, 200, y, font, m.ptrStr(SHELL_LABEL.rankTitles + field(p, 'rank') * 4));
    // 0x75da0, 0x75da3 '%d'
    screenDrawText(d, 0x145, y, font, String(field(p, 'careerHonor')));
    screenDrawText(d, 400, y, font, String(field(p, 'killTally')));
    const shots = field(p, 'shotsFired');
    // 0x75dab '-', 0x75da6 '%d%%'
    screenDrawText(d, 0x1cc, y, font, shots === 0 ? m.cstr(0x75dab) : `${cdiv(Math.imul(field(p, 'enemyMechHits'), 100), shots)}%`);
    const mission = field(p, 'missionIndex');
    // 0x75dad '----'
    screenDrawText(d, 0x208, y, font, mission === 0 ? m.cstr(0x75dad) : missionTitle(career, mission - 1));
    y += 0x10;
  }
  for (;;) {
    movieBackgroundStep(movie);
    yield* mouseUpdate(mouse());
    if (mouseRightClicked(mouse()) === 1 || mouseLeftClicked(mouse()) === 1 || inputPollKey(shell.keyInput!) !== 0) break;
  }
  movieBackgroundClose(movie);
  d.fillColour = -1;
}

menuScreens.register(3, hallOfHonorScreen);
