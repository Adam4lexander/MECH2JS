// The in-game menus, driven through the keyboard driver the way a player
// would: Esc opens the main menu (MENU 4) and pauses the game, digits pick
// items, Esc backs out. Each check is on the game state the menu's callback
// changes - a slider previewed and reverted, then committed into
// mw2snd.cfg's image; a Combat Variables toggle taking the family-0xc0
// scenery out of the world; the user menu's HUD toggle; a lance order
// reaching the lancemate; Abort Mission ejecting the player. The menu's
// background is compared with its SHP walked by the parser.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { parseShapeTable, walkShape } from '../../src/data/formats/shp.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ailTimerService } from '../../src/engine/miles/ail.ts';
import { altRootNode, worldRootNode } from '../../src/engine/scene/objectLists.ts';
import type { UiContext } from '../../src/generated/classes.gen.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { hud } from '../../src/sim/cockpit/hud.ts';
import type { KeyboardDriver } from '../../src/sim/controls/giddi.ts';
import { input } from '../../src/sim/controls/input.ts';
import { defaultCanvas, display } from '../../src/sim/display/video.ts';
import { aiCombatSub0246b0, lanceMechForSlot } from '../../src/sim/groups/orders.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { sound } from '../../src/sim/sound/mixer.ts';
import { lanceMenu } from '../../src/sim/ui/menuCallbacks.ts';
import { ui } from '../../src/sim/ui/uiContext.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;
let kb: KeyboardDriver;

const ESC = 0x01;
const digit = (d: number) => (d === 0 ? 0x0b : d + 1);

function frame(n = 1) {
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 7; i++) ailTimerService();
    mainLoopFrame();
  }
}

/** a key down and up, then two frames: menu_poll_key takes it, the menu acts on it */
function press(scan: number) {
  kb.isr(scan);
  kb.isr(scan | 0x80);
  frame(2);
}

function boot(mission: string) {
  bootMission({ exe, prj, looseFiles: files, mission });
  kb = input.devices[input.keyboardDevice]!.driver as KeyboardDriver;
  frame(60);
}

function ctx(id: number): UiContext {
  let c = ui.uiContextHead;
  while (c && c.id !== id) c = c.next;
  return c!;
}

const top = (id: number) => {
  const r = ctx(id).record!;
  return r.stack![r.depth - 1]!;
};

