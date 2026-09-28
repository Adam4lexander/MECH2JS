/**
 * Checks every provenance tag in the port against the decompilation and
 * writes PORTING.md, the coverage map.
 *
 * Tags (in doc comments):
 *   @mw2 <name> <0xaddress>             a ported MW2.EXE function
 *   @mw2data <name> <0xaddress>         a static table / global read from MW2.EXE
 *   @mw2shell <name> <0xaddress>        a ported MW2SHELL.EXE (front end) function
 *   @mw2shelldata <name> <0xaddress>    a static table / global read from MW2SHELL.EXE
 *   @fidelity exact|partial|stub
 *   @divergence <text>
 * In-body markers: unestablished('...'), quirk('...'), divergence('...').
 *
 * The two executables are separate address spaces, so each target has its
 * own functions.csv and its own claims. One symbol may carry a tag for each:
 * the shell's VFX and runtime code is byte-identical to MW2's
 * (decompiled/mw2shell/build/matched.csv), and is ported once.
 *
 * FAILS (exit 1) when a tag names an address with no function, when the
 * name at that address differs (the decompilation renamed it - update the
 * tag), or when two tags claim the same function. Names are trusted only
 * together with their address; either alone could be stale.
 *
 * Usage: tsx tools/porting-map.ts [--check]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORT_DIR, requireDecompiled } from './paths.ts';
import { LABEL, LABEL_KIND } from '../src/generated/labels.gen.ts';
import { SHELL_LABEL, SHELL_LABEL_KIND } from '../src/generated/shell/labels.gen.ts';

interface Fn {
  address: number;
  name: string;
  module: string;
  group: string;
  evidence: string;
  size: number;
}

interface Tag {
  target: TargetKey;
  data: boolean;
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

type TargetKey = 'mw2' | 'mw2shell';

interface Target {
  key: TargetKey;
  exe: string;
  /** the tag's spelling; its data twin is `${tag}data` */
  tag: string;
  /** groups of library code, left out of the totals (listed, not counted) */
  library: Set<string>;
  /** groups of code nothing reaches, left out of the totals */
  dead: Set<string>;
  labels: Record<string, number>;
  labelKinds: Record<string, string>;
}

const TARGETS: Target[] = [
  { key: 'mw2', exe: 'MW2.EXE', tag: 'mw2', library: new Set(['clib', 'miles']), dead: new Set(), labels: LABEL, labelKinds: LABEL_KIND },
  {
    key: 'mw2shell',
    exe: 'MW2SHELL.EXE',
    tag: 'mw2shell',
    library: new Set(['clib', 'miles', 'smacker']),
    // the WASM world compiler: linked in, never called (decompiled/mw2shell/README.md)
    dead: new Set(['wasm']),
    labels: SHELL_LABEL,
    labelKinds: SHELL_LABEL_KIND,
  },
];

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

/**
 * The mw2-decompiled commit the listings came from ('a1b2c3d'), marked when
 * what the gen scripts read (the listings, the headers, the type sources) has
 * uncommitted changes - so PORTING.md records which decompilation the
 * port's tags and generated files were checked against.
 */
function decompiledRevision(): string {
  const dir = requireDecompiled();
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const rev = git('rev-parse', '--short', 'HEAD');
    const dirty = git('status', '--porcelain', '--', 'mw2/listing', 'mw2/include', 'mw2shell/listing', 'mw2shell/include', 'tools');
    return `mw2-decompiled \`${rev}\`${dirty ? ' (with uncommitted changes)' : ''}`;
  } catch {
    return 'an unknown revision (MW2_DECOMPILED is not in a git repository)';
  }
}

