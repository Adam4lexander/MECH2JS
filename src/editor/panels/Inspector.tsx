/**
 * The inspector: every field of the selected struct, in memory order, with
 * its offset, C type, live value and the decompilation's evidence note for
 * it. Scalars and array elements are editable; edits are stored with the
 * field's C width. Pointer fields are links; code pointers show the original
 * function they are the port of. Fields the decompilation has not
 * established (field_0x..) are greyed.
 *
 * @portOnly
 */
import { useEffect, useState } from 'react';
import { STRUCTS } from '../../generated/structs.gen.ts';
import type { FieldSpec, StructSchema } from '../../engine/schema/types.ts';
import { codeInfo } from '../../engine/codePtr.ts';
import { engineStore, editorStore, useRevision } from '../store/store.ts';
import { select, selected } from '../store/selection.ts';
import { syncNodeFromFields } from '../inspector/poseSync.ts';
import { coerce, formatValue, parseValue, storeValue, VIEWS, type View } from '../inspector/format.ts';

type Docs = Record<string, { doc: string; fields: Record<string, string> }>;
let docsPromise: Promise<Docs> | null = null;
function loadDocs(): Promise<Docs> {
  docsPromise ??= import('../../generated/structDocs.gen.json').then((m) => m.default as Docs);
  return docsPromise;
}

const schemas = STRUCTS as Record<string, StructSchema>;

/** The struct name of a live object, from its class (generated classes carry a static schema). */
export function structOf(o: unknown): string | null {
  if (o && typeof o === 'object') {
    const s = (o.constructor as { schema?: StructSchema }).schema;
    if (s) return s.name;
  }
  return null;
}

function linkLabel(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'function') {
    const info = codeInfo(v as never);
    return info ? `${info.name} @0x${info.address.toString(16)}` : 'fn (not a ported original)';
  }
  const s = structOf(v);
  return s ? `→ ${s}` : typeof v === 'object' ? '→ object' : String(v);
}

function ValueCell({ obj, field, index, view }: { obj: Record<string, unknown>; field: FieldSpec; index: number | null; view: View }) {
  const read = (): number => (index === null ? (obj[field.name] as number) : (obj[field.name] as ArrayLike<number>)[index]!);
  const [editing, setEditing] = useState<string | null>(null);
  const v = read();
  if (editing !== null) {
    return (
      <input
        className="insp-edit"
        autoFocus
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(null);
          if (e.key === 'Enter') {
            const n = parseValue(editing, view);
            if (n !== null) {
              const c = coerce(n, field.kind);
              storeValue(obj, field.name, index, c);
              syncNodeFromFields(obj, field.name);
              engineStore.bump();
            }
            setEditing(null);
          }
        }}
      />
    );
  }
  return (
    <span className="insp-value" title="click to edit" onClick={() => setEditing(formatValue(v, view, field.kind))}>
      {formatValue(v, view, field.kind)}
    </span>
  );
}

