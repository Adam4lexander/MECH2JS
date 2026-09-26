/**
 * Previews for the asset browser, one per resource type the port decodes.
 * Everything is drawn from the original data through the port's parsers; the
 * palette used for indexed images is selectable.
 *
 * @portOnly
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFile } from '../../data/prj/ProjectFile.ts';
import { pal6to8, parseCel, parseLuma, parsePal } from '../../data/formats/image.ts';
import { parseWtboBlock } from '../../data/formats/wtbo.ts';
import { decodeSflx, parseRiffWave } from '../../data/formats/sflx.ts';
import { parseMek } from '../../data/formats/mek.ts';
import { walkStream } from '../../data/bwd/stream.ts';
import { MeshPreview } from './MeshPreview.tsx';

/** A PAL resource as 8-bit display RGB (PAL data is 6-bit). */
export function paletteRgb(prj: ProjectFile, id: number): Uint8Array {
  const b = prj.readResource('PAL', id);
  return b ? pal6to8(parsePal(b).rgb) : new Uint8Array(768).map((_, i) => ((i / 3) | 0) & 0xff);
}

function IndexedCanvas({ w, h, pixels, rgb, scale = 2 }: { w: number; h: number; pixels: Uint8Array; rgb: Uint8Array; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const p = pixels[i]!;
      img.data[i * 4] = rgb[p * 3]!;
      img.data[i * 4 + 1] = rgb[p * 3 + 1]!;
      img.data[i * 4 + 2] = rgb[p * 3 + 2]!;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [w, h, pixels, rgb]);
  return <canvas ref={ref} width={w} height={h} style={{ width: w * scale, height: h * scale, imageRendering: 'pixelated' }} />;
}

export function PalPreview({ rgb }: { rgb: Uint8Array }) {
  const pixels = useMemo(() => Uint8Array.from({ length: 256 }, (_, i) => i), []);
  return (
    <div>
      <IndexedCanvas w={16} h={16} pixels={pixels} rgb={rgb} scale={16} />
      <div className="hint">16 ramps of 16 shades; index = ramp * 16 + shade (polygon_resolve_colour)</div>
    </div>
  );
}

export function LumaPreview({ data, rgb }: { data: Uint8Array; rgb: Uint8Array }) {
  const { rows } = parseLuma(data);
  return (
    <div>
      <IndexedCanvas w={256} h={16} pixels={rows} rgb={rgb} scale={3} />
      <div className="hint">row = shade level 0..15 (row 15 is the identity), column = palette index</div>
    </div>
  );
}

export function CelPreview({ data, rgb }: { data: Uint8Array; rgb: Uint8Array }) {
  const c = parseCel(data);
  return (
    <div>
      <IndexedCanvas w={c.width} h={c.height} pixels={c.pixels} rgb={rgb} scale={Math.max(1, Math.min(4, Math.floor(256 / Math.max(c.width, c.height))))} />
      <div className="hint">
        {c.width} × {c.height}
      </div>
    </div>
  );
}

export function PolyPreview({ data, rgb }: { data: Uint8Array; rgb: Uint8Array }) {
  const { records, trailing } = parseWtboBlock(data);
  return (
    <div className="poly-preview">
      <MeshPreview records={records} rgb={rgb} />
      <table className="kv">
        <tbody>
          {records.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td>flags 0x{r.flags.toString(16)}</td>
              <td>{r.vertexCount} v</td>
              <td>{r.polygonCount} p</td>
              <td>{r.computedChecksum === r.checksum ? 'checksum ok' : 'CHECKSUM MISMATCH'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {trailing ? <div className="hint">{trailing} bytes after the last record</div> : null}
    </div>
  );
}

let audioCtx: AudioContext | null = null;
function play8bit(pcm: Uint8Array, rate: number): void {
  audioCtx ??= new AudioContext();
  const buf = audioCtx.createBuffer(1, pcm.length, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i]! - 128) / 128;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start();
}

export function SndsPreview({ data }: { data: Uint8Array }) {
  const sflx = useMemo(() => decodeSflx(data), [data]);
  const riff = useMemo(() => (sflx ? null : parseRiffWave(data)), [data, sflx]);
  if (sflx)
    return (
      <div>
        <button onClick={() => play8bit(sflx.pcm, 11025)}>▶ play</button>
        <div className="hint">
          SFLX · {sflx.header.blocks} blocks × {sflx.header.blockLen} · {(sflx.pcm.length / 11025).toFixed(2)} s at 11025 Hz{sflx.error ? ` · ${sflx.error}` : ''}
        </div>
      </div>
    );
  if (riff)
    return (
      <div>
        <button onClick={() => play8bit(riff.bitsPerSample === 8 ? riff.data : new Uint8Array(0), riff.rate)}>▶ play</button>
        <div className="hint">
          RIFF WAVE · {riff.rate} Hz · {riff.bitsPerSample} bit · {riff.channels} ch (the game forces mono 8-bit and its own rate)
        </div>
      </div>
    );
  return <div className="hint">not SFLX or RIFF</div>;
}

export function BwdPreview({ data, name }: { data: Uint8Array; name: string }) {
  const chunks = useMemo(() => [...walkStream(data, name)], [data, name]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="bwd">
      {chunks.map((c, i) => (
        <div key={i}>
          <div className="bwd-chunk clickable" onClick={() => setOpen(open === i ? null : i)}>
            <span className="bwd-tag">{c.tag}</span> <span className="hint">+{c.offset} · {c.size} bytes</span>
          </div>
          {open === i ? <HexDump bytes={c.bytes} /> : null}
        </div>
      ))}
    </div>
  );
}

export function MekPreview({ data }: { data: Uint8Array }) {
  const m = useMemo(() => parseMek(data), [data]);
  return m ? <pre className="json">{JSON.stringify(m, (_k, v) => (v instanceof Uint8Array ? `[${v.length} bytes]` : v), 1)}</pre> : <div className="hint">not a MEK record</div>;
}

export function HexDump({ bytes, max = 4096 }: { bytes: Uint8Array; max?: number }) {
  const lines: string[] = [];
  for (let o = 0; o < Math.min(bytes.length, max); o += 16) {
    const row = bytes.subarray(o, Math.min(o + 16, bytes.length));
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${o.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${asc}`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
  return <pre className="hex">{lines.join('\n')}</pre>;
}
