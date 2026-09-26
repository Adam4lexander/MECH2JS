/**
 * Checks every provenance tag in the port against the decompilation and
 * writes PORTING.md, the coverage map.
 *
 * Tags (in doc comments):
 *   @mw2 <name> <0xaddress>        a ported function
 *   @mw2data <name> <0xaddress>    a static table / global read from the EXE
 *   @fidelity exact|partial|stub
 *   @divergence <text>
 * In-body markers: unestablished('...'), quirk('...'), divergence('...').
 *
 * FAILS (exit 1) when a @mw2 tag names an address with no function, when the
 * name at that address differs (the decompilation renamed it - update the
 * tag), or when two tags claim the same function. Names are trusted only
 * together with their address; either alone could be stale.
 *
 * Usage: tsx tools/porting-map.ts [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORT_DIR, mw2Decompiled } from './paths.ts';
import { LABEL, LABEL_KIND } from '../src/generated/labels.gen.ts';

interface Fn {
  address: number;
  name: string;
  module: string;
  group: string;
  evidence: string;
  size: number;
}

interface Tag {
  kind: 'mw2' | 'mw2data';
  name: string;
  address: number;
  fidelity: string;
  file: string;
  line: number;
  symbol: string;
}

interface Marker {
  kind: string;
  text: string;
  file: string;
  line: number;
}

const LIBRARY_GROUPS = new Set(['clib', 'miles']);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line) continue;
    const row: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        row.push(cur);
        cur = '';
      } else cur += c;
    }
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function loadFunctions(): Map<number, Fn> {
  const rows = parseCsv(fs.readFileSync(path.join(mw2Decompiled(), 'mw2', 'listing', 'functions.csv'), 'utf8'));
  const head = rows[0]!;
  const col = (n: string) => head.indexOf(n);
  const m = new Map<number, Fn>();
  for (const r of rows.slice(1)) {
    const address = parseInt(r[col('address')]!, 16);
    m.set(address, {
      address,
      name: r[col('name')]!,
      module: r[col('module')]!,
      group: r[col('group')]!,
      evidence: r[col('evidence')]!,
      size: Number(r[col('size_bytes')]),
    });
  }
  return m;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'generated') walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function scan(files: string[]): { tags: Tag[]; markers: Marker[] } {
  const tags: Tag[] = [];
  const markers: Marker[] = [];
  for (const file of files) {
    const rel = path.relative(PORT_DIR, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      const t = /@(mw2|mw2data)\s+(\w+)\s+0x([0-9a-fA-F]+)/.exec(l);
      if (t) {
        // the doc block's @fidelity and the symbol it documents
        let fidelity = '';
        let symbol = '';
        for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
          const f = /@fidelity\s+(\w+)/.exec(lines[j]!);
          if (f && !fidelity) fidelity = f[1]!;
          if (/\*\//.test(lines[j]!)) {
            for (let k = j + 1; k < Math.min(lines.length, j + 4); k++) {
              const s = /(?:function|const|class|let)\s+(\w+)/.exec(lines[k]!);
              if (s) {
                symbol = s[1]!;
                break;
              }
            }
            break;
          }
        }
        tags.push({ kind: t[1] as Tag['kind'], name: t[2]!, address: parseInt(t[3]!, 16), fidelity, file: rel, line: i + 1, symbol });
      }
      const m = /\b(unestablished|quirk|divergence)\(\s*(['`"])(.*?)\2/.exec(l);
      if (m && !/^\s*(export )?function/.test(l)) markers.push({ kind: m[1]!, text: m[3]!, file: rel, line: i + 1 });
      const d = /@divergence\s+(.*)$/.exec(l);
      if (d) markers.push({ kind: 'divergence', text: d[1]!.trim(), file: rel, line: i + 1 });
    });
  }
  return { tags, markers };
}

export function run(write: boolean): number {
  const fns = loadFunctions();
  const { tags, markers } = scan(walk(path.join(PORT_DIR, 'src')));
  const errors: string[] = [];
  const claimed = new Map<number, Tag>();
  const codeLabels: Tag[] = [];
  const codeEnd = Math.max(...[...fns.values()].map((f) => f.address + f.size));
  for (const t of tags.filter((x) => x.kind === 'mw2')) {
    const f = fns.get(t.address);
    const at = `${t.file}:${t.line}`;
    // Code reached only through a stored pointer can have no Ghidra function
    // but a label in MW2Types.java (e.g. object_cull_main_view). Accept one
    // whose name and address match and which lies inside the code object.
    const label = (LABEL as Record<string, number>)[t.name];
    const codeLabel = !f && label === t.address && (LABEL_KIND as Record<string, string>)[t.name] === 'raw' && t.address <= codeEnd;
    if (codeLabel) codeLabels.push(t);
    else if (!f) errors.push(`${at}: @mw2 ${t.name} 0x${t.address.toString(16)} - no function at that address`);
    else if (f.name !== t.name) errors.push(`${at}: @mw2 ${t.name} 0x${t.address.toString(16)} - the decompilation calls it ${f.name} (renamed upstream?)`);
    const prev = claimed.get(t.address);
    if (prev) errors.push(`${at}: ${t.name} is also claimed at ${prev.file}:${prev.line}`);
    else claimed.set(t.address, t);
    if (!['exact', 'partial', 'stub'].includes(t.fidelity)) errors.push(`${at}: @mw2 ${t.name} has no @fidelity exact|partial|stub`);
  }

  const game = [...fns.values()].filter((f) => !LIBRARY_GROUPS.has(f.group));
  const byModule = new Map<string, { total: number; exact: number; partial: number; stub: number; group: string }>();
  for (const f of game) {
    const m = byModule.get(f.module) ?? { total: 0, exact: 0, partial: 0, stub: 0, group: f.group };
    m.total++;
    const t = claimed.get(f.address);
    if (t && (t.fidelity === 'exact' || t.fidelity === 'partial' || t.fidelity === 'stub')) m[t.fidelity]++;
    byModule.set(f.module, m);
  }
  const libTags = tags.filter((t) => t.kind === 'mw2' && LIBRARY_GROUPS.has(fns.get(t.address)?.group ?? ''));
  const count = (fid: string) => [...claimed.values()].filter((t) => t.fidelity === fid && !LIBRARY_GROUPS.has(fns.get(t.address)?.group ?? '')).length;

  const L: string[] = [];
  L.push('# Porting map');
  L.push('');
  L.push('GENERATED by `tools/porting-map.ts` (run `npm run gen`). Do not edit by hand.');
  L.push('');
  L.push('Every ported function carries `@mw2 <name> <address>`; this file is built from those tags and checked');
  L.push('against `decompiled/mw2/listing/functions.csv`, so a function renamed upstream fails the build rather');
  L.push('than drifting. Library code (Watcom clib, Miles) is excluded from the totals.');
  L.push('');
  L.push(`**Game functions:** ${game.length}  |  **ported exact:** ${count('exact')}  |  **partial:** ${count('partial')}  |  **stub:** ${count('stub')}  |  library functions ported: ${libTags.length}`);
  L.push('');
  L.push('## By original module');
  L.push('');
  L.push('| module | group | functions | exact | partial | stub | not started |');
  L.push('|---|---|---:|---:|---:|---:|---:|');
  for (const [name, m] of [...byModule.entries()].sort((a, b) => a[1].group.localeCompare(b[1].group) || a[0].localeCompare(b[0]))) {
    L.push(`| ${name} | ${m.group} | ${m.total} | ${m.exact} | ${m.partial} | ${m.stub} | ${m.total - m.exact - m.partial - m.stub} |`);
  }
  L.push('');
  L.push('## Ported functions');
  L.push('');
  L.push('| address | original | module | fidelity | port |');
  L.push('|---|---|---|---|---|');
  for (const t of [...claimed.values()].sort((a, b) => a.address - b.address)) {
    const f = fns.get(t.address);
    L.push(`| 0x${t.address.toString(16).padStart(8, '0')} | ${t.name} | ${f?.module ?? (codeLabels.includes(t) ? 'code label, no Ghidra function' : '?')} | ${t.fidelity} | \`${t.symbol}\` ${t.file}:${t.line} |`);
  }
  const data = tags.filter((t) => t.kind === 'mw2data');
  if (data.length) {
    L.push('');
    L.push('## Static data read from MW2.EXE');
    L.push('');
    L.push('| address | name | port |');
    L.push('|---|---|---|');
    for (const t of data.sort((a, b) => a.address - b.address)) L.push(`| 0x${t.address.toString(16).padStart(8, '0')} | ${t.name} | ${t.file}:${t.line} |`);
  }
  for (const kind of ['divergence', 'quirk', 'unestablished']) {
    const ms = markers.filter((m) => m.kind === kind);
    L.push('');
    L.push(`## ${kind === 'divergence' ? 'Divergences (deliberate differences)' : kind === 'quirk' ? 'Quirks (original oddities reproduced on purpose)' : 'Unestablished (gaps the decompilation has not closed)'}`);
    L.push('');
    if (!ms.length) L.push('None.');
    for (const m of ms) L.push(`- ${m.file}:${m.line} - ${m.text}`);
  }
  L.push('');
  if (errors.length) {
    console.error(`porting-map: ${errors.length} error(s)`);
    for (const e of errors) console.error('  ' + e);
  }
  if (write) fs.writeFileSync(path.join(PORT_DIR, 'PORTING.md'), L.join('\n'));
  console.log(`porting-map: ${claimed.size} functions tagged (${count('exact')} exact, ${count('partial')} partial, ${count('stub')} stub), ${data.length} data tags, ${markers.length} markers`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(!process.argv.includes('--check')));
}
