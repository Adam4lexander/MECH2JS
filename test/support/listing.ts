/**
 * Line-by-line comparison of what the port produced with what a test worked
 * out independently. A reader that gets the right number of records but
 * attaches each one's fields to its neighbour would pass every total, so the
 * lines are paired one to one and the first differences reported with their
 * line numbers; totals are never the criterion.
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
