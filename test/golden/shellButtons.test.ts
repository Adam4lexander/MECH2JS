// The screens' button tables as the port reads them from MW2SHELL.EXE,
// printed in dump_shell_buttons.py's format and compared with the block for
// the same screen in listing/screen_buttons.txt. Each table the port reads
// is listed here with the screen whose button_bar_create uses it.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { SHELL_LABEL } from '../../src/generated/shell/labels.gen.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { buttonDefsAt } from '../../src/shell/ui/buttonBar.ts';
import { expectSameLines } from '../support/listing.ts';
import { gameSource, hasGameData, hasShellData, hasShellDecompiled, readShellListing } from '../support/env.ts';

const TABLES: Array<{ screen: string; label: keyof typeof SHELL_LABEL; count: number }> = [{ screen: 'screen_title', label: 'titleButtons', count: 4 }];

/** The listing's rows for one screen's first table. */
function listingRows(screen: string): string[] {
  const lines = readShellListing('screen_buttons.txt').split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${screen}:`));
  const out: string[] = [];
  for (let i = at + 1; i < lines.length && /^\s+\d+\s/.test(lines[i]!); i++) out.push(lines[i]!);
  return out;
}

const p3 = (n: number) => String(n).padStart(3);

describe.runIf(hasGameData && hasShellData && hasShellDecompiled)('shell button tables', () => {
  beforeAll(async () => {
    startShellProcess(ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE')), new ProjectFile(await gameSource().read('MW2.PRJ')));
  });
  for (const t of TABLES) {
    it(`${t.label} matches ${t.screen} in screen_buttons.txt`, () => {
      const got = buttonDefsAt(SHELL_LABEL[t.label], t.count).map((b, i) => {
        const always = b.label !== null && b.label[0] === '<';
        const text = b.label === null ? '' : always ? b.label.slice(1) : b.label;
        return `    ${p3(i).slice(1)}  (${p3(b.x0)},${p3(b.y0)})-(${p3(b.x1)},${p3(b.y1)})  label at (${p3(b.labelX)},${p3(b.labelY)})  ${always ? 'always' : 'hover'}  '${text}'`;
      });
      const want = listingRows(t.screen);
      expect(want.length).toBe(t.count);
      expectSameLines(t.screen, want, got);
    });
  }
});
