/**
 * Helpers for the BWD payload golden tests: walking every named BWD stream of
 * MW2.PRJ the way the dump tools pick them (a resource whose record header
 * names it), and reproducing the handful of Python formatting rules the
 * dump tools' output depends on (%r of str and bytes, %f and %g rounding,
 * float(), Counter.most_common).
 */
import type { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { type Chunk, walkStream } from '../../src/data/bwd/stream.ts';

export interface NamedStream {
  rid: number;
  name: string;
  bytes: Uint8Array;
  chunks: Chunk[];
}

/** Every BWD resource with a record-header name, in id order, walked with project_next_chunk. */
export function namedStreams(prj: ProjectFile): NamedStream[] {
  const out: NamedStream[] = [];
  const bwd = prj.type('BWD');
  if (!bwd) return out;
  for (let rid = 0; rid < bwd.entries.length; rid++) {
    const name = prj.resourceName('BWD', rid);
    if (!name) continue;
    const bytes = prj.readResource('BWD', rid);
    if (!bytes) continue;
    out.push({ rid, name, bytes, chunks: [...walkStream(bytes, name)] });
  }
  return out;
}

/** dump_project_index.read_names for one type: id -> record-header name. */
export function resourceNames(prj: ProjectFile, tag: string): Map<number, string> {
  const m = new Map<number, string>();
  const t = prj.type(tag);
  if (!t) return m;
  for (let id = 0; id < t.entries.length; id++) {
    const n = prj.resourceName(tag, id);
    if (n) m.set(id, n);
  }
  return m;
}

/**
 * The dumps' objs map: OBJ id -> its POLY's name, the last OBJ with an id
 * winning (a dict overwrite). OBJ is 0x3c bytes throughout MW2.PRJ, so the
 * POLY id at +0x38 is always inside the chunk.
 */
export function objPolyNames(chunks: Chunk[], polyNames: Map<number, string>, missing: (pid: number) => string): Map<number, string> {
  const m = new Map<number, string>();
  for (const c of chunks) if (c.tag === 'OBJ') m.set(c.i16(8), polyNames.get(c.i16(0x38)) ?? missing(c.i16(0x38)));
  return m;
}

// ---------------------------------------------------------------- counters

/** A collections.Counter stand-in that keeps insertion order. */
export class Counter<K> {
  readonly m = new Map<K, number>();
  add(k: K, n = 1): void {
    this.m.set(k, (this.m.get(k) ?? 0) + n);
  }
  get(k: K): number {
    return this.m.get(k) ?? 0;
  }
  get size(): number {
    return this.m.size;
  }
  /** Counter.most_common: by count descending, ties in insertion order (Python's sort is stable). */
  mostCommon(n?: number): Array<[K, number]> {
    const e = [...this.m.entries()].sort((a, b) => b[1] - a[1]);
    return n === undefined ? e : e.slice(0, n);
  }
  /** sorted(counter.items()) for number or string keys. */
  sorted(): Array<[K, number]> {
    return [...this.m.entries()].sort((a, b) => cmp(a[0], b[0]));
  }
}

/** Python's < for two numbers or two strings (strings by code point). */
export function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Python's ordering of two tuples of strings. */
export function cmpTuple(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmp(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------- %r

const strPrintable = (c: number) => (c >= 0x20 && c < 0x7f) || (c > 0xa0 && c <= 0xff && c !== 0xad);

function reprBody(codes: number[], printable: (c: number) => boolean): string {
  const quote = codes.includes(0x27) && !codes.includes(0x22) ? '"' : "'";
  let s = quote;
  for (const c of codes) {
    if (c === 0x5c) s += '\\\\';
    else if (String.fromCharCode(c) === quote) s += '\\' + quote;
    else if (c === 9) s += '\\t';
    else if (c === 10) s += '\\n';
    else if (c === 13) s += '\\r';
    else if (printable(c)) s += String.fromCharCode(c);
    else s += '\\x' + c.toString(16).padStart(2, '0');
  }
  return s + quote;
}

/** Python repr() of a str decoded as Latin-1. */
export function pyStrRepr(s: string): string {
  return reprBody([...s].map((ch) => ch.charCodeAt(0)), strPrintable);
}

/** Python repr() of a bytes object. */
export function pyBytesRepr(b: Uint8Array): string {
  return 'b' + reprBody([...b], (c) => c >= 0x20 && c < 0x7f);
}

// ---------------------------------------------------------------- %f / %g

/** |x| as an exact decimal: digits / 10^scale. Every finite double is one. */
function exactDecimal(x: number): { neg: boolean; digits: bigint; scale: number } {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const neg = hi >>> 31 === 1;
  const e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let p: number;
  if (e === 0) p = -1074;
  else {
    m |= 1n << 52n;
    p = e - 1075;
  }
  if (p >= 0) return { neg, digits: m << BigInt(p), scale: 0 };
  return { neg, digits: m * 5n ** BigInt(-p), scale: -p };
}

/** digits / 10^scale rounded half-even to `keep` decimals, as an integer count of 10^-keep. */
function roundHalfEven(digits: bigint, scale: number, keep: number): bigint {
  if (keep >= scale) return digits * 10n ** BigInt(keep - scale);
  const div = 10n ** BigInt(scale - keep);
  let q = digits / div;
  const r2 = (digits % div) * 2n;
  if (r2 > div || (r2 === div && q % 2n === 1n)) q += 1n;
  return q;
}

function withPoint(q: bigint, decimals: number): string {
  let s = q.toString();
  if (decimals <= 0) return s;
  s = s.padStart(decimals + 1, '0');
  return s.slice(0, -decimals) + '.' + s.slice(-decimals);
}

/** Python '%.<prec>f' (correctly rounded, half-even on exact ties, sign kept on -0.0). */
export function pyFixed(x: number, prec: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  const d = exactDecimal(x);
  return (d.neg ? '-' : '') + withPoint(roundHalfEven(d.digits, d.scale, prec), prec);
}

/** Python '%g' (precision 6 by default). */
export function pyG(x: number, prec = 6): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  const d = exactDecimal(x);
  const sign = d.neg ? '-' : '';
  if (d.digits === 0n) return sign + '0';
  const p = Math.max(1, prec);
  let exp = d.digits.toString().length - 1 - d.scale;
  let q = roundHalfEven(d.digits, d.scale, p - 1 - exp);
  if (q.toString().length > p) {
    exp += 1;
    q = roundHalfEven(d.digits, d.scale, p - 1 - exp);
  }
  const strip = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp >= -4 && exp < p) return sign + strip(withPoint(q, p - 1 - exp));
  const m = strip(withPoint(q, p - 1));
  return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- str parsing

/** Python's str.isspace() over Latin-1: \t..\r, \x1c..\x1f, space, \x85, \xa0. */
const pySpace = (c: number) => (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0;

/** Python's str.strip() for Latin-1 text. */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && pySpace(s.charCodeAt(a))) a++;
  while (b > a && pySpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** Python float(str), or null where it raises ValueError. */
export function pyFloat(s: string): number | null {
  const t = pyStrip(s);
  const num = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
  if (num.test(t)) return parseFloat(t.replace(/_/g, ''));
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (special) return special[2]!.toLowerCase() === 'nan' ? NaN : special[1] === '-' ? -Infinity : Infinity;
  return null;
}

/** dump_tasks.atoi: strip, optional sign, then ASCII digits (Python isdigit also takes the Latin-1 superscripts, on which the tool would raise; MW2.PRJ has none). */
export function dumpAtoi(s: string): number {
  const t = pyStrip(s);
  let i = 0;
  let sign = 1;
  if (t[0] === '+' || t[0] === '-') {
    sign = t[0] === '-' ? -1 : 1;
    i = 1;
  }
  let n = 0;
  while (i < t.length && t[i]! >= '0' && t[i]! <= '9') n = n * 10 + (t.charCodeAt(i++) - 48);
  return sign * n;
}
