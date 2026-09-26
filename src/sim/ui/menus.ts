/**
 * The in-game menus: the ui context list's open and close (menu_open,
 * menu_close), ui_context_dispatch's per-frame pass, and one menu's frame -
 * its art, then menu_draw, which reads the menu keys, draws the title and
 * the items, runs each item's widget and acts on Enter / Esc - plus the item
 * widgets every menu shares (menu_item_choice, menu_item_toggle,
 * menu_item_slider).
 *
 * A context's id is the MENU it opens: 4 the main menu (Esc - also the
 * pause gate), 5 the user menu (u), 6 the lance menu (b), 7 and 8 the
 * second and third lancemate's orders (Ctrl+F2, Ctrl+F3).
 */
import { mulr16 } from '../../core/int/fx16.ts';
import { cdiv } from '../../core/int/cint.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { stopwatchCreate, stopwatchReset } from '../../engine/timer.ts';
import { vfxCharacterWidth, vfxFontHeight, vfxLineDraw, vfxPaneWipe, vfxShapeBounds, vfxShapeDraw, vfxStringDraw } from '../../engine/vfx/vfx.ts';
import type { Menu, MenuContext, MenuControl, MenuItem, UiContext, ViewWindow } from '../../generated/classes.gen.ts';
import { vfxFontSub013a40 } from '../cockpit/objectivesHud.ts';
import { inputSub048c50, inputSub048c60 } from '../controls/input.ts';
import { vfxPaneFrame } from '../display/layout.ts';
import { display } from '../display/video.ts';
import { radar } from '../cockpit/radar.ts';
import { soundPlayAt } from '../sound/mixer.ts';
import { menuLoad, type MenuListData, type MenuSliderData } from './menuLoad.ts';
import { ui } from './uiContext.ts';

/** the ink byte of the text colour table (0xa4dd2 = 0xa4dc4 + 0xe) */
function ink(c: number): void {
  display.textColourTable[0xe] = c & 0xff;
}

/**
 * @mw2 ui_context_request_open 0x000175d0
 * @fidelity exact
 */
export function uiContextRequestOpen(id: number): number {
  if (ui.menuOpenCount !== 0) return 0;
  let c = ui.uiContextHead;
  while (c && c.id !== id) c = c.next;
  if (!c) return 0;
  c.request = 1;
  return 1;
}

/**
 * Opens a closed menu (when no menu is open) or closes an open one.
 * Returns 1 when the context was closed, whether or not it was opened.
 *
 * @mw2 ui_context_toggle 0x00017610
 * @fidelity exact
 */
export function uiContextToggle(id: number): number {
  const c = uiContextFindNode(id);
  const active = c ? c.active & 0xff : 0;
  if (active === 0) {
    if (ui.menuOpenCount === 0) {
      const n = uiContextFindNode(id);
      if (n) n.request = 1;
    }
    return 1;
  }
  if (active === 1) {
    const n = uiContextFindNode(id);
    if (n) n.request = 0;
  }
  return 0;
}

/**
 * @mw2 ui_context_find 0x00018560
 * @fidelity exact
 */
export function uiContextFindNode(id: number): UiContext | null {
  let c = ui.uiContextHead;
  while (c && c.id !== id) c = c.next;
  return c;
}

/**
 * The per-frame ui step: opens or closes each context whose request differs
 * from its active byte (a failed open is retried next frame), then runs the
 * frame of the first active one - unless it sits out map transitions
 * (flags bit 1) and one is running - closing it when the frame reports its
 * menu stack empty.
 *
 * @mw2 ui_context_dispatch 0x00017ea0
 * @fidelity exact
 */
export function uiContextDispatch(): void {
  for (let c = ui.uiContextHead; c; c = c.next) {
    let active = c.active & 0xff;
    const request = c.request & 0xff;
    if (active !== request) {
      if (request === 1) {
        if (menuOpen(c) !== 0) active = 1;
      } else if (request === 0) {
        menuClose(c);
        active = 0;
      }
    }
    c.active = active;
    c.request = request;
    if (active === 1) {
      if ((c.record!.flags & 2) === 0 || radar.viewportRestorePending === 0) {
        if (menuFrame(c.record!) === 0) c.request = 0;
      }
      return;
    }
  }
}

/**
 * @mw2 menu_open 0x00017b40
 * @fidelity exact
 */
