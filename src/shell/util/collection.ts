/**
 * The shell's growable arrays and strings (decompiled/mw2shell/src/util/
 * collection.c, 20 positional functions). A collection is a 0x1d-byte
 * header over a malloc'd array of dwords: +0 capacity, +4 count, +8 the
 * step it grows by, +0xc flags (2: sorted), +0xd dirty, +0x11 the array,
 * +0x15 a free hook, +0x19 a compare hook. The port keeps collections as
 * JS arrays and strings as JS strings; only the routines whose exact
 * semantics a caller depends on are ported here, under their positional
 * names.
 */

/**
 * strdup, except that an empty string gives NULL (the length test comes
 * first): text_label_init stores NULL for an empty line, and the archive
 * viewer's region buttons get a NULL label from its "".
 *
 * @mw2shell str_dup_nonempty 0x00010010
 * @fidelity exact
 * @divergence a failed malloc (the original prints its message and exits) cannot happen
 */
export function strDupNonempty(s: string): string | null {
  // strlen stops at a NUL, as the copy does
  const nul = s.indexOf('\0');
  const t = nul < 0 ? s : s.slice(0, nul);
  return t.length === 0 ? null : t;
}

/**
 * strupr (over a C string in the image) is ported in
 * shell/clib.ts; this is the same over a string the port holds in JS (a
 * stack buffer in the original).
 *
 * @portOnly strupr on a JS string
 */
export function struprString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += String.fromCharCode(c >= 0x61 && c <= 0x7a ? c - 0x20 : c);
  }
  return out;
}

/**
 * Appends an element, growing the array by the collection's step when it
 * is full.
 *
 * @mw2shell collection_append 0x00010200
 * @fidelity exact
 */
export function collectionAppend<T>(c: T[], item: T): void {
  c.push(item);
}

/**
 * Removes the first element equal to `item` (the unsorted search with no
 * compare hook is identity), shifting the rest down; with free set, the
 * collection's free hook is called on it first (the port has nothing to
 * free).
 *
 * @mw2shell collection_remove 0x000102c0
 * @fidelity exact
 */
export function collectionRemove<T>(c: T[], item: T, _free: number): void {
  const i = c.indexOf(item);
  if (i >= 0) c.splice(i, 1);
}

/**
 * Element i, or NULL outside 0..count. The bound is `i <= count`, so
 * element `count` - one past the last - is read from the array (a slot the
 * grow step zeroed, or a removed element's stale copy).
 *
 * @mw2shell collection_get 0x00010470
 * @fidelity partial
 * @divergence index `count` (past the end) gives null; the original reads whatever the array holds there
 */
export function collectionGet<T>(c: readonly T[], i: number): T | null {
  if (i <= c.length && i >= 0) return c[i] ?? null;
  return null;
}
