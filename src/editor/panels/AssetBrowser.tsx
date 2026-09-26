/**
 * Every resource in MW2.PRJ, by type, with a preview through the port's own
 * parsers (hex for types not decoded yet).
 *
 * @portOnly
 */
import { useMemo, useState } from 'react';
import type { ProjectFile } from '../../data/prj/ProjectFile.ts';
import { pal6to8 } from '../../data/formats/image.ts';
import { BwdPreview, CelPreview, HexDump, LumaPreview, MekPreview, PalPreview, paletteRgb, PolyPreview, SndsPreview } from '../assets/previews.tsx';

export function AssetBrowser({ prj }: { prj: ProjectFile }) {
  const types = useMemo(() => prj.types.filter((t) => t.entries.length > 0).map((t) => t.tag), [prj]);
  const [type, setType] = useState('POLY');
  const [filter, setFilter] = useState('');
  const [id, setId] = useState<number | null>(null);
  const pals = useMemo(() => prj.list('PAL'), [prj]);
  const [palId, setPalId] = useState<number>(() => pals.find((p) => /_DA$/.test(p.name))?.id ?? pals[0]?.id ?? 1);
  const rgb = useMemo(() => paletteRgb(prj, palId), [prj, palId]);
  const list = useMemo(() => prj.list(type).filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()) || String(r.id) === filter), [prj, type, filter]);
  const data = id !== null ? prj.readResource(type, id) : null;
  const name = id !== null ? prj.resourceName(type, id) : '';

  let preview: React.ReactNode = null;
  if (data) {
    switch (type) {
      case 'PAL':
        preview = <PalPreview rgb={pal6to8(data.subarray(0, 768))} />;
        break;
      case 'LUMA':
        preview = <LumaPreview data={data} rgb={rgb} />;
        break;
      case 'CEL':
        preview = <CelPreview data={data} rgb={rgb} />;
        break;
      case 'POLY':
        preview = <PolyPreview data={data} rgb={rgb} />;
        break;
      case 'SNDS':
        preview = <SndsPreview data={data} />;
        break;
      case 'BWD':
        preview = <BwdPreview data={data} name={name} />;
        break;
      case 'MEK':
        preview = <MekPreview data={data} />;
        break;
      default:
        preview = <HexDump bytes={data} />;
    }
  }

  return (
    <div className="assets">
      <div className="assets-bar">
        <select value={type} onChange={(e) => (setType(e.target.value), setId(null))}>
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>
          palette{' '}
          <select value={palId} onChange={(e) => setPalId(Number(e.target.value))}>
            {pals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">{list.length} resources</span>
      </div>
      <div className="assets-body">
        <div className="assets-list">
          {list.map((r) => (
            <div key={r.id} className={`asset-row${id === r.id ? ' selected' : ''}`} onClick={() => setId(r.id)}>
              <span className="asset-id">{r.id}</span>
              <span className="asset-name">{r.name || '(unnamed)'}</span>
              <span className="asset-size">{r.size}</span>
            </div>
          ))}
        </div>
        <div className="assets-preview">
          {data ? (
            <>
              <div className="preview-title">
                {type} {id} · {name} · {data.length} bytes
              </div>
              {preview}
            </>
          ) : (
            <div className="panel-empty">Select a resource.</div>
          )}
        </div>
      </div>
    </div>
  );
}