function FieldRows({ obj, schema, docs, view, depth }: { obj: Record<string, unknown>; schema: StructSchema; docs: Docs | null; view: View; depth: number }) {
  const rows: React.ReactNode[] = [];
  for (const f of schema.fields) {
    if (f.kind === 'pad') continue;
    const doc = docs?.[schema.name]?.fields[f.name];
    const off = '+0x' + f.offset.toString(16).padStart(3, '0');
    const nameCell = (
      <span className={`insp-name${f.unestablished ? ' unestablished' : ''}`} title={doc ?? (f.unestablished ? 'not established' : '')} style={{ paddingLeft: depth * 12 }}>
        {f.name}
      </span>
    );
    const v = obj[f.name];
    const key = `${schema.name}.${f.name}`;
    if (f.kind === 'char' && f.count > 1) {
      rows.push(
        <div className="insp-row" key={key}>
          <span className="insp-off">{off}</span>
          {nameCell}
          <span className="insp-type">{f.ctype}[{f.count}]</span>
          <span className="insp-value">"{String(v ?? '')}"</span>
        </div>,
      );
    } else if (f.kind === 'ptr') {
      const items = f.count > 1 ? (v as unknown[]) : [v];
      items.forEach((it, i) =>
        rows.push(
          <div className="insp-row" key={`${key}[${i}]`}>
            <span className="insp-off">{off}</span>
            {nameCell}
            <span className="insp-type">
              {f.ctype}
              {f.count > 1 ? `[${i}]` : ''}
            </span>
            <span
              className={`insp-link${it && typeof it === 'object' ? ' clickable' : ''}`}
              onClick={() => {
                if (it && typeof it === 'object') select({ label: `${schema.name}.${f.name}`, struct: structOf(it), target: it });
              }}
            >
              {linkLabel(it)}
            </span>
          </div>,
        ),
      );
    } else if (f.kind === 'struct') {
      const items = f.count > 1 ? (v as object[]) : [v as object];
      items.forEach((it, i) => {
        rows.push(
          <div className="insp-row insp-struct" key={`${key}[${i}]`}>
            <span className="insp-off">{off}</span>
            {nameCell}
            <span className="insp-type">
              {f.target}
              {f.count > 1 ? `[${i}]` : ''}
            </span>
            <span />
          </div>,
        );
        if (it && schemas[f.target!]) rows.push(<FieldRows key={`${key}[${i}].body`} obj={it as Record<string, unknown>} schema={schemas[f.target!]!} docs={docs} view={view} depth={depth + 1} />);
      });
    } else if (f.count > 1) {
      for (let i = 0; i < f.count; i++)
        rows.push(
          <div className="insp-row" key={`${key}[${i}]`}>
            <span className="insp-off">{'+0x' + (f.offset + i * f.size).toString(16).padStart(3, '0')}</span>
            {i === 0 ? nameCell : <span className="insp-name" style={{ paddingLeft: depth * 12 }} />}
            <span className="insp-type">
              {f.ctype}[{i}]
            </span>
            <ValueCell obj={obj} field={f} index={i} view={view} />
          </div>,
        );
    } else {
      rows.push(
        <div className="insp-row" key={key}>
          <span className="insp-off">{off}</span>
          {nameCell}
          <span className="insp-type">{f.ctype}</span>
          <ValueCell obj={obj} field={f} index={null} view={view} />
        </div>,
      );
    }
  }
  return <>{rows}</>;
}

function PlainObject({ obj }: { obj: Record<string, unknown> }) {
  return (
    <>
      {Object.entries(obj).map(([k, v]) => (
        <div className="insp-row" key={k}>
          <span className="insp-off" />
          <span className="insp-name">{k}</span>
          <span className="insp-type">{Array.isArray(v) ? `array[${v.length}]` : v === null ? 'null' : typeof v}</span>
          <span
            className={`insp-value${v && typeof v === 'object' ? ' clickable' : ''}`}
            onClick={() => {
              if (v && typeof v === 'object') select({ label: k, struct: structOf(v), target: v });
            }}
          >
            {v && typeof v === 'object' ? (structOf(v) ? `→ ${structOf(v)}` : Array.isArray(v) ? `[${v.length}]` : '→ object') : String(v)}
          </span>
        </div>
      ))}
    </>
  );
}

export function Inspector() {
  useRevision(engineStore);
  useRevision(editorStore);
  const [docs, setDocs] = useState<Docs | null>(null);
  const [view, setView] = useState<View>('dec');
  useEffect(() => {
    void loadDocs().then(setDocs);
  }, []);
  const sel = selected();
  if (!sel) return <div className="panel-empty">Select something in the hierarchy or the viewport.</div>;
  const struct = sel.struct ?? structOf(sel.target);
  const schema = struct ? schemas[struct] : undefined;
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-title">{sel.label}</span>
        <span className="insp-struct-name">
          {schema ? `${schema.name} · ${schema.size} (0x${schema.size.toString(16)}) bytes` : 'object'}
        </span>
        <select value={view} onChange={(e) => setView(e.target.value as View)}>
          {VIEWS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {schema && docs?.[schema.name]?.doc ? <div className="insp-doc">{docs[schema.name]!.doc}</div> : null}
      <div className="insp-body">
        {Array.isArray(sel.target) ? (
          (sel.target as unknown[]).map((it, i) => (
            <div className="insp-row" key={i}>
              <span className="insp-off">[{i}]</span>
              <span
                className="insp-name clickable"
                onClick={() => it && typeof it === 'object' && select({ label: `${sel.label}[${i}]`, struct: structOf(it), target: it })}
              >
                {it && typeof it === 'object' ? (((it as { name?: unknown }).name as string) || structOf(it) || 'object') : String(it)}
              </span>
              <span />
              <span />
            </div>
          ))
        ) : schema ? (
          <FieldRows obj={sel.target as Record<string, unknown>} schema={schema} docs={docs} view={view} depth={0} />
        ) : (
          <PlainObject obj={sel.target as Record<string, unknown>} />
        )}
      </div>
    </div>
  );
}
