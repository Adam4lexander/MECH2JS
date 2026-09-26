/**
 * Record-by-record comparison of a TS-produced listing against the
 * decompilation's Python-produced one.
 *
 * CLAUDE.md: "Verify correspondence, not counts." A parser that reads the
 * right number of records but attaches each one's fields to its neighbour
 * would pass every total. So the comparison pairs lines up one to one and
 * reports the first differences with their line numbers; totals are never
 * the criterion.
 */
import { expect } from 'vitest';

export interface LineDiff {
  line: number;
  want: string | undefined;
  got: string | undefined;
}

export function diffLines(want: string[], got: string[], limit = 20): LineDiff[] {
  const out: LineDiff[] = [];
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n && out.length < limit; i++) {
    if (want[i] !== got[i]) out.push({ line: i + 1, want: want[i], got: got[i] });
  }
  return out;
}

/** Fails with the first differing lines (and totals, for context only). */
export function expectSameLines(name: string, want: string[], got: string[]): void {
  const d = diffLines(want, got);
  if (d.length) {
    const msg = d.map((x) => `  line ${x.line}\n    want: ${JSON.stringify(x.want)}\n    got:  ${JSON.stringify(x.got)}`).join('\n');
    expect.fail(`${name}: ${d.length}${d.length >= 20 ? '+' : ''} differing lines (want ${want.length}, got ${got.length})\n${msg}`);
  }
}

/** Split text into lines without a trailing empty line. */
export function lines(text: string): string[] {
  const l = text.replace(/\r\n/g, '\n').split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
}

/** Python's %r for a float, for formatters that print one. */
export function pyRepr(v: number): string {
  if (Number.isInteger(v)) return v.toFixed(1);
  const s = String(v);
  return s.includes('e') ? s.replace(/e([+-])(\d)$/, 'e$10$2') : s;
}

/** Python's '%#x' (width 0) or '%#0<width>x' for a non-negative value. */
export function pyHex(v: number, width = 0): string {
  return '0x' + v.toString(16).padStart(Math.max(0, width - 2), '0');
}

/** Python's '%<w>d' / '%-<w>s' style padding. */
export const padL = (v: string | number, w: number): string => String(v).padStart(w);
export const padR = (v: string | number, w: number): string => String(v).padEnd(w);
