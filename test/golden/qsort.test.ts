// Watcom's qsort against the original machine code: decompiled/tools/
// emulate_qsort.py runs the shell's clib_sub_048dc1 under an x86 emulator
// over arrays full of ties and lists the order it leaves them in. Ties are
// where an unstable sort shows its steps, so every id must land where the
// original put it.
import { describe, expect, it } from 'vitest';
import { watcomQsort } from '../../src/engine/qsort.ts';
import { hasShellDecompiled, readShellListing } from '../support/env.ts';

describe.runIf(hasShellDecompiled)('Watcom qsort', () => {
  it('orders every emulated case exactly as the original', () => {
    const lines = readShellListing('qsort_cases.txt').split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(300);
    const nums = (s: string) => s.trim().split(/\s+/).filter(Boolean).map(Number);
    let reordered = 0;
    for (const line of lines) {
      const [size, keysText, idsText] = line.split('|');
      const keys = nums(keysText!);
      const want = nums(idsText!);
      const ids = keys.map((_, i) => i);
      watcomQsort(ids, (a, b) => Math.sign(keys[a]! - keys[b]!), Number(size) <= 4);
      expect(ids, line).toEqual(want);
      if (want.some((id, i) => i > 0 && keys[want[i - 1]!] === keys[id] && want[i - 1]! > id)) reordered++;
    }
    // the cases do exercise instability: many leave ties out of their first order
    expect(reordered).toBeGreaterThan(50);
  });
});
