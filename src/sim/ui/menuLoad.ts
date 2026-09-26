/**
 * Loading an in-game menu: a MENU resource is an LX module (lx_module_load)
 * whose first dword points at its MenuContext - two panes, the art and font,
 * the layout points and the top menu - and the menus, items and controls it
 * links. menu_load runs on every open, so every menu starts over from the
 * resource.
 *
 * The port reads the module into live objects (the generated MenuContext,
 * Menu, MenuItem, MenuControl): a dword is a pointer exactly where the
 * loader wrote a relocation, and a record reached twice (a control shared by
 * two items) is the same object. The callback fields hold the module's table
 * indices until menu_resolve_callbacks turns them into the EXE's code
 * pointers - here, the ported functions registered at those addresses.
 *
 * A control's data record (+8) has no type of its own: each item widget
 * reads it its own way, so the port gives it the shape of the widget that
 * reads it (MenuListData, MenuSliderData, MenuPanesData).
 */
import { unestablished } from '../../core/provenance.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { lxModuleLoad, MENU_TABLES, type MenuTableKind } from '../../data/exe/tables/menus.ts';
import { resolveCode, type CodeFn } from '../../engine/codePtr.ts';
import { imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { vfxShapeBounds } from '../../engine/vfx/vfx.ts';
import { Menu, MenuContext, MenuControl, MenuItem, ViewWindow, type UiContext } from '../../generated/classes.gen.ts';
import { layoutPaneScaleAboutCentre, layoutPaneToWindow, layoutPointInPane } from '../display/layout.ts';
import { defaultCanvas, display } from '../display/video.ts';

/** menu_item_choice / menu_item_toggle's data: {suffix callback, count, strings[count]}. @portOnly */
export interface MenuListData {
  kind: 'list';
  /** +0: menu_item_choice appends what it returns (lance_status_init sets it) */
  suffix: CodeFn | null;
  /** +4 */
  count: number;
  /** +8.. */
  strings: (string | null)[];
}

/** menu_item_slider's data: SHP ids, [0], [2], [4] and [6] read. @portOnly */
export interface MenuSliderData {
  kind: 'slider';
  ids: Int32Array;
}

/** menu_item_calibrate's and menu_item_text_box's data: two panes, a word, a device record or text. @portOnly */
export interface MenuPanesData {
  kind: 'panes';
  /** +0 */
  pane0: ViewWindow | null;
  /** +4: menu_item_text_box's text; menu_item_calibrate's second pane */
  pane1: ViewWindow | null;
  text: string | null;
  /** +8 */
  word2: number;
  /** +0xc: menu_calibration_onload stores the device here */
  device: unknown;
}

export type MenuControlData = MenuListData | MenuSliderData | MenuPanesData;

/** The loaded module: its block, and each record's still-unresolved table indices. @portOnly */
export interface MenuModule {
  block: Uint8Array;
  indices: Map<object, Partial<Record<MenuTableKind, number>>>;
}

/** draw indices whose control data is a list, a slider, panes (menuItemDrawFns, listing/menus.txt) */
const LIST_DRAWS = new Set([1, 2]);
const SLIDER_DRAWS = new Set([3]);
const PANES_DRAWS = new Set([4, 5]);

/** Reads MENU module `block` (relocations in `fixups`) into objects. @portOnly the data half of menu_load */
function readModule(block: Uint8Array, fixups: Map<number, number>): { ctx: MenuContext | null; module: MenuModule } {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const i32 = (o: number) => (o + 4 <= block.length ? dv.getInt32(o, true) : 0);
  const ptr = (o: number): number | null => fixups.get(o) ?? null;
  const text = (o: number): string | null => {
    const t = ptr(o);
    if (t === null) return null;
    let s = '';
    for (let i = t; i < block.length && block[i] !== 0; i++) s += String.fromCharCode(block[i]!);
    return s;
  };
  const module: MenuModule = { block, indices: new Map() };
  const panes = new Map<number, ViewWindow>();
  const pane = (o: number): ViewWindow | null => {
    const t = ptr(o);
    if (t === null) return null;
    let w = panes.get(t);
    if (!w) {
      w = new ViewWindow();
      w.canvas = null;
      w.left = i32(t + 4);
      w.top = i32(t + 8);
      w.right = i32(t + 0xc);
      w.bottom = i32(t + 0x10);
      panes.set(t, w);
    }
    return w;
  };
  const menus = new Map<number, Menu>();
  const controls = new Map<number, MenuControl>();
  const control = (o: number, draw: number): MenuControl | null => {
    const t = ptr(o);
    if (t === null) return null;
    let c = controls.get(t);
    if (c) return c;
    c = new MenuControl();
    c.flags = block[t]!;
    c.value = i32(t + 4);
    c.selector = i32(t + 0xc);
    module.indices.set(c, { init: i32(t + 0x10), get: i32(t + 0x14), preview: i32(t + 0x18), commit: i32(t + 0x1c), revert: i32(t + 0x20) });
    const d = ptr(t + 8);
    if (d !== null) {
      if (LIST_DRAWS.has(draw)) {
        const n = i32(d + 4);
        const strings: (string | null)[] = [];
        for (let k = 0; k < Math.max(0, n); k++) strings.push(text(d + 8 + k * 4));
        c.data = { kind: 'list', suffix: null, count: n, strings } satisfies MenuListData;
        if (i32(d) !== 0) unestablished('menu control data: a list with a suffix callback in the module', 'menu_load');
      } else if (SLIDER_DRAWS.has(draw)) {
        c.data = { kind: 'slider', ids: Int32Array.from({ length: 8 }, (_, k) => i32(d + k * 4)) } satisfies MenuSliderData;
      } else if (PANES_DRAWS.has(draw)) {
        c.data = { kind: 'panes', pane0: pane(d), pane1: pane(d + 4), text: text(d + 4), word2: i32(d + 8), device: null } satisfies MenuPanesData;
      }
    }
    controls.set(t, c);
    return c;
  };
  const menu = (m: number): Menu => {
    const seen = menus.get(m);
    if (seen) return seen;
    const mn = new Menu();
    menus.set(m, mn);
    mn.state = block[m]!;
    mn.title = text(m + 1);
    mn.slot = i32(m + 5);
    mn.count = i32(m + 9);
    mn.selected = i32(m + 0xd);
    module.indices.set(mn, { onload: i32(m + 0x11) });
    // the items in use and the one record after them, which lance_point_menu_onload reads
    const n = Math.max(0, mn.count) + 1;
    for (let k = 0; k < n; k++) {
      const at = m + 0x15 + k * 0x11;
      if (at + 0x11 > block.length) break;
      const it = new MenuItem();
      it.type = block[at]!;
      it.label = text(at + 1);
      const draw = i32(at + 5);
      module.indices.set(it, { draw });
      it.control = control(at + 9, draw);
      mn.items.push(it);
      const sub = ptr(at + 0xd);
      if (sub !== null) it.submenu = menu(sub);
    }
    return mn;
  };
  const root = ptr(0);
  if (root === null) return { ctx: null, module };
  const c = new MenuContext();
  c.pane = pane(root);
  c.flags = block[root + 4]!;
  const st = ptr(root + 5);
  c.stack = st === null ? null : Array.from({ length: 8 }, (_, k) => (ptr(st + k * 4) === null ? null : menu(ptr(st + k * 4)!)));
  c.depth = i32(root + 9);
  c.backShpId = i32(root + 0xd);
  c.backPane = pane(root + 0x15);
  c.cursorShpId = i32(root + 0x19);
  c.enterSound = i32(root + 0x21);
  c.moveSound = i32(root + 0x25);
  c.fontId = i32(root + 0x29);
  c.ink = i32(root + 0x31);
  c.selectedInk = i32(root + 0x35);
  c.rows = i32(root + 0x39);
  c.rowX = i32(root + 0x3d);
  c.rowHeight = i32(root + 0x41);
  c.titleX = i32(root + 0x45);
  c.titleY = i32(root + 0x49);
  c.cursorX = i32(root + 0x4d);
  c.cursorY = i32(root + 0x51);
  c.textX = i32(root + 0x55);
  c.textY = i32(root + 0x59);
  c.widgetX = i32(root + 0x5d);
  c.widgetY = i32(root + 0x61);
  const top = ptr(root + 0x65);
  c.topMenu = top === null ? null : menu(top);
  return { ctx: c, module };
}

/** The ported function at tables[index], or null (index 0, or a callback the port does not have). @portOnly */
function tableEntry(kind: MenuTableKind, index: number): CodeFn | null {
  if (index === 0) return null;
  const address = imageI32(MENU_TABLES[kind].address + index * 4, 0) >>> 0;
  const fn = resolveCode(address);
  if (!fn && address !== 0) unestablished(`${MENU_TABLES[kind].label}[${index}] (0x${address.toString(16)}) is not ported`, 'menu_resolve_callbacks');
  return fn;
}

/**
 * Resolves a menu's callback indices through the EXE's tables - its onload,
 * each item's draw callback, each control's five slots (once per control:
 * flags bit 3) - then runs the onload, and recurses into the submenus.
 * Returns 1 only when every onload returned bit 0 set.
 *
 * @mw2 menu_resolve_callbacks 0x00017710
 * @fidelity exact
 * @divergence the indices are held beside the records (MenuModule.indices) rather than in the callback fields they are replaced in
 */
export function menuResolveCallbacks(ctx: MenuContext, menu: Menu | null, module: MenuModule): number {
  if (!menu) return 0;
  menu.onLoad = tableEntry('onload', module.indices.get(menu)?.onload ?? 0);
  for (let i = 0; i < menu.count; i++) {
    const it = menu.items[i];
    if (!it) break;
    it.draw = tableEntry('draw', module.indices.get(it)?.draw ?? 0);
    const c = it.control;
    if (c && (c.flags & 8) === 0) {
      const ix = module.indices.get(c) ?? {};
      c.init = tableEntry('init', ix.init ?? 0);
      c.get = tableEntry('get', ix.get ?? 0);
      c.preview = tableEntry('preview', ix.preview ?? 0);
      c.commit = tableEntry('commit', ix.commit ?? 0);
      c.revert = tableEntry('revert', ix.revert ?? 0);
      c.flags |= 8;
    }
  }
  let ok = 1;
  if (menu.onLoad) ok = (menu.onLoad(ctx, menu) as number) & 1;
  for (let i = 0; i < menu.count; i++) {
    const sub = menu.items[i]?.submenu ?? null;
    if (sub) ok &= menuResolveCallbacks(ctx, sub, module);
  }
  return ok;
}

/**
 * The start-of-open layout: the back pane (in screen fractions) scaled
 * about its centre to the background shape's share of the screen; the row
 * step 1 / (rows + 2), with the title half a step down and the first item
 * two; both panes into pixels and the points into the pane; with flags bit
 * 4 the back pane moved to the pane's left edge; the row height kept.
 *
 * @mw2 menu_layout 0x000178b0
 * @fidelity exact
 */
export function menuLayout(ctx: MenuContext): void {
  const pane = ctx.pane;
  const back = ctx.backPane;
  if (!pane || !back || !pane.canvas || !back.canvas) return;
  const win = back.canvas as typeof defaultCanvas;
  if (ctx.backShpId !== -1) {
    const shp = cacheLoadResource((display.assetVariant + ctx.backShpId) | 0, 'SHP');
    if (shp) {
      const b = vfxShapeBounds(shp, 0);
      cacheUnlock((display.assetVariant + ctx.backShpId) | 0, 'SHP');
      const fx = sdivShl(b >> 16, 16, (win.xMax + 1) | 0);
      const fy = sdivShl(b & 0xffff, 16, (win.yMax + 1) | 0);
      const sx = sdivShl(fx, 16, (back.right - back.left + 1) | 0);
      const sy = sdivShl(fy, 16, (back.bottom - back.top + 1) | 0);
      layoutPaneScaleAboutCentre(back, back, sx, sy);
    }
  }
  const step = sdivShl(1, 16, (ctx.rows + 2) | 0);
  ctx.titleY = sdivShl(step, 16, 0x20000);
  ctx.cursorY = ctx.textY = ctx.widgetY = (step * 2) | 0;
  layoutPaneToWindow(pane.canvas as typeof defaultCanvas, pane, pane);
  layoutPaneToWindow(back.canvas as typeof defaultCanvas, back, back);
  const row = Int32Array.of(0, step);
  layoutPointInPane(pane, row, row);
  const pts = Int32Array.of(ctx.titleX, ctx.titleY, ctx.cursorX, ctx.cursorY, ctx.textX, ctx.textY, ctx.widgetX, ctx.widgetY);
  for (let k = 0; k < 8; k += 2) layoutPointInPane(pane, pts, pts, k);
  ctx.titleX = pts[0]!;
  ctx.titleY = pts[1]!;
  ctx.cursorX = pts[2]!;
  ctx.cursorY = pts[3]!;
  ctx.textX = pts[4]!;
  ctx.textY = pts[5]!;
  ctx.widgetX = pts[6]!;
  ctx.widgetY = pts[7]!;
  if ((ctx.flags & 0x10) !== 0) {
    const d = (back.left - pane.left) | 0;
    back.left = (back.left - d) | 0;
    back.right = (back.right - d) | 0;
  }
  ctx.rowX = row[0]!;
  ctx.rowHeight = row[1]!;
}

/**
 * Loads the context's MENU (its id is the resource id) as an LX module; with
 * both panes present, puts them on the screen canvas, lays the menu out and
 * resolves its callbacks. Returns the MenuContext, or null.
 *
 * @mw2 menu_load 0x00017810
 * @fidelity exact
 * @divergence the module is read into objects (readModule); a failed load leaves node.record and node.module set, as the original does
 */
export function menuLoad(node: UiContext): MenuContext | null {
  const src = cacheLoadResource(node.id, 'MENU');
  if (!src) return null;
  const lx = lxModuleLoad(src);
  cacheUnlock(node.id, 'MENU');
  if (!lx) return null;
  const { ctx, module } = readModule(lx.block, lx.fixups);
  node.module = module;
  node.record = ctx;
  if (!ctx) return null;
  if (!ctx.pane || !ctx.backPane) return null;
  ctx.backPane.canvas = defaultCanvas;
  ctx.pane.canvas = ctx.backPane.canvas;
  menuLayout(ctx);
  if (menuResolveCallbacks(ctx, ctx.topMenu, module) === 0) return null;
  return ctx;
}