export function menuOpen(node: UiContext): number {
  if (ui.dat000958a4 === -1) ui.dat000958a4 = (stopwatchCreate(0x100) << 16) >> 16;
  stopwatchReset(ui.dat000958a4);
  const ctx = menuLoad(node);
  if (!ctx) return 0;
  ctx.depth = 0;
  if (ctx.depth < 8) {
    ctx.stack![ctx.depth] = ctx.topMenu;
    ctx.depth++;
  }
  ui.menuOpenCount = (ui.menuOpenCount + 1) | 0;
  if ((ctx.flags & 1) !== 0) inputSub048c50();
  return 1;
}

/**
 * @mw2 menu_close 0x00017be0
 * @fidelity exact
 * @divergence the loaded block is dropped rather than freed
 */
export function menuClose(node: UiContext): void {
  const ctx = node.record;
  if (ctx) {
    if (ctx.backShp) {
      cacheUnlock((display.assetVariant + ctx.backShpId) | 0, 'SHP');
      ctx.backShp = null;
    }
    if (ctx.cursorShp) {
      cacheUnlock((display.assetVariant + ctx.cursorShpId) | 0, 'SHP');
      ctx.cursorShp = null;
    }
    if (ctx.font) {
      cacheUnlock((display.assetVariant + ctx.fontId) | 0, 'FONT');
      ctx.font = null;
    }
    if ((ctx.flags & 1) !== 0) inputSub048c60();
  }
  node.module = null;
  node.record = null;
  ui.menuOpenCount = (ui.menuOpenCount - 1) | 0;
}

/**
 * Every context closed and the list emptied.
 *
 * @mw2 ui_context_clear_all 0x000176e0
 * @fidelity exact
 */
export function uiContextClearAll(): void {
  for (let c = ui.uiContextHead; c; c = c.next) menuClose(c);
  ui.uiContextHead = null;
  ui.uiContextTail = null;
}

/**
 * @mw2 menu_load_art 0x00017aa0
 * @fidelity exact
 */
export function menuLoadArt(ctx: MenuContext): void {
  ctx.backShp = ctx.backShpId === -1 ? null : cacheLoadResource((display.assetVariant + ctx.backShpId) | 0, 'SHP');
  ctx.cursorShp = ctx.cursorShpId === -1 ? null : cacheLoadResource((display.assetVariant + ctx.cursorShpId) | 0, 'SHP');
  ctx.font = cacheLoadResource((display.assetVariant + ctx.fontId) | 0, 'FONT');
}

/**
 * One frame of an open menu. Returns 0 once its menu stack is empty.
 *
 * @mw2 menu_frame 0x00017f30
 * @fidelity exact
 */
export function menuFrame(ctx: MenuContext): number {
  const pane = ctx.pane;
  if (!pane) return 0;
  const back = ctx.backPane;
  if (!back) return 0;
  menuLoadArt(ctx);
  if ((ctx.flags & 0x20) !== 0) vfxPaneWipe(pane, 0);
  if (ctx.backShp) vfxShapeDraw(back, ctx.backShp, 0, 0, 0);
  if ((ctx.flags & 4) !== 0) vfxPaneFrame(pane, 1);
  menuDraw(ctx);
  return ctx.depth !== 0 ? 1 : 0;
}

/**
 * Enter, Esc and the moves: Esc backs out (state 5); Tab and 0x97 move down,
 * 0x96 and 0x209 up; Enter enters a type 0 item's submenu (3), accepts on a
 * type 2 (4) and backs out on a type 5 or 6 (5).
 *
 * @mw2 menu_key_action 0x00017fd0
 * @fidelity exact
 */
export function menuKeyAction(key: number, itemType: number, menu: Menu, dir: { value: number }): void {
  key >>>= 0;
  if (key === 0x1b) menu.state = 5;
  else if (key === 9 || key === 0x97) dir.value = 1;
  else if (key === 0x96 || key === 0x209) dir.value = -1;
  else if (key === 0xd) {
    const t = itemType & 0xff;
    if (t === 0) menu.state = 3;
    else if (t === 2) menu.state = 4;
    else if (t === 5 || t === 6) menu.state = 5;
  }
}

/** vfx_font_sub_013a40's twin for the title rule: a line across the pane under the text at y. */
function paneRuleUnderText(pane: ViewWindow, _x: number, y: number, font: Uint8Array, colour: number): void {
  const yy = (y + vfxFontHeight(font)) | 0;
  vfxLineDraw(pane, 0, yy, (pane.right - pane.left) | 0, yy, 0, colour);
}
registerCode('pane_rule_under_text', 0x139f0, paneRuleUnderText);

/**
 * @mw2 pane_rule_under_text 0x000139f0
 * @fidelity exact
 */