function loadFunctions(key: TargetKey): Map<number, Fn> {
  const rows = parseCsv(fs.readFileSync(path.join(requireDecompiled(), key, 'listing', 'functions.csv'), 'utf8'));
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

const TAG_RE = /@(mw2shelldata|mw2shell|mw2data|mw2)\s+(\w+)\s+0x([0-9a-fA-F]+)/;

function scan(files: string[]): { tags: Tag[]; markers: Marker[] } {
  const tags: Tag[] = [];
  const markers: Marker[] = [];
  for (const file of files) {
    const rel = path.relative(PORT_DIR, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      const t = TAG_RE.exec(l);
      if (t) {
        // the doc block's @fidelity and the symbol it documents
        let fidelity = '';
        let symbol = '';
        for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
          const f = /@fidelity\s+(\w+)/.exec(lines[j]!);
          if (f && !fidelity) fidelity = f[1]!;
          if (/\*\//.test(lines[j]!)) {
            for (let k = j + 1; k < Math.min(lines.length, j + 4); k++) {
              const s = /(?:function\*?|const|class|let)\s+(\w+)/.exec(lines[k]!);
              if (s) {
                symbol = s[1]!;
                break;
              }
            }
            break;
          }
        }
        const kind = t[1]!;
        tags.push({
          target: kind.startsWith('mw2shell') ? 'mw2shell' : 'mw2',
          data: kind.endsWith('data'),
          name: t[2]!,
          address: parseInt(t[3]!, 16),
          fidelity,
          file: rel,
          line: i + 1,
          symbol,
        });
      }
      const m = /\b(unestablished|quirk|divergence)\(\s*(['`"])(.*?)\2/.exec(l);
      if (m && !/^\s*(export )?function/.test(l)) markers.push({ kind: m[1]!, text: m[3]!, file: rel, line: i + 1 });
      const d = /@divergence\s+(.*)$/.exec(l);
      if (d) markers.push({ kind: 'divergence', text: d[1]!.trim(), file: rel, line: i + 1 });
    });
  }
  return { tags, markers };
}

interface Checked {
  fns: Map<number, Fn>;
  claimed: Map<number, Tag>;
  codeLabels: Tag[];
}

/** Checks one target's function tags; returns what they claim. */
function check(t: Target, tags: Tag[], errors: string[]): Checked {
  const fns = loadFunctions(t.key);
  const claimed = new Map<number, Tag>();
  const codeLabels: Tag[] = [];
  const codeEnd = Math.max(...[...fns.values()].map((f) => f.address + f.size));
  for (const tag of tags.filter((x) => x.target === t.key && !x.data)) {
    const f = fns.get(tag.address);
    const at = `${tag.file}:${tag.line}`;
    const hex = `0x${tag.address.toString(16)}`;
    // Code reached only through a stored pointer can have no Ghidra function
    // but a label in the types script (e.g. object_cull_main_view). Accept one
    // whose name and address match and which lies inside the code object.
    const codeLabel = !f && t.labels[tag.name] === tag.address && t.labelKinds[tag.name] === 'raw' && tag.address <= codeEnd;
    if (codeLabel) codeLabels.push(tag);
    else if (!f) errors.push(`${at}: @${t.tag} ${tag.name} ${hex} - no function at that address in ${t.exe}`);
    else if (f.name !== tag.name) errors.push(`${at}: @${t.tag} ${tag.name} ${hex} - the decompilation calls it ${f.name} (renamed upstream?)`);
    const prev = claimed.get(tag.address);
    if (prev) errors.push(`${at}: ${t.exe} ${tag.name} is also claimed at ${prev.file}:${prev.line}`);
    else claimed.set(tag.address, tag);
    if (!['exact', 'partial', 'stub'].includes(tag.fidelity)) errors.push(`${at}: @${t.tag} ${tag.name} has no @fidelity exact|partial|stub`);
  }
  return { fns, claimed, codeLabels };
}

interface Totals {
  game: number;
  exact: number;
  partial: number;
  stub: number;
  library: number;
}

/** One target's section of PORTING.md. */
function section(t: Target, c: Checked, tags: Tag[], L: string[], heading: string): Totals {
  const { fns, claimed, codeLabels } = c;
  const excluded = (group: string) => t.library.has(group) || t.dead.has(group);
  const game = [...fns.values()].filter((f) => !excluded(f.group));
  const byModule = new Map<string, { total: number; exact: number; partial: number; stub: number; group: string }>();
  for (const f of game) {
    const m = byModule.get(f.module) ?? { total: 0, exact: 0, partial: 0, stub: 0, group: f.group };
    m.total++;
    const tag = claimed.get(f.address);
    if (tag && (tag.fidelity === 'exact' || tag.fidelity === 'partial' || tag.fidelity === 'stub')) m[tag.fidelity]++;
    byModule.set(f.module, m);
  }
  const libTags = [...claimed.values()].filter((tag) => t.library.has(fns.get(tag.address)?.group ?? ''));
  const count = (fid: string) => [...claimed.values()].filter((tag) => tag.fidelity === fid && !excluded(fns.get(tag.address)?.group ?? '')).length;
  const totals: Totals = { game: game.length, exact: count('exact'), partial: count('partial'), stub: count('stub'), library: libTags.length };

  L.push(`${heading} ${t.exe}`);
  L.push('');
  const dead = [...t.dead].map((g) => `\`${g}\``).join(', ');
  L.push(
    `**Game functions:** ${totals.game}  |  **ported exact:** ${totals.exact}  |  **partial:** ${totals.partial}  |  **stub:** ${totals.stub}  |  library functions ported: ${totals.library}`,
  );
  L.push('');
  L.push(`Library groups left out of the totals: ${[...t.library].map((g) => `\`${g}\``).join(', ')}${dead ? `; dead code left out: ${dead}` : ''}.`);
  L.push('');
  L.push(`${heading}# By original module`);
  L.push('');
  L.push('| module | group | functions | exact | partial | stub | not started |');
  L.push('|---|---|---:|---:|---:|---:|---:|');
  for (const [name, m] of [...byModule.entries()].sort((a, b) => a[1].group.localeCompare(b[1].group) || a[0].localeCompare(b[0]))) {
    L.push(`| ${name} | ${m.group} | ${m.total} | ${m.exact} | ${m.partial} | ${m.stub} | ${m.total - m.exact - m.partial - m.stub} |`);
  }
  L.push('');
  L.push(`${heading}# Ported functions`);
  L.push('');
  L.push('| address | original | module | fidelity | port |');
  L.push('|---|---|---|---|---|');
  if (!claimed.size) L.push('| | none yet | | | |');
  for (const tag of [...claimed.values()].sort((a, b) => a.address - b.address)) {
    const f = fns.get(tag.address);
    L.push(
      `| 0x${tag.address.toString(16).padStart(8, '0')} | ${tag.name} | ${f?.module ?? (codeLabels.includes(tag) ? 'code label, no Ghidra function' : '?')} | ${tag.fidelity} | \`${tag.symbol}\` ${tag.file}:${tag.line} |`,
    );
  }
  const data = tags.filter((tag) => tag.target === t.key && tag.data);
  if (data.length) {
    L.push('');
    L.push(`${heading}# Static data read from ${t.exe}`);
    L.push('');
    L.push('| address | name | port |');
    L.push('|---|---|---|');
    for (const tag of data.sort((a, b) => a.address - b.address)) L.push(`| 0x${tag.address.toString(16).padStart(8, '0')} | ${tag.name} | ${tag.file}:${tag.line} |`);
  }
  L.push('');
  return totals;
}

export function run(write: boolean): number {
  const { tags, markers } = scan(walk(path.join(PORT_DIR, 'src')));
  const errors: string[] = [];
  const checked = TARGETS.map((t) => check(t, tags, errors));

  const L: string[] = [];
  L.push('# Porting map');
  L.push('');
  L.push('GENERATED by `tools/porting-map.ts` (run `npm run gen`). Do not edit by hand.');
  L.push('');
  L.push('Every ported function carries `@mw2 <name> <address>` (MW2.EXE, the sim) or `@mw2shell <name> <address>`');
  L.push('(MW2SHELL.EXE, the front end); this file is built from those tags and checked against');
  L.push('`decompiled/<target>/listing/functions.csv`, so a function renamed upstream fails the build rather');
  L.push('than drifting. Library code (Watcom clib, Miles, Smacker) is excluded from the totals.');
  L.push('');
  L.push(`Checked against the decompilation at ${decompiledRevision()}.`);
  L.push('');
  const totals = TARGETS.map((t, i) => section(t, checked[i]!, tags, L, '##'));

  for (const kind of ['divergence', 'quirk', 'unestablished']) {
    const ms = markers.filter((m) => m.kind === kind);
    L.push('');
    L.push(
      `## ${kind === 'divergence' ? 'Divergences (deliberate differences)' : kind === 'quirk' ? 'Quirks (original oddities reproduced on purpose)' : 'Unestablished (gaps the decompilation has not closed)'}`,
    );
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
  TARGETS.forEach((t, i) => {
    const n = totals[i]!;
    const data = tags.filter((tag) => tag.target === t.key && tag.data).length;
    console.log(
      `porting-map ${t.exe}: ${checked[i]!.claimed.size} functions tagged (${n.exact} exact, ${n.partial} partial, ${n.stub} stub of ${n.game}), ${data} data tags`,
    );
  });
  console.log(`porting-map: ${markers.length} markers`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(!process.argv.includes('--check')));
}
