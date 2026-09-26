/**
 * The in-game menus. Their layout lives in MW2.PRJ as MENU resources - each
 * an MZ-stub + LX executable that project_tables_menu_handler (0x17810) loads
 * with lx_module_load(resource, 5, 0) - and their behaviour in MW2.EXE as
 * seven tables of code pointers that menu_resolve_callbacks (0x17710) indexes
 * with the numbers the module stores. Index 0 of every table is null (no
 * callback). The run lengths are the runs of code pointers up to the next
 * table (MW2Types), NOT a limit any code checks.
 *
 * Menu layout as menu_resolve_callbacks reads it:
 *   menu     +9 item count, +0x11 on-load index (menuOnLoadFns), items of
 *            0x11 bytes from +0x15
 *   item     +0 type byte, +1 a label pointer (every relocated one in the
 *            shipped data points at text; the field is not named), +5 draw
 *            index (menuItemDrawFns), +9 control or 0, +0xd submenu or 0
 *   control  +0 flags byte (bit 3 set once resolved, so a shared control is
 *            resolved once), +0xc selector, +0x10 init, +0x14 get,
 *            +0x18 preview, +0x1c commit, +0x20 revert
 * The module's root is its first dword; the handler needs root[0] and
 * root+0x15 non-zero and resolves the top menu at root+0x65.
 */
import type { ExeImage } from '../ExeImage.ts';
import type { ProjectFile } from '../../prj/ProjectFile.ts';

export interface MenuCallbackTable {
  label: string;
  address: number;
  run: number;
}

/**
 * @mw2data menuControlInitFns 0x000958a8
 * @mw2data menuControlGetFns 0x000958b4
 * @mw2data menuControlPreviewFns 0x000958f8
 * @mw2data menuControlCommitFns 0x00095908
 * @mw2data menuControlRevertFns 0x0009595c
 * @mw2data menuItemDrawFns 0x00095968
 * @mw2data menuOnLoadFns 0x0009598c
 * @fidelity exact
 */
export const MENU_TABLES = {
  onload: { label: 'menuOnLoadFns', address: 0x9598c, run: 5 },
  draw: { label: 'menuItemDrawFns', address: 0x95968, run: 9 },
  init: { label: 'menuControlInitFns', address: 0x958a8, run: 3 },
  get: { label: 'menuControlGetFns', address: 0x958b4, run: 17 },
  preview: { label: 'menuControlPreviewFns', address: 0x958f8, run: 4 },
  commit: { label: 'menuControlCommitFns', address: 0x95908, run: 21 },
  revert: { label: 'menuControlRevertFns', address: 0x9595c, run: 3 },
} as const satisfies Record<string, MenuCallbackTable>;

export type MenuTableKind = keyof typeof MENU_TABLES;

/** The five control slots, in record order. */
export const CONTROL_SLOTS: ReadonlyArray<readonly [MenuTableKind, number]> = [
  ['init', 0x10],
  ['get', 0x14],
  ['preview', 0x18],
  ['commit', 0x1c],
  ['revert', 0x20],
];

/** Each table's code pointers (raw addresses), over its run. */
export function readMenuCallbackTables(exe: ExeImage): Record<MenuTableKind, number[]> {
  const out = {} as Record<MenuTableKind, number[]>;
  for (const [k, t] of Object.entries(MENU_TABLES) as [MenuTableKind, MenuCallbackTable][]) {
    out[k] = Array.from({ length: t.run }, (_, i) => exe.u32(t.address + i * 4));
  }
  return out;
}

/** A module loaded at block offset 0. */
export interface LxModule {
  block: Uint8Array;
  /** block offset -> the block offset the relocated dword there points at */
  fixups: Map<number, number>;
  /** per object: [virtualSize, relocBase, flags, pageTableIndex, pageCount, reserved] */
  objects: number[][];
}

/**
 * Loads an LX module from memory into one flat block and relocates it. The
 * original's quirks are kept: the object page table is re-read from entry 0
 * for every object; each page advances the load pointer by the bytes it
 * copied; a readable+writable object other than the first, starting
 * misaligned, moves up by 16 - (dest & 0xf); a fixup with source type 0, a
 * source list (0x20) or a 16-bit additive (flags 4 without 0x20) rejects the
 * whole module; a source offset above the page size is skipped; the target
 * type bits are never looked at.
 *
 * @mw2 lx_module_load 0x00034ff0
 * @fidelity partial
 * @divergence memory source only (flags bit 0), and the block is addressed from 0 (dest = 0), so every relocated value is a block offset; null for 'LX' missing or a rejected fixup
 */
