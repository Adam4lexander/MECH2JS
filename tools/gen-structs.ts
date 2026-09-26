/**
 * Generates the port's struct schemas from the decompilation's recovered
 * header, decompiled/mw2/include/mw2_types.h.
 *
 *   src/generated/structs.gen.ts       schemas (name, offset, C type, size,
 *                                      count) + TS interfaces for raw reads
 *   src/generated/structDocs.gen.json  each field's evidence comment, for the
 *                                      editor's inspector
 *
 * The header is itself generated (tools/MW2ExportTypes.java) and regular:
 * a `/* Name - N (0xN) bytes *\/` line, `struct Name {`, then fields, each
 * optionally preceded by a `/* +0xNNN  doc *\/` comment or followed by a
 * trailing `/* +0xNNN *\/`, with explicit `pad_` members filling gaps. The
 * layout is packed. This tool recomputes every offset from the declarations
 * and fails if one disagrees with the header's own comment or if a struct's
 * total disagrees with its declared size - so a parsing mistake cannot
 * silently shift fields.
 *
 * Usage: tsx tools/gen-structs.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORT_DIR, mw2Decompiled } from './paths.ts';
import { BLOCKS, EXTRA_FIELDS, POINTER_TYPES, VARIABLE_ARRAYS } from './struct-overrides.ts';

export type CKind = 'int' | 'uint' | 'short' | 'ushort' | 'byte' | 'sbyte' | 'char' | 'ptr' | 'struct' | 'pad';

export interface GenField {
  name: string;
  offset: number;
  /** size of one element */
  size: number;
  /** array length (1 for scalars) */
  count: number;
  /** declared C type as written */
  ctype: string;
  kind: CKind;
  /** for kind 'struct' (inline) or 'ptr' to a known struct */
  target?: string;
  unestablished?: boolean;
  doc?: string;
}

export interface GenStruct {
  name: string;
  size: number;
  doc: string;
  fields: GenField[];
}

export interface GenGlobal {
  name: string;
  ctype: string;
  address: number;
  count: number;
}

const PRIM: Record<string, { kind: CKind; size: number }> = {
  int: { kind: 'int', size: 4 },
  int32_t: { kind: 'int', size: 4 },
  uint: { kind: 'uint', size: 4 },
  uint32_t: { kind: 'uint', size: 4 },
  short: { kind: 'short', size: 2 },
  int16_t: { kind: 'short', size: 2 },
  ushort: { kind: 'ushort', size: 2 },
  uint16_t: { kind: 'ushort', size: 2 },
  byte: { kind: 'byte', size: 1 },
  uint8_t: { kind: 'byte', size: 1 },
  int8_t: { kind: 'sbyte', size: 1 },
  char: { kind: 'char', size: 1 },
};

function parseNum(s: string): number {
  return s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
}

