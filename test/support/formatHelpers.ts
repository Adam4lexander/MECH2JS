/**
 * Small readers the format golden tests share with the decompilation's dump
 * tools: raw record-header names and the function listing.
 */
import fs from 'node:fs';
import { cstr } from '../../src/core/binary/ByteReader.ts';
import type { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { listingPath } from './env.ts';

/**
 * The DATA record header's name as dump_sounds.py reads it: bytes 0x1e..0x3e
 * of the record, up to the first NUL, unchecked (no magic / id validation,
 * unlike ProjectFile.resourceName).
 */
export function rawRecordName(prj: ProjectFile, recordStart: number): string {
  return cstr(prj.bytes.subarray(recordStart + 0x1e, recordStart + 0x3e));
}

/** address -> name, from decompiled/mw2/listing/functions.csv (the dump tools' source of names). */
export function readFunctionNames(): Map<number, string> {
  const text = fs.readFileSync(listingPath('functions.csv'), 'utf8').replace(/\r\n/g, '\n');
  const rows = text.split('\n').filter((l) => l.length);
  const head = rows[0]!.split(',');
  const ia = head.indexOf('address');
  const iname = head.indexOf('name');
  const out = new Map<number, string>();
  for (const r of rows.slice(1)) {
    const c = r.split(',');
    const a = c[ia];
    const n = c[iname];
    if (a && n) out.set(parseInt(a, 16), n);
  }
  return out;
}

/** Python's "%.Nf": JS toFixed, except toFixed rounds an exact binary tie up where Python rounds half to even. */
export function pyFixed(v: number, digits: number): string {
  const s = v.toFixed(digits);
  const scaled = v * 10 ** digits;
  const frac = scaled - Math.floor(scaled);
  if (frac === 0.5 && Number.isFinite(scaled)) {
    // an exact tie: Python keeps the even neighbour
    const lo = Math.floor(scaled);
    const even = lo % 2 === 0 ? lo : lo + 1;
    return (even / 10 ** digits).toFixed(digits);
  }
  return s;
}