export function paneRuleUnderTextDraw(pane: ViewWindow, x: number, y: number, font: Uint8Array, colour: number): void {
  paneRuleUnderText(pane, x, y, font, colour);
}

/** clib_sub_0626ab(value, buf, 10): the decimal digits of a non-negative int. */
function itoa10(v: number): string {
  return String(v | 0);
}

/**
 * The menu on top of the stack: keys, then the title and every item with
 * its number, label and widget, then the state the keys set - enter a
 * submenu (3), or pop the menu (4 accept, 5 back).
 *
 * @mw2 menu_draw 0x00018040
 * @fidelity exact
 */
export function menuDraw(ctx: MenuContext): void {
  const font = ctx.font;
  if (!font) return;
  const menu = ctx.depth > 0 ? ctx.stack![ctx.depth - 1]! : null;
  if (!menu) return;
  const pane = ctx.pane;
  if (!pane) return;
  let sel = menu.selected;
  let exitIdx = -1;
  let hasInfo = 0;
  let infoIdx = 0x10;
  for (let i = 0; i < menu.count; i++) {
    const t = menu.items[i]!.type;
    if (t === 2 || t === 6) exitIdx = i;
    if (t === 3) {
      hasInfo = 1;
      infoIdx = i;
    }
  }
  if (exitIdx === -1) hasInfo = 0;
  const dir = { value: 0 };
  // the key menu_key_action is given (ESI): loaded only when a key is taken
  let key: number | null = null;
  if (menu.state === 0) menu.state = 1;
  else {
    if (menu.state === 1) menu.state = 2;
    const k = ui.menuKeyPending;
    if (k !== 0) {
      key = k;
      if (k >= 0x30 && k <= 0x39) {
        const n = k - 0x30;
        if (n === 0) {
          if (exitIdx !== -1) {
            key = 0xd;
            sel = exitIdx;
          }
        } else if (n >= 1 && n < menu.count - hasInfo) {
          if (n <= infoIdx) sel = n - 1;
          else {
            sel = n;
            ui.menuKeyPending = k + 1 > 0x39 ? 0x30 : k + 1;
          }
          key = 0xd;
        }
      }
      menuKeyAction(key, menu.items[sel]!.type, menu, dir);
      if (dir.value !== 0) sel = (sel + dir.value + menu.count) % menu.count;
      if (sel !== menu.selected && ctx.moveSound !== -1) soundPlayAt(0, 0, 0, ctx.moveSound, 0);
    }
  }
  if (dir.value === 0) dir.value = 1;
  if (menu.items[sel]!.type === 3) {
    sel = (sel + dir.value + menu.count) % menu.count;
    const k = ui.menuKeyPending;
    if (k >= 0x30 && k <= 0x39) {
      ui.menuKeyPending = k + 1 > 0x39 ? 0x30 : k + 1;
      if (key === null) {
        quirk('menu_draw: a digit on a menu\'s first frame reaches menu_key_action through the caller\'s ESI; taken as the digit', 'menu_draw');
        key = k;
      }
      menuKeyAction(key, menu.items[sel]!.type, menu, dir);
      if (dir.value === 0) dir.value = 1;
    }
  }
  menu.selected = sel;
  ink(ctx.ink);
  let tx = 0;
  let ty = 0;
  if (menu.title !== null) {
    tx = ctx.titleX;
    ty = ctx.titleY;
    vfxStringDraw(pane, tx, ty, font, menu.title, display.textColourTable);
  }
  if (menu.title === null) unestablished('menu_draw: a menu without a title underlines at uninitialised coordinates', 'menu_draw');
  else if ((ctx.flags & 4) !== 0) paneRuleUnderText(pane, tx, ty, font, 1);
  else vfxFontSub013a40(pane, menu.title, tx, ty, font, 1);
  const half = cdiv(vfxFontHeight(font), 2);
  const cursor = [ctx.cursorX, (ctx.cursorY + half) | 0];
  const text = [ctx.textX, ctx.textY];
  const widget = [ctx.widgetX, ctx.widgetY];
  const numWidth = (vfxCharacterWidth(font, 0x30) * 2 + vfxCharacterWidth(font, 0x2e)) | 0;
  let add = 0;
  let number = 0;
  for (let i = 0; i < menu.count; i++) {
    ink(i === sel ? ctx.selectedInk : ctx.ink);
    const it = menu.items[i]!;
    if ((ctx.flags & 8) === 0 && i === exitIdx) add = (add + Math.imul((ctx.rows - i - 1) | 0, ctx.rowHeight)) | 0;
    text[1] = (text[1]! + add) | 0;
    widget[1] = (widget[1]! + add) | 0;
    cursor[1] = (cursor[1]! + add) | 0;
    add = ctx.rowHeight;
    if (i === sel && ctx.cursorShp) vfxShapeDraw(pane, ctx.cursorShp, 0, cursor[0]!, cursor[1]!);
    if (it.type !== 3) {
      number = i === exitIdx ? 0 : number + 1;
      vfxStringDraw(pane, text[0]!, text[1]!, font, itoa10(number), display.textColourTable);
    }
    if (it.label !== null) vfxStringDraw(pane, (text[0]! + numWidth) | 0, text[1]!, font, it.label, display.textColourTable);
    if (it.draw) it.draw(ctx, it.control, i, it, widget[0]!, widget[1]!, menu);
  }
  ink(0xe);
  const state = menu.state;
  if (state === 3) {
    menu.state = 2;
    const sub = menu.items[sel]!.submenu;
    if (!sub) return;
    if (ctx.depth < 8) {
      ctx.stack![ctx.depth] = sub;
      ctx.depth++;
    }
    if (ctx.enterSound !== -1) soundPlayAt(0, 0, 0, ctx.enterSound, 0);
  } else if (state === 4 || state === 5) {
    menu.state = 0;
    menu.selected = 0;
    if (ctx.depth > 0) ctx.depth--;
  }
}