export function parseHeader(text: string): { structs: GenStruct[]; globals: GenGlobal[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const structs: GenStruct[] = [];
  const byName = new Map<string, GenStruct>();
  const globals: GenGlobal[] = [];
  let i = 0;
  let pendingStructDoc = '';
  let pendingSize = -1;
  while (i < lines.length) {
    const line = lines[i]!;
    const hdr = /^\/\* (\w+) - (\d+) \(0x[0-9a-f]+\) bytes(?: - (.*))? \*\/$/.exec(line);
    if (hdr) {
      pendingSize = Number(hdr[2]);
      pendingStructDoc = hdr[3] ?? '';
      i++;
      continue;
    }
    const open = /^struct (\w+) \{$/.exec(line);
    if (open) {
      const name = open[1]!;
      if (pendingSize < 0) throw new Error(`struct ${name} without a size comment (line ${i + 1})`);
      const st: GenStruct = { name, size: pendingSize, doc: pendingStructDoc, fields: [] };
      i++;
      let off = 0;
      let doc: string | undefined;
      let docOff: number | undefined;
      while (!/^\};/.test(lines[i]!)) {
        const l = lines[i]!.trim();
        i++;
        if (l === '') continue;
        const c = /^\/\* \+0x([0-9a-f]+)\s{2}(.*) \*\/$/.exec(l);
        if (c) {
          docOff = parseInt(c[1]!, 16);
          doc = c[2]!;
          continue;
        }
        const cOnly = /^\/\* \+0x([0-9a-f]+) \*\/$/.exec(l);
        if (cOnly) {
          docOff = parseInt(cOnly[1]!, 16);
          continue;
        }
        const d = /^(.+?)\s*(\**)\s*(\w+)((?:\[[0-9a-fx]+\])*);\s*(?:\/\* \+0x([0-9a-f]+) \*\/)?$/.exec(l);
        if (!d) throw new Error(`${name}: cannot parse field line ${i}: ${l}`);
        const rawType = d[1]!.trim();
        const stars = d[2]!;
        const fname = d[3]!;
        const dims = [...d[4]!.matchAll(/\[([0-9a-fx]+)\]/g)].map((m) => parseNum(m[1]!));
        const count = dims.reduce((a, b) => a * b, 1);
        const trailOff = d[5] !== undefined ? parseInt(d[5], 16) : undefined;
        let kind: CKind;
        let size: number;
        let target: string | undefined;
        const typeName = rawType.replace(/^struct\s+/, '').replace(/\s*\*$/, '');
        const isPtr = stars.length > 0 || /\*$/.test(rawType);
        if (isPtr) {
          kind = 'ptr';
          size = 4;
          if (typeName !== 'void' && typeName !== 'char' && !PRIM[typeName]) target = typeName;
        } else if (PRIM[typeName]) {
          ({ kind, size } = PRIM[typeName]!);
          if (fname.startsWith('pad_')) kind = 'pad';
        } else {
          const inner = byName.get(typeName);
          if (!inner) throw new Error(`${name}.${fname}: inline struct ${typeName} not defined yet`);
          kind = 'struct';
          size = inner.size;
          target = typeName;
        }
        const want = trailOff ?? docOff;
        if (want !== undefined && want !== off) {
          throw new Error(`${name}.${fname}: computed offset 0x${off.toString(16)} but header says 0x${want.toString(16)}`);
        }
        const f: GenField = { name: fname, offset: off, size, count, ctype: rawType + (stars ? ' ' + stars : ''), kind };
        if (target) f.target = target;
        if (/^field_0x/.test(fname)) f.unestablished = true;
        if (doc && docOff === off) f.doc = doc;
        st.fields.push(f);
        off += size * count;
        doc = undefined;
        docOff = undefined;
      }
      if (off !== st.size) throw new Error(`${name}: fields total 0x${off.toString(16)} but header says 0x${st.size.toString(16)}`);
      structs.push(st);
      byName.set(name, st);
      pendingSize = -1;
      i++;
      continue;
    }
    const g = /^extern\s+(.+?)\s+(\w+)(?:\[(\d+)\])?;\s+\/\* ([0-9a-f]{8}) \*\/$/.exec(line);
    if (g) {
      globals.push({ ctype: g[1]!.trim(), name: g[2]!, count: g[3] ? Number(g[3]) : 1, address: parseInt(g[4]!, 16) });
    }
    i++;
  }
  return { structs, globals };
}

function tsFieldType(f: GenField): string {
  const scalar = (() => {
    switch (f.kind) {
      case 'char':
        return f.count > 1 ? 'string' : 'number';
      case 'ptr':
        return 'number';
      case 'struct':
        return `Raw${f.target}`;
      default:
        return 'number';
    }
  })();
  if (f.kind === 'char' && f.count > 1) return 'string';
  return f.count > 1 ? `${scalar}[]` : scalar;
}

export function emit(structs: GenStruct[], globals: GenGlobal[]): { ts: string; docs: string } {
  const out: string[] = [];
  out.push('// GENERATED by tools/gen-structs.ts from decompiled/mw2/include/mw2_types.h.');
  out.push('// Do not edit. Run `npm run gen` after the decompilation changes.');
  out.push('');
  out.push("import type { StructSchema, GlobalSpec } from '../engine/schema/types.ts';");
  out.push('');
  for (const s of structs) {
    out.push(`/** ${s.name} - ${s.size} (0x${s.size.toString(16)}) bytes, as read raw from memory (pointers are addresses). */`);
    out.push(`export interface Raw${s.name} {`);
    for (const f of s.fields) {
      if (f.kind === 'pad') continue;
      out.push(`  /** +0x${f.offset.toString(16).padStart(3, '0')} ${f.ctype}${f.count > 1 ? `[${f.count}]` : ''} */`);
      out.push(`  ${f.name}: ${tsFieldType(f)};`);
    }
    out.push('}');
    out.push('');
  }
  out.push('export const STRUCTS = {');
  for (const s of structs) {
    const fields = s.fields.map((f) => {
      const parts = [`name: '${f.name}'`, `offset: 0x${f.offset.toString(16)}`, `size: ${f.size}`, `count: ${f.count}`, `ctype: ${JSON.stringify(f.ctype)}`, `kind: '${f.kind}'`];
      if (f.target) parts.push(`target: '${f.target}'`);
      if (f.unestablished) parts.push('unestablished: true');
      return `      { ${parts.join(', ')} },`;
    });
    out.push(`  ${s.name}: {`);
    out.push(`    name: '${s.name}',`);
    out.push(`    size: 0x${s.size.toString(16)},`);
    out.push('    fields: [');
    out.push(...fields);
    out.push('    ],');
    out.push('  },');
  }
  out.push('} as const satisfies Record<string, StructSchema>;');
  out.push('');
  out.push('export type StructName = keyof typeof STRUCTS;');
  out.push('');
  out.push('export const GLOBALS: readonly GlobalSpec[] = [');
  for (const g of globals) out.push(`  { name: '${g.name}', ctype: ${JSON.stringify(g.ctype)}, address: 0x${g.address.toString(16)}, count: ${g.count} },`);
  out.push('];');
  out.push('');
  const docs: Record<string, { doc: string; fields: Record<string, string> }> = {};
  for (const s of structs) {
    const fields: Record<string, string> = {};
    for (const f of s.fields) if (f.doc) fields[f.name] = f.doc;
    docs[s.name] = { doc: s.doc, fields };
  }
  return { ts: out.join('\n'), docs: JSON.stringify(docs, null, 1) + '\n' };
}

const TYPED_ARRAY: Partial<Record<CKind, string>> = {
  int: 'Int32Array',
  uint: 'Uint32Array',
  short: 'Int16Array',
  ushort: 'Uint16Array',
  byte: 'Uint8Array',
  sbyte: 'Int8Array',
  char: 'Int8Array',
};

/**
 * Live classes: one per struct, fields named and ordered as in C, with
 * defaults a zeroed allocation would have. See tools/struct-overrides.ts for
 * the representation choices (typed pointers, variable arrays, port-only
 * fields).
 */
export function emitClasses(structs: GenStruct[]): string {
  const known = new Set(structs.map((s) => s.name));
  const used = new Set<string>();
  const out: string[] = [];
  out.push('// GENERATED by tools/gen-structs.ts from decompiled/mw2/include/mw2_types.h.');
  out.push('// Do not edit. Run `npm run gen` after the decompilation changes.');
  out.push('//');
  out.push('// Live objects of every recovered struct. Field names, order and C widths');
  out.push("// are the decompilation's; pointers are object references; see");
  out.push('// tools/struct-overrides.ts for the representation choices.');
  out.push('');
  out.push("import type { SampleBuffer } from '../engine/miles/ail.ts';");
  out.push("import type { CodeFn, CodePtr } from '../engine/codePtr.ts';");
  out.push("import { STRUCTS } from './structs.gen.ts';");
  out.push('');
  for (const s of structs) {
    out.push(`/** ${s.name} - ${s.size} (0x${s.size.toString(16)}) bytes. */`);
    out.push(`export class ${s.name} {`);
    out.push(`  static readonly schema = STRUCTS.${s.name};`);
    // Block-backed fields: an Int32Array shared by consecutive int fields.
    const blockOf = new Map<string, { block: string; start: number }>();
    for (const b of BLOCKS[s.name] ?? []) {
      let len = 0;
      for (const fname of b.fields) {
        const f = s.fields.find((x) => x.name === fname);
        if (!f || (f.kind !== 'int' && f.kind !== 'uint')) throw new Error(`BLOCKS: ${s.name}.${fname} is not an int field`);
        blockOf.set(fname, { block: b.block, start: len });
        len += f.count;
      }
      out.push(`  /** port-only: backing store for ${b.fields.join(', ')} - one ${len}-int block in C */`);
      out.push(`  readonly ${b.block} = new Int32Array(${len});`);
    }
    for (const f of s.fields) {
      if (f.kind === 'pad') continue;
      const inBlock = blockOf.get(f.name);
      if (inBlock) {
        const off = `+0x${f.offset.toString(16).padStart(3, '0')}`;
        out.push(`  /** ${off} ${f.ctype}${f.count > 1 ? `[${f.count}]` : ''} (in ${inBlock.block}) */`);
        if (f.count > 1) out.push(`  readonly ${f.name}: Int32Array = this.${inBlock.block}.subarray(${inBlock.start}, ${inBlock.start + f.count});`);
        else {
          out.push(`  get ${f.name}(): number { return this.${inBlock.block}[${inBlock.start}]!; }`);
          out.push(`  set ${f.name}(v: number) { this.${inBlock.block}[${inBlock.start}] = v; }`);
        }
        continue;
      }
      const key = `${s.name}.${f.name}`;
      const off = `+0x${f.offset.toString(16).padStart(3, '0')}`;
      let type: string;
      let init: string;
      const ptrOverride = POINTER_TYPES[key];
      if (ptrOverride) used.add(key);
      if (VARIABLE_ARRAYS.has(key)) {
        used.add(key);
        const el = f.kind === 'struct' ? f.target! : f.kind === 'ptr' ? `${f.target ?? ptrOverride ?? 'unknown'} | null` : 'number';
        type = `${el.includes('|') ? `(${el})` : el}[]`;
        init = '[]';
      } else if (f.kind === 'ptr') {
        const target = ptrOverride ?? (f.target && known.has(f.target) ? f.target : f.ctype.startsWith('char') ? 'string' : 'unknown');
        const el = target === 'unknown' ? 'unknown' : `${target} | null`;
        if (f.count > 1) {
          type = `(${el})[]`;
          init = `new Array<${el}>(${f.count}).fill(null)`;
        } else {
          type = el;
          init = 'null';
        }
      } else if (f.kind === 'struct') {
        if (f.count > 1) {
          type = `${f.target}[]`;
          init = `Array.from({ length: ${f.count} }, () => new ${f.target}())`;
        } else {
          type = f.target!;
          init = `new ${f.target}()`;
        }
      } else if (f.kind === 'char' && f.count > 1) {
        type = 'string';
        init = "''";
      } else if (f.count > 1) {
        type = TYPED_ARRAY[f.kind]!;
        init = `new ${type}(${f.count})`;
      } else {
        type = 'number';
        init = '0';
      }
      out.push(`  /** ${off} ${f.ctype}${f.count > 1 ? `[${f.count}]` : ''}${f.unestablished ? ' - unestablished' : ''} */`);
      out.push(`  ${f.name}: ${type} = ${init};`);
    }
    for (const [name, type, init, doc] of EXTRA_FIELDS[s.name] ?? []) {
      out.push(`  /** port-only: ${doc} */`);
      out.push(`  ${name}: ${type} = ${init};`);
    }
    out.push('}');
    out.push('');
  }
  const unusedKeys = [...Object.keys(POINTER_TYPES), ...VARIABLE_ARRAYS].filter((k) => !used.has(k));
  if (unusedKeys.length) throw new Error(`struct-overrides names fields that do not exist: ${unusedKeys.join(', ')}`);
  for (const k of Object.keys(EXTRA_FIELDS)) if (!known.has(k)) throw new Error(`EXTRA_FIELDS names unknown struct ${k}`);
  return out.join('\n');
}

function main(): void {
  const hdr = path.join(mw2Decompiled(), 'mw2', 'include', 'mw2_types.h');
  const { structs, globals } = parseHeader(fs.readFileSync(hdr, 'utf8'));
  const { ts, docs } = emit(structs, globals);
  const dir = path.join(PORT_DIR, 'src', 'generated');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'structs.gen.ts'), ts);
  fs.writeFileSync(path.join(dir, 'structDocs.gen.json'), docs);
  fs.writeFileSync(path.join(dir, 'classes.gen.ts'), emitClasses(structs));
  console.log(`gen-structs: ${structs.length} structs, ${structs.reduce((a, s) => a + s.fields.length, 0)} fields, ${globals.length} globals`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
