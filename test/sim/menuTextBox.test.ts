// MW2.EXE's MENU 3: the credits pages, each a menu_item_text_box drawing its
// control's text word-wrapped into its own pane inside the menu's.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { UiContext } from '../../src/generated/classes.gen.ts';
import { bootMission } from '../../src/mission/load.ts';
import { defaultCanvas } from '../../src/sim/display/video.ts';
import { menuLoad, type MenuPanesData } from '../../src/sim/ui/menuLoad.ts';
import { menuItemTextBox, menuLoadArt } from '../../src/sim/ui/menus.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

describe.runIf(hasGameData)('menu_item_text_box', () => {
  let exe: ExeImage;
  let prj: ProjectFile;
  beforeAll(async () => {
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
  });

  it('draws each credits page inside its pane', () => {
    bootMission({ exe, prj, looseFiles: installFiles(), mission: 'AMY_SCN1' });
    const node = new UiContext();
    node.id = 3;
    const ctx = menuLoad(node)!;
    expect(ctx).not.toBeNull();
    menuLoadArt(ctx);
    const top = ctx.topMenu!;
    let pages = 0;
    for (let i = 0; i < top.count; i++) {
      const page = top.items[i]!.submenu;
      const it = page?.items[0];
      if (!it || it.draw !== menuItemTextBox) continue;
      const d = it.control!.data as MenuPanesData;
      expect(d.text?.length ?? 0).toBeGreaterThan(0);
      defaultCanvas.buffer.fill(0);
      it.draw(ctx, it.control, 0, it, 0, 0, page);
      const box = d.pane0!;
      expect(box.canvas).toBe(defaultCanvas);
      const w = defaultCanvas.xMax + 1;
      let inside = 0;
      let outside = 0;
      for (let y = 0; y <= defaultCanvas.yMax; y++)
        for (let x = 0; x < w; x++) {
          if (defaultCanvas.buffer[y * w + x] === 0) continue;
          if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) inside++;
          else outside++;
        }
      expect(inside).toBeGreaterThan(50);
      expect(outside).toBe(0);
      pages++;
    }
    expect(pages).toBe(14);
  });
});
