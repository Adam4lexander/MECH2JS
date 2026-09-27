/**
 * Watcom's qsort, which both executables link (byte-identical). It is not
 * stable, and which of two equal elements comes first depends on its exact
 * steps - the Hall of Honor's order among tied pilots, for one - so the
 * port runs it rather than Array.prototype.sort. test/golden/qsort.test.ts
 * checks it against the original code run under emulation.
 *
 * Runs of more than 15 elements are partitioned three ways around a pivot
 * (the middle element; from 30 elements the median of first, middle and
 * last; from 43 the median of three such medians), the equal elements
 * swapped out to both ends and back into the middle; the smaller side is
 * sorted next and the larger pushed. Runs of 15 or fewer are insertion
 * sorted with a gap of 3 - over positions 0, 3, 6, ... only - and then 1.
 */

/** A comparison: < 0, 0 or > 0, as C's qsort takes. */
export type QsortCompare<T> = (a: T, b: T) => number;

/**
 * The median of a, b and c (indices) by `cmp`, as the pivot chooser works
 * it out.
 *
 * @mw2 qsort_median3 0x00062cc3
 * @mw2shell qsort_median3 0x00048d69
 * @fidelity exact
 */
function median3<T>(v: T[], a: number, b: number, c: number, cmp: QsortCompare<T>): number {
  if (cmp(v[a]!, v[b]!) > 0) {
    if (cmp(v[a]!, v[c]!) <= 0) return a;
    return cmp(v[b]!, v[c]!) > 0 ? b : c;
  }
  if (cmp(v[a]!, v[c]!) >= 0) return a;
  return cmp(v[b]!, v[c]!) > 0 ? c : b;
}

function swap<T>(v: T[], i: number, j: number): void {
  const t = v[i]!;
  v[i] = v[j]!;
  v[j] = t;
}

/** Swaps the n elements at i with the n at j (the runs do not overlap). */
function vecswap<T>(v: T[], i: number, j: number, n: number): void {
  for (let k = 0; k < n; k++) swap(v, i + k, j + k);
}

/**
 * Sorts v[0 .. n) in place. `copyPivot` is the original's choice between
 * its two element modes: true when the base and element size are both
 * 4-aligned and the size is at most 4 - the pivot is copied aside - and
 * false otherwise, when the pivot is first swapped to the front of its run
 * (which moves elements, so the two modes can order ties differently).
 *
 * @mw2 qsort 0x00062d1b
 * @mw2shell qsort 0x00048dc1
 * @fidelity exact
 */
export function watcomQsort<T>(v: T[], cmp: QsortCompare<T>, copyPivot = true, n = v.length): void {
  const stackLo: number[] = [];
  const stackN: number[] = [];
  let lo = 0;
  for (;;) {
    if (1 < n) {
      if (0xf < n) {
        let p = lo + (n >> 1);
        if (0x1d < n) {
          let first = lo;
          let last = lo + n - 1;
          if (0x2a < n) {
            const e = n >> 3;
            first = median3(v, lo, lo + e, lo + 2 * e, cmp);
            p = median3(v, p - e, p, p + e, cmp);
            last = median3(v, last - 2 * e, last - e, last, cmp);
          }
          p = median3(v, first, p, last, cmp);
        }
        let pivot: T;
        if (copyPivot) pivot = v[p]!;
        else {
          swap(v, lo, p);
          pivot = v[lo]!;
        }
        let a = lo;
        let b = lo;
        let c = lo + n - 1;
        let d = c;
        for (;;) {
          for (; b <= c; b++) {
            const r = cmp(v[b]!, pivot);
            if (0 < r) break;
            if (r === 0) swap(v, a++, b);
          }
          for (; b <= c; c--) {
            const r = cmp(v[c]!, pivot);
            if (r < 0) break;
            if (r === 0) swap(v, c, d--);
          }
          if (b > c) break;
          swap(v, b++, c--);
        }
        const end = lo + n;
        let s = Math.min(a - lo, b - a);
        if (s !== 0) vecswap(v, lo, b - s, s);
        s = Math.min(d - c, end - 1 - d);
        if (s !== 0) vecswap(v, b, end - s, s);
        const left = b - a;
        const right = d - c;
        if (right < left) {
          if (left <= 1) {
            // both sides are single elements: nothing more on this run
          } else {
            stackLo.push(lo);
            stackN.push(left);
            lo = end - right;
            n = right;
            continue;
          }
        } else {
          stackN.push(right);
          stackLo.push(end - right);
          n = left;
          continue;
        }
      } else {
        const end = lo + n;
        for (let gap = 3; 0 < gap; gap -= 2) {
          for (let i = lo + gap; i < end; i += gap) {
            for (let j = i; lo < j; j -= gap) {
              if (cmp(v[j - gap]!, v[j]!) < 1) break;
              swap(v, j, j - gap);
            }
          }
        }
      }
    }
    if (stackLo.length === 0) return;
    lo = stackLo.pop()!;
    n = stackN.pop()!;
  }
}
