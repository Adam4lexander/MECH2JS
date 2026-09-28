// The screens' button tables as the port reads them from MW2SHELL.EXE,
// printed in dump_shell_buttons.py's format and compared with the block for
// the same screen in listing/screen_buttons.txt. Each table the port reads
// is listed here with the screen whose button_bar_create uses it (the
// listing still names some screens by their first names: screen_quit is the
// register, screen_trials the ready room, screen_pilots the Trial of
// Grievance) and, for a per-career table, the career block it matches.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { buttonDefsAt } from '../../src/shell/ui/buttonBar.ts';
import { screenRowButtonCount, screenRowButtonsAddr } from '../../src/shell/screens/screenRows.ts';
import { expectSameLines } from '../support/listing.ts';
import { gameSource, hasGameData, hasShellData, hasShellDecompiled, readShellListing } from '../support/env.ts';

type Label = keyof typeof SHELL_LABEL;

interface Table {
  screen: string;
  label: Label;
  count: number;
  /** the "career N (...)" block of the listing, for a per-career table */
  career?: number;
  /** the screen's row table, whose row[career] must point at this table with this count */
  rows?: Label;
}

const TABLES: Table[] = [
  { screen: 'screen_title', label: 'titleButtons', count: 4 },
  { screen: 'screen_career', label: 'careerButtonsWolf', count: 5, career: 0, rows: 'careerScreenRows' },
  { screen: 'screen_career', label: 'careerButtonsJadeFalcon', count: 5, career: 1, rows: 'careerScreenRows' },
  { screen: 'screen_quit', label: 'registerButtonsWolf', count: 15, career: 0, rows: 'registerScreenRows' },
  { screen: 'screen_quit', label: 'registerButtonsJadeFalcon', count: 15, career: 1, rows: 'registerScreenRows' },
  { screen: 'screen_trials', label: 'readyRoomButtonsWolf', count: 20, career: 0, rows: 'readyRoomScreenRows' },
  { screen: 'screen_trials', label: 'readyRoomButtonsJadeFalcon', count: 20, career: 1, rows: 'readyRoomScreenRows' },
  { screen: 'screen_training', label: 'trainingButtonsWolf', count: 7, career: 0, rows: 'trainingScreenRows' },
  { screen: 'screen_training', label: 'trainingButtonsJadeFalcon', count: 7, career: 1, rows: 'trainingScreenRows' },
  { screen: 'screen_star_select', label: 'starSelectButtonsWolf', count: 9, career: 0, rows: 'starSelectScreenRows' },
  { screen: 'screen_star_select', label: 'starSelectButtonsJadeFalcon', count: 9, career: 1, rows: 'starSelectScreenRows' },
  { screen: 'screen_pilots', label: 'grievanceButtons', count: 25 },
];

/** The listing's rows for a screen's first table - its career block when `career` is given. */
function listingRows(screen: string, career?: number): { rows: string[]; header: string | null } {
  const lines = readShellListing('screen_buttons.txt').split('\n');
  let at = lines.findIndex((l) => l.startsWith(`${screen}:`));
  let header: string | null = null;
  if (career !== undefined) {
    at = lines.findIndex((l, i) => i > at && l.startsWith(`  career ${career} (`));
    header = lines[at]!;
  }
  const rows: string[] = [];
  for (let i = at + 1; i < lines.length && /^\s+\d+\s/.test(lines[i]!); i++) rows.push(lines[i]!);
  return { rows, header };
}

const p3 = (n: number) => String(n).padStart(3);

describe.runIf(hasGameData && hasShellData && hasShellDecompiled)('shell button tables', () => {
  beforeAll(async () => {
    startShellProcess(ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE')), new ProjectFile(await gameSource().read('MW2.PRJ')));
  });
  for (const t of TABLES) {
    it(`${t.label} matches ${t.screen}${t.career === undefined ? '' : ` career ${t.career}`} in screen_buttons.txt`, () => {
      const got = buttonDefsAt(SHELL_LABEL[t.label], t.count).map((b, i) => {
        const always = b.label !== null && b.label[0] === '<';
        const text = b.label === null ? '' : always ? b.label.slice(1) : b.label;
        return `    ${p3(i).slice(1)}  (${p3(b.x0)},${p3(b.y0)})-(${p3(b.x1)},${p3(b.y1)})  label at (${p3(b.labelX)},${p3(b.labelY)})  ${always ? 'always ' : 'hover  '}'${text}'`;
      });
      const want = listingRows(t.screen, t.career);
      expect(want.rows.length).toBe(t.count);
      if (want.header !== null) expect(want.header).toContain(`${t.count} buttons at ${SHELL_LABEL[t.label].toString(16).padStart(8, '0')}`);
      expectSameLines(t.screen, want.rows, got);
    });
    if (t.rows !== undefined && t.career !== undefined) {
      it(`${t.rows}[${t.career}] points at ${t.label} with ${t.count} buttons`, () => {
        expect(screenRowButtonsAddr(SHELL_LABEL[t.rows!], t.career!)).toBe(SHELL_LABEL[t.label]);
        expect(screenRowButtonCount(SHELL_LABEL[t.rows!], t.career!)).toBe(t.count);
      });
    }
  }
});