/** The value a widget shows: get(selector) when flags bit 0 and get is set, else the cached value. */
function controlValue(c: MenuControl): number {
  return (c.flags & 1) !== 0 && c.get ? (c.get(c.selector) as number) | 0 : c.value;
}

/**
 * menuItemDrawFns[1]: the control's value picks a string of its list,
 * with the suffix callback's text appended; drawn at the widget point.
 * State 1 runs init and reads the value again, 4 commits, 5 reverts; the
 * selected item commits on its hotkey (type 5) and previews otherwise.
 *
 * @mw2 menu_item_choice 0x00018ac0
 * @fidelity exact
 */
export const menuItemChoice = registerCode('menu_item_choice', 0x18ac0, (ctx: MenuContext, c: MenuControl | null, index: number, _item: MenuItem, x: number, y: number, menu: Menu | null): void => {
  if (!ctx || !ctx.font || !menu) return;
  const state = menu.state;
  const pane = ctx.pane;
  if (!pane || !c || !c.data) return;
  const hotkey = ui.menuKeyPending - 0x31 === index;
  let value = controlValue(c);
  const selected = index === menu.selected;
  let preview = true;
  if (state === 1) {
    c.init?.(menu, c);
    if (c.get) {
      value = (c.get(c.selector) as number) | 0;
      c.value = value;
    } else {
      c.value = 0;
      value = 0;
    }
  } else if (state === 4) {
    c.commit?.(c.selector, value);
    preview = false;
  } else if (state === 5) {
    c.revert?.(c.selector);
    preview = false;
  }
  const d = c.data as MenuListData;
  if (0 < d.count) {
    value = (value + d.count) % d.count;
    let s = (d.strings[value] ?? '').slice(0, 0x7f);
    if (d.suffix) {
      const extra = d.suffix(ctx, c, index, d, x, y, menu) as string | null;
      if (extra !== null) s = (s + extra).slice(0, 0x7f);
    }
    vfxStringDraw(pane, x, y, ctx.font, s, display.textColourTable);
  }
  if (selected) {
    if (hotkey && menu.items[index]!.type === 5) c.commit?.(c.selector, value);
    if (c.preview && preview) c.preview(c.selector, value);
  }
  c.value = value;
});

/**
 * menuItemDrawFns[2]: a value stepped through its list - +1 on Space, 0x98
 * or the item's hotkey, -1 on 0x99 - committed on a step for type 4 and
 * on the hotkey for type 5, previewed while selected.
 *
 * @mw2 menu_item_toggle 0x00018d00
 * @fidelity exact
 */
