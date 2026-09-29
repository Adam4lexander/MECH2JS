// The Clan archive's pages as archive_page_load reads them (the port's
// archiveReadOp), every text block laid out by the port's text_layout_page.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { mpackDbGetItem, mpackDbOpen, mpackDbReadString, type MPackDb } from '../../src/data/formats/mpack.ts';
import { startShellProcess } from '../../src/shell/boot.ts';
import { archiveReadOp } from '../../src/shell/archive/viewer.ts';
import { Page, pageInit, textLayoutPage } from '../../src/shell/text/page.ts';
import { FontHolder, fontHolderInit } from '../../src/shell/ui/labels.ts';
import { VideoDriver } from '../../src/shell/video/driver.ts';
import { gameSource, hasGameData, hasShellData } from '../support/env.ts';

interface ParsedPage {
  title: string;
  end: number;
  blocks: Array<{ op: number; lines?: string[] }>;
}

/** The page as archive_page_load walks it, or null for an item that does not start 0x0100. */
function parsePage(db: MPackDb, id: number): ParsedPage | null {
  const item = mpackDbGetItem(db, id)!;
  if ((item[0]! | (item[1]! << 8)) !== 0x0100) return null;
  const title = mpackDbReadString(db, id, 2)!;
  let offset = 2 + title.length + 1;
  const blocks: ParsedPage['blocks'] = [];
  for (;;) {
    const rec = archiveReadOp(db, id, offset);
    offset = rec.next;
    if (rec.op === 0xff00) return { title, end: offset, blocks };
    if (rec.op !== 0x0200 && rec.op !== 0x0300 && rec.op !== 0x0400) throw new Error(`item ${id}: opcode 0x${rec.op.toString(16)}`);
    blocks.push({ op: rec.op, lines: 'lines' in rec ? rec.lines : undefined });
  }
}

describe.runIf(hasGameData && hasShellData)('the Clan archive pages', () => {
  const archives: Record<string, MPackDb> = {};
  let font: FontHolder;
  beforeAll(async () => {
    const exe = ExeImage.fromExe(await gameSource().read('MW2SHELL.EXE'));
    const prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    startShellProcess(exe, prj);
    for (const name of ['ARCHWO.MW2', 'ARCHJF.MW2']) archives[name] = mpackDbOpen(name, await gameSource().read(name));
    const database = mpackDbOpen('DATABASE.MW2', await gameSource().read('DATABASE.MW2'));
    // main's archiveFont: DATABASE.MW2 item 0x20
    font = fontHolderInit(new FontHolder(), mpackDbGetItem(database, 0x20)!, new VideoDriver());
  });

  it('every text block lays out into the archive box, each \\A region naming a link of its page', () => {
    for (const db of Object.values(archives)) {
      for (let id = 1; id <= db.count; id++) {
        const p = parsePage(db, id);
        if (!p) continue;
        const links = p.blocks.filter((b) => b.op === 0x400).length;
        for (const b of p.blocks) {
          if (b.op !== 0x200) continue;
          // the lines joined as archive_page_load joins them, the last keeping its space (no lines: "")
          const text = b.lines!.length ? b.lines!.join('') + ' ' : '';
          let rest: string | null = text;
          let pages = 0;
          do {
            const page = pageInit(new Page(), font, font.driver!, null, 0x58, 0x46, 0x1d2, 0xde);
            rest = textLayoutPage(page, rest);
            pages++;
            for (const r of page.regions) expect(r.id, `${db.path} item ${id}: region ${r.id} of ${links} links`).toBeLessThan(links);
            for (const l of page.lines) expect(l.y + l.height).toBeLessThanOrEqual(0x46 + 0xde + font.height + 2);
            expect(pages).toBeLessThan(1000);
          } while (rest !== null);
        }
      }
    }
  });

  it("the home page's first line and its topic regions", () => {
    const db = archives['ARCHWO.MW2']!;
    const p = parsePage(db, 1)!;
    const page = pageInit(new Page(), font, font.driver!, null, 0x58, 0x46, 0x1d2, 0xde);
    expect(textLayoutPage(page, p.blocks.find((b) => b.op === 0x200)!.lines!.join('') + ' ')).toBeNull();
    // 'Socket:' then two \t codes: the next word carries them as "\t\t" for the label to move its pen
    expect(page.lines[0]!.text).toBe('Socket:\\t\\tFive');
    // "1. \t\a00The \a00Clans" ... "3. \t\a02Clan \a02Wolf" ... "5. \t\a03Personalities"
    expect(page.regions.map((r) => r.id)).toEqual(expect.arrayContaining([0, 2, 3]));
  });
});