export function lxModuleLoad(src: Uint8Array): LxModule | null {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);
  const s16 = (o: number) => dv.getInt16(o, true);
  const e = u32(0x3c);
  if (src[e] !== 0x4c || src[e + 1] !== 0x58) return null;
  const hdr = (o: number) => u32(e + o);
  const nobj = hdr(0x44);
  const npages = hdr(0x14);
  const objects: number[][] = [];
  for (let k = 0; k < nobj; k++) {
    const o = e + hdr(0x40) + 24 * k;
    objects.push([0, 4, 8, 12, 16, 20].map((d) => u32(o + d)));
  }
  // lx_module_size: the virtual sizes plus 15 per object
  const size = objects.reduce((s, o) => s + o[0]!, 0) + 15 * nobj;
  const block = new Uint8Array(size);
  const dest = 0;
  let cur = dest;
  const objBase = new Map<number, number>();
  const pageBase: number[] = [];
  objects.forEach(([vsize, , flags, , pcount], k) => {
    let pt = e + hdr(0x48); // restarts per object
    for (let pg = 0; pg < pcount!; pg++) {
      const poff = u32(pt);
      const psize = s16(pt + 4);
      pt += 8;
      if (pg === 0) {
        if (flags! & 2 && flags! & 1 && cur & 0xf && k !== 0) cur += 0x10 - (dest & 0xf);
        objBase.set(k + 1, cur);
      }
      pageBase.push(cur);
      const left = (vsize! - (cur - objBase.get(k + 1)!)) >>> 0;
      const n = Math.min(left, psize >>> 0);
      const at = (poff << hdr(0x2c)) + hdr(0x80);
      block.set(src.subarray(at, at + n), cur - dest);
      cur += n;
    }
  });
  const out = new DataView(block.buffer);
  const fixups = new Map<number, number>();
  const fpt = e + hdr(0x68);
  const recs = e + hdr(0x6c);
  for (let pg = 0; pg < npages; pg++) {
    const a = u32(fpt + 4 * pg);
    const b = u32(fpt + 4 * pg + 4);
    for (let p = recs + a; p < recs + b; p += 7) {
      const st = src[p]!;
      const fl = src[p + 1]!;
      if ((st & 7) === 0) return null;
      if (fl & 4 && !(fl & 0x20)) return null;
      if (st & 0x20) return null;
      const so = s16(p + 2);
      const tobj = src[p + 4]!;
      const toff = s16(p + 5);
      if (so >>> 0 > hdr(0x28)) continue;
      const at = pageBase[pg]! + so - dest;
      const val = (objBase.get(tobj) ?? 0) + toff;
      out.setUint32(at, val >>> 0, true);
      fixups.set(at, val - dest);
    }
  }
  return { block, fixups, objects };
}

export interface MenuControl {
  at: number;
  flags: number;
  selector: number;
  /** callback indices by slot */
  slots: Record<'init' | 'get' | 'preview' | 'commit' | 'revert', number>;
}

export interface MenuItem {
  type: number;
  /** the text item +1 points at, when it is a relocated pointer to printable text */
  label: string | null;
  draw: number;
  control: MenuControl | null;
  submenu: Menu | null;
}

export interface Menu {
  at: number;
  onLoad: number;
  items: MenuItem[];
}

export interface MenuModule {
  id: number;
  /** payload bytes */
  size: number;
  module: LxModule;
  /** block offset of the root, or null when the first dword is not relocated */
  root: number | null;
  /** the top menu (root+0x65), or null when that dword is not relocated */
  top: Menu | null;
}

/**
 * Reads MENU resource `id` and walks its menu tree. Pointers are followed only
 * where the loader wrote a relocation - never by what a dword looks like.
 * A menu reached twice, or a control shared by two items, is the same object.
 *
 * @portOnly the data half of project_tables_menu_handler + menu_resolve_callbacks; no callback is called
 */
export function readMenuModule(prj: ProjectFile, id: number): MenuModule | null {
  const src = prj.readResource('MENU', id);
  if (!src) return null;
  const module = lxModuleLoad(src);
  if (!module) return null;
  const { block, fixups } = module;
  const dv = new DataView(block.buffer);
  const u32 = (o: number) => dv.getUint32(o, true);
  const text = (o: number): string | null => {
    const t = fixups.get(o);
    if (t === undefined) return null;
    let s = '';
    for (let i = t; i < block.length; i++) {
      const c = block[i]!;
      if (c === 0) return s === '' ? null : s;
      if (c < 0x20 || c > 0x7e) return null;
      s += String.fromCharCode(c);
    }
    return null;
  };
  const menus = new Map<number, Menu>();
  const controls = new Map<number, MenuControl>();
  const walk = (m: number): Menu => {
    const seen = menus.get(m);
    if (seen) return seen;
    const menu: Menu = { at: m, onLoad: u32(m + 0x11), items: [] };
    menus.set(m, menu);
    const n = u32(m + 9);
    for (let i = 0; i < n; i++) {
      const it = m + 0x15 + 0x11 * i;
      const c = fixups.get(it + 9);
      let control: MenuControl | null = null;
      if (c !== undefined) {
        control = controls.get(c) ?? null;
        if (!control) {
          control = {
            at: c,
            flags: block[c]!,
            selector: u32(c + 0xc),
            slots: { init: u32(c + 0x10), get: u32(c + 0x14), preview: u32(c + 0x18), commit: u32(c + 0x1c), revert: u32(c + 0x20) },
          };
          controls.set(c, control);
        }
      }
      const item: MenuItem = { type: block[it]!, label: text(it + 1), draw: u32(it + 5), control, submenu: null };
      menu.items.push(item);
      const sub = fixups.get(it + 0xd);
      if (sub !== undefined) item.submenu = walk(sub);
    }
    return menu;
  };
  const root = fixups.get(0) ?? null;
  const topAt = root === null ? undefined : fixups.get(root + 0x65);
  return { id, size: src.length, module, root, top: topAt === undefined ? null : walk(topAt) };
}