export const menuItemToggle = registerCode('menu_item_toggle', 0x18d00, (ctx: MenuContext, c: MenuControl | null, index: number, _item: MenuItem, x: number, y: number, menu: Menu | null): void => {
  if (!ctx || !ctx.font || !menu) return;
  const state = menu.state;
  const pane = ctx.pane;
  if (!pane || !c || !c.data) return;
  const hotkey = ui.menuKeyPending - 0x31 === index;
  let value = controlValue(c);
  const selected = menu.selected;
  let step = 0;
  let preview = true;
  if (state === 1) {
    c.init?.(menu, c);
    if (c.get) {
      value = (c.get(c.selector) as number) | 0;
      c.value = value;
    } else {
      c.value = 0;
      value = 0;
    }
  } else if (state === 2) {
    if (index === selected) {
      const k = ui.menuKeyPending >>> 0;
      if (k === 0x99) step = -1;
      else if (k === 0x20 || k === 0x98 || hotkey) step = 1;
    }
  } else if (state === 4) {
    c.commit?.(c.selector, value);
    preview = false;
  } else if (state === 5) {
    c.revert?.(c.selector);
    preview = false;
  }
  const d = c.data as MenuListData;
  if (0 < d.count) {
    value = (step + value + d.count) % d.count;
    vfxStringDraw(pane, x, y, ctx.font, d.strings[value] ?? '', display.textColourTable);
  }
  if (index === selected) {
    const t = menu.items[index]!.type;
    if (((step !== 0 && t === 4) || (hotkey && t === 5)) && c.commit) c.commit(c.selector, value);
    if (c.preview && preview) c.preview(c.selector, value);
  }
  c.value = value;
});

/**
 * menuItemDrawFns[3]: a slider 0..1.0 (16.16), stepped by 0x199a (10%) on
 * the same keys as menu_item_toggle and drawn from four shapes: the left
 * end, the track, the right end and the knob, placed along the track by
 * the value. Commit and preview as menu_item_toggle.
 *
 * @mw2 menu_item_slider 0x000186e0
 * @fidelity exact
 */
export const menuItemSlider = registerCode('menu_item_slider', 0x186e0, (ctx: MenuContext, c: MenuControl | null, index: number, _item: MenuItem, x: number, y: number, menu: Menu | null): void => {
  if (!ctx || !ctx.font || !menu) return;
  const font = ctx.font;
  const pane = ctx.pane;
  const state = menu.state;
  if (!pane || !c || !c.data) return;
  const ids = (c.data as MenuSliderData).ids;
  const hotkey = ui.menuKeyPending - 0x31 === index;
  let value = controlValue(c);
  const selected = menu.selected;
  let step = 0;
  let preview = true;
  if (state === 1) {
    c.init?.(menu, c);
    value = c.get ? (c.get(c.selector) as number) | 0 : 0;
    c.value = value;
  } else if (state === 2) {
    if (index === selected) {
      const k = ui.menuKeyPending >>> 0;
      if (k === 0x99) step = -0x199a;
      else if (k === 0x20 || k === 0x98 || hotkey) step = 0x199a;
    }
  } else if (state === 4) {
    c.commit?.(c.selector, value);
    preview = false;
  } else if (state === 5) {
    c.revert?.(c.selector);
    preview = false;
  }
  const av = display.assetVariant;
  const left = cacheLoadResource((av + ids[0]!) | 0, 'SHP');
  const track = cacheLoadResource((av + ids[2]!) | 0, 'SHP');
  const knob = cacheLoadResource((av + ids[6]!) | 0, 'SHP');
  const right = cacheLoadResource((av + ids[4]!) | 0, 'SHP');
  if (track && knob) {
    const tb = vfxShapeBounds(track, 0);
    value = (value + step) | 0;
    if (value < 0) value = 0;
    if (0x10000 < value) value = 0x10000;
    const yy = (y + cdiv(vfxFontHeight(font), 2)) | 0;
    let tx = x;
    if (left) {
      vfxShapeDraw(pane, left, 0, x, yy);
      tx = (x + (vfxShapeBounds(left, 0) >> 16)) | 0;
    }
    vfxShapeDraw(pane, track, 0, tx, yy);
    if (right) vfxShapeDraw(pane, right, 0, (tx + (tb >> 16)) | 0, yy);
    const kb = vfxShapeBounds(knob, 0);
    vfxShapeDraw(pane, knob, 0, ((tx + mulr16(value, tb >> 16)) | 0) - cdiv(kb >> 16, 2), yy);
    if (index === selected) {
      const t = menu.items[index]!.type;
      if (((step !== 0 && t === 4) || (hotkey && t === 5)) && c.commit) c.commit(c.selector, value);
      if (c.preview && preview) c.preview(c.selector, value);
    }
  }
  c.value = value;
  cacheUnlock((av + ids[0]!) | 0, 'SHP');
  cacheUnlock((av + ids[2]!) | 0, 'SHP');
  cacheUnlock((av + ids[4]!) | 0, 'SHP');
  cacheUnlock((av + ids[6]!) | 0, 'SHP');
});
