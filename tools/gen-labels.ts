/**
 * Generates the catalogue of labelled globals from the decompilation's
 * decompiled/tools/MW2Types.java: every label(addr, name, why),
 * labelInt(...) and labelPtr(addr, name, type, why) call. And the shell's,
 * from Mw2shellTypes.java (parsePlaceLabels).
 *
 *   src/generated/labels.gen.ts       LABEL.<name> = address, and the kind
 *   src/generated/labelDocs.gen.json  each label's evidence note
 *   src/generated/shell/labels.gen.ts SHELL_LABEL, the same for MW2SHELL.EXE
 *
 * The port's globals take their boot values from the EXE image at these
 * addresses (engine/image.ts), so a global is never initialised from a
 * number typed in by hand. Arguments are Java expressions; only the address
 * and name literals are parsed, and the note is concatenated from its string
 * literals.
 *
 * Usage: tsx tools/gen-labels.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORT_DIR, mw2Decompiled } from './paths.ts';

interface Label {
  name: string;
  address: number;
  kind: 'int' | 'raw' | 'ptr';
  type?: string;
  doc: string;
}

/** Concatenates the Java string literals in an argument expression. */
function javaStrings(expr: string): string {
  let out = '';
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out += m[1]!.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  return out;
}

/** Splits a call's argument list at top-level commas (outside strings/parens). */
function splitArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      args.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  args.push(cur);
  return args;
}

export function parseLabels(java: string): Label[] {
  const out: Label[] = [];
  const re = /\b(label|labelInt|labelPtr)\(\s*0x([0-9a-fA-F]+)L\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(java))) {
    // find the matching close paren of this call
    let depth = 1;
    let inStr = false;
    let i = re.lastIndex;
    for (; i < java.length && depth > 0; i++) {
      const c = java[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const args = splitArgs(java.slice(re.lastIndex, i - 1));
    const name = javaStrings(args[0] ?? '');
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const kind = m[1] === 'labelInt' ? 'int' : m[1] === 'labelPtr' ? 'ptr' : 'raw';
    const l: Label = { name, address: parseInt(m[2]!, 16), kind, doc: javaStrings(args.slice(kind === 'ptr' ? 2 : 1).join(',')) };
    if (kind === 'ptr') l.type = javaStrings(args[1] ?? '');
    out.push(l);
  }
  return out;
}

/**
 * The shell's labels, from decompiled/tools/Mw2shellTypes.java: every
 * `place(ADDR, type, "name")`, where ADDR is a `0x...L` literal or one of the
 * file's `private static final long NAME = 0x...L` constants. The kind comes
 * from the type expression (IntegerDataType -> int, a pointer -> ptr, else
 * raw); the note is the `//` comment block directly above the call.
 */
export function parsePlaceLabels(java: string): Label[] {
  const consts = new Map<string, number>();
  for (const m of java.matchAll(/static\s+final\s+long\s+(\w+)\s*=\s*0x([0-9a-fA-F]+)L\s*;/g)) consts.set(m[1]!, parseInt(m[2]!, 16));
  const out: Label[] = [];
  const re = /\bplace\(\s*(0x([0-9a-fA-F]+)L|([A-Z_][A-Z0-9_]*))\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(java))) {
    const address = m[2] !== undefined ? parseInt(m[2], 16) : consts.get(m[3]!);
    if (address === undefined) throw new Error(`place(${m[3]}, ...): no such constant`);
    let depth = 1;
    let inStr = false;
    let i = re.lastIndex;
    for (; i < java.length && depth > 0; i++) {
      const c = java[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const args = splitArgs(java.slice(re.lastIndex, i - 1));
    const name = javaStrings(args[args.length - 1] ?? '');
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const type = args.slice(0, -1).join(',').trim();
    const kind: Label['kind'] = /^IntegerDataType\b/.test(type) ? 'int' : /^PointerDataType\.getPointer\(|^\w+Ptr$/.test(type) ? 'ptr' : 'raw';
    // the // comment lines directly above the call
    const before = java.slice(0, m.index).split('\n');
    before.pop();
    const doc: string[] = [];
    while (before.length && /^\s*\/\//.test(before[before.length - 1]!)) doc.unshift(before.pop()!.replace(/^\s*\/\/\s?/, ''));
    out.push({ name, address, kind, doc: doc.join(' ') });
  }
  return out;
}

function uniqueLabels(labels: Label[]): Label[] {
  const seen = new Map<string, Label>();
  for (const l of labels) {
    const prev = seen.get(l.name);
    if (prev && prev.address !== l.address) throw new Error(`label ${l.name} at two addresses: 0x${prev.address.toString(16)} and 0x${l.address.toString(16)}`);
    seen.set(l.name, l);
  }
  return [...seen.values()].sort((a, b) => a.address - b.address);
}

function write(uniq: Label[], source: string, dir: string, prefix: string, typeName: string): void {
  const ts: string[] = [
    `// GENERATED by tools/gen-labels.ts from decompiled/tools/${source}. Do not edit.`,
    '// Addresses of the globals the decompilation has labelled; notes in labelDocs.gen.json.',
    '',
    `export const ${prefix}LABEL = {`,
    ...uniq.map((l) => `  ${l.name}: 0x${l.address.toString(16)},`),
    '} as const;',
    '',
    `export type ${typeName} = keyof typeof ${prefix}LABEL;`,
    '',
    `export const ${prefix}LABEL_KIND: Record<${typeName}, 'int' | 'raw' | 'ptr'> = {`,
    ...uniq.map((l) => `  ${l.name}: '${l.kind}',`),
    '};',
    '',
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'labels.gen.ts'), ts.join('\n'));
  const docs: Record<string, { address: string; kind: string; type?: string; doc: string }> = {};
  for (const l of uniq) docs[l.name] = { address: '0x' + l.address.toString(16), kind: l.kind, ...(l.type ? { type: l.type } : {}), doc: l.doc };
  fs.writeFileSync(path.join(dir, 'labelDocs.gen.json'), JSON.stringify(docs, null, 1) + '\n');
}

function main(): void {
  const tools = path.join(mw2Decompiled(), 'tools');
  const gen = path.join(PORT_DIR, 'src', 'generated');
  const mw2 = uniqueLabels(parseLabels(fs.readFileSync(path.join(tools, 'MW2Types.java'), 'utf8')));
  write(mw2, 'MW2Types.java', gen, '', 'LabelName');
  const shell = uniqueLabels(parsePlaceLabels(fs.readFileSync(path.join(tools, 'Mw2shellTypes.java'), 'utf8')));
  write(shell, 'Mw2shellTypes.java', path.join(gen, 'shell'), 'SHELL_', 'ShellLabelName');
  console.log(`gen-labels: ${mw2.length} labels, shell ${shell.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