describe.runIf(hasGameData)('in-game menus', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('Esc opens the main menu over a paused game, drawn on its background, and Esc closes it', () => {
    boot('AMY_SCN1');
    press(ESC);
    const c = ctx(4);
    expect([c.active, ui.gamePaused]).toEqual([1, 1]);
    const m = top(4);
    expect(m.title).toBe('MAIN MENU');
    expect(m.items.slice(0, m.count).map((i) => i.label)).toEqual(['Abort Mission', 'Device Calibration', 'Audio Ctrl', 'Combat Variables', 'Flee to DOS', 'Accept (Esc to cancel)']);
    // the background SHP, drawn at the back pane's origin, where nothing is drawn over it
    const r = c.record!;
    const t = parseShapeTable(prj.readResource('SHP', display.assetVariant + r.backShpId)!);
    const s = t.shapes[0]!;
    const pitch = defaultCanvas.xMax + 1;
    let same = 0;
    let n = 0;
    walkShape(t, 0, (row, x0, count, run, src, at) => {
      for (let i = 0; i < count; i++) {
        const x = r.backPane!.left + s.xmin + x0 + i;
        const y = r.backPane!.top + s.ymin + row;
        if (x > defaultCanvas.xMax || y > defaultCanvas.yMax) continue;
        n++;
        if (defaultCanvas.buffer[y * pitch + x] === (run ? src[at] : src[at + i])) same++;
      }
    });
    // the text and the title rule are drawn over part of it
    expect(same / n).toBeGreaterThan(0.95);
    press(ESC);
    frame(2);
    expect([ctx(4).active, ui.gamePaused, ui.menuOpenCount]).toEqual([0, 0, 0]);
  });

  it('Audio Ctrl: a slider previews and reverts on Esc, and commits into mw2snd.cfg on Accept', () => {
    boot('AMY_SCN1');
    sound.soundConfig[1] = 0x8000;
    sound.soundConfigBuffer![1] = 0x8000;
    press(ESC);
    press(digit(3));
    expect(top(4).title).toBe('SET AUDIO VOLUME');
    // Sound Effects' hotkey steps its slider by 0x199a, previewed at once
    press(digit(2));
    expect(sound.soundConfig[1]).toBe(0x8000 + 0x199a);
    press(ESC);
    expect(sound.soundConfig[1]).toBe(0x8000);
    expect(top(4).title).toBe('MAIN MENU');
    press(digit(3));
    press(digit(2));
    press(digit(0));
    expect(sound.soundConfigBuffer![1]).toBe(0x8000 + 0x199a);
    expect(sound.soundConfig[1]).toBe(0x8000 + 0x199a);
  });

  it('Combat Variables: Object density off takes the family-0xc0 scenery out of the world', () => {
    boot('AMY_SCN1');
    const c0 = (head: { listNext: unknown }) => {
      let k = 0;
      for (let o = head.listNext as { type: number; listNext: unknown } | null; o; o = o.listNext as typeof o) if ((o.type & 0xf0) === 0xc0) k++;
      return k;
    };
    const before = c0(worldRootNode);
    expect(before).toBeGreaterThan(0);
    press(ESC);
    press(digit(4));
    press(digit(4)); // toggled to Low, not yet committed
    expect(c0(worldRootNode)).toBe(before);
    press(digit(0));
    expect(sound.soundConfigBuffer![8]).toBe(0);
    expect(c0(worldRootNode)).toBe(0);
    expect(c0(altRootNode)).toBeGreaterThanOrEqual(before);
  });

  it('the user menu (u) toggles the HUD on its hotkey', () => {
    boot('AMY_SCN1');
    expect(hud.hudEnabled).toBe(1);
    press(0x16); // u
    expect(top(5).title).toBe('SYSTEMS STATUS');
    press(digit(3));
    expect(hud.hudEnabled).toBe(0);
    press(0x16);
    expect(ctx(5).active).toBe(0);
  });

  it('the lance menu (b) orders a lancemate: Command Point 2, Engage at Will', () => {
    boot('BLONSCN1');
    expect(aiCombatSub0246b0()).toBe(2);
    press(0x30); // b
    const m = top(6);
    expect(m.title).toBe('COMMAND COMPUTER');
    expect(m.items.slice(0, m.count).map((i) => i.label)).toEqual(['Change Formation', 'Command Point 2', 'Command All', '(Esc to exit)']);
    press(digit(2));
    const p = top(6);
    expect(p.items.slice(0, p.count).map((i) => i.label)).toEqual(['Status:', 'Attack My Target', 'Defend My Target', 'Join Formation', 'Engage at Will', 'Shutdown', '(Esc to exit)']);
    const mate = mechs.mechTable[lanceMechForSlot(1)]!;
    const engage = mate.engageEnabled;
    press(digit(4)); // past the Status line: the fifth item
    expect(lanceMenu.lanceOrderSelected[1]).toBe(1);
    expect(mate.engageEnabled).not.toBe(engage);
    // the order item backs out to the lance menu
    expect(top(6).title).toBe('COMMAND COMPUTER');
  });

  it('Abort Mission ejects the player and tears every menu down', () => {
    boot('AMY_SCN1');
    const l = mechs.mechTable[mechs.playerMechIndex]!.loadout!;
    press(ESC);
    press(digit(1));
    expect(top(4).items[0]!.label).toBe('Confirmation requested');
    press(digit(1));
    expect(ui.uiContextHead).toBeNull();
    expect(l.status).not.toBe(2);
  });

  it('Flee to DOS sets the exit code flag and ejects', () => {
    boot('AMY_SCN1');
    press(ESC);
    press(digit(5));
    expect(top(4).items[0]!.label).toBe('Confirm your cowardice');
    press(digit(1));
    expect(ui.fleeToDos).toBe(1);
    expect(ui.uiContextHead).toBeNull();
  });
});
