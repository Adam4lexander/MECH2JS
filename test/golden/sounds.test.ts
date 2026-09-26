// Every SNDS resource in MW2.PRJ decoded by the port's SFLX decoder (or read
// as RIFF), printed the way tools/dump_sounds.py prints it and compared with
// listing/sounds.txt line by line; then every decoded sound compared byte for
// byte with the WAV the Python decoder wrote.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import {
  decodeSflx,
  parseRiffWave,
  readSoundRateTable,
  readSoundSettingsInit,
  SflxBuffers,
  sflxDecodeBlocks,
  SOUND_DEFAULT_PRIORITY,
} from '../../src/data/formats/sflx.ts';
import { gameSource, hasDecompiled, hasGameData, MW2_DECOMPILED, readListing } from '../support/env.ts';
import { expectSameLines, lines, padL, padR } from '../support/listing.ts';
import { rawRecordName } from '../support/formatHelpers.ts';

const WAV_DIR = path.join(MW2_DECOMPILED, 'mw2', 'sounds');
const hasWavs = fs.existsSync(WAV_DIR);
if (hasGameData && hasDecompiled && !hasWavs) {
  console.warn(
    `[golden] SKIPPING the SFLX PCM comparison: ${WAV_DIR} is missing (gitignored). ` +
      `Regenerate it with: python decompiled\\tools\\dump_sounds.py --wav decompiled\\mw2\\sounds`,
  );
}

interface Decoded {
  id: number;
  name: string;
  payload: Uint8Array;
  pcm: Uint8Array | null; // SFLX only
  riff: boolean;
}

describe.runIf(hasGameData && hasDecompiled)('SNDS sounds', () => {
  let prj: ProjectFile;
  let exe: ExeImage;
  const decoded: Decoded[] = [];

  beforeAll(async () => {
    prj = new ProjectFile(await gameSource().read('MW2.PRJ'));
    exe = ExeImage.fromExe(await gameSource().read('MW2.EXE'));
  });

  it('sounds.txt corresponds', () => {
    const defaultRate = readSoundRateTable(exe)[5]!;
    const table = new Map<number, [number, number, number]>();
    for (const r of readSoundSettingsInit(exe)) if (r.id > 0 && r.id < 0x4b0) table.set(r.id, [r.priority, r.maxPlaying, r.rate]);

    type Row =
      | { kind: 'riff'; id: number; name: string; frames: number; secs: number; bytes: number; desc: string }
      | { kind: 'sflx'; id: number; name: string; blocks: number; n: number; secs: number; bytes: number; prio: number; most: number; methods: number[]; shrinks: number[] };
    const rows: Row[] = [];
    const problems: string[] = [];
    let totalIn = 0;
    let totalSamples = 0;
    let riff = 0;
    let exact = 0;
    let extra = 0;
    const riffFormats = new Map<string, { key: [number, number, number]; n: number }>();
    const allMethods = new Map<number, number>();

    const t = prj.type('SNDS')!;
    for (let id = 0; id < t.entries.length; id++) {
      const [start, length] = t.entries[id]!;
      if (length === 0) continue;
      const name = rawRecordName(prj, start);
      const data = prj.bytes.subarray(start + t.recordPrefix, start + length);
      const wav = parseRiffWave(data);
      if (String.fromCharCode(...data.subarray(0, 4)) === 'RIFF') {
        if (!wav) {
          problems.push(`${id} ${name}: RIFF without WAVE fmt/data`);
          continue;
        }
        if (wav.formatTag !== 1) problems.push(`${id} ${name}: RIFF format tag ${wav.formatTag}, not PCM`);
        const frames = Math.floor(wav.data.length / Math.max(1, Math.floor((wav.channels * wav.bitsPerSample) / 8)));
        totalIn += data.length;
        rows.push({
          kind: 'riff', id, name, frames, secs: frames / wav.rate, bytes: data.length,
          desc: `PCM ${wav.bitsPerSample}-bit ${wav.channels === 1 ? 'mono' : 'stereo'} ${wav.rate} Hz`,
        });
        riff++;
        const k = `${wav.bitsPerSample},${wav.channels},${wav.rate}`;
        const e = riffFormats.get(k) ?? { key: [wav.bitsPerSample, wav.channels, wav.rate] as [number, number, number], n: 0 };
        e.n++;
        riffFormats.set(k, e);
        decoded.push({ id, name, payload: data, pcm: null, riff: true });
        continue;
      }
      // dump_sounds.py starts each sound from a scratch of 0x80s; the game's
      // holds whatever the last decoded block left (see SflxBuffers).
      const snd = decodeSflx(data, new SflxBuffers(0x80));
      if (!snd) {
        problems.push(`${id} ${name}: neither SFLX nor RIFF`);
        continue;
      }
      const { blocks, blockLen, sizeField } = snd.header;
      if (sizeField !== data.length - 4) problems.push(`${id} ${name}: size ${sizeField}, payload ${data.length}`);
      if (snd.error) problems.push(`${id} ${name}: ${snd.error}`);
      else {
        // the one block beyond the count must account for every remaining byte
        let ok: boolean;
        if (snd.end === data.length) {
          exact++;
          ok = true;
        } else {
          let next: number | null;
          try {
            next = sflxDecodeBlocks(data, snd.end, new Uint8Array(blockLen), 0, 1, blockLen, { value: 0 }, new SflxBuffers(0x80));
          } catch {
            next = null;
          }
          ok = next === data.length;
          if (ok) extra++;
        }
        if (!ok) problems.push(`${id} ${name}: ${data.length - snd.end} bytes after the counted blocks are not one block`);
      }
      const set = table.get(id) ?? [-1, -1, -1];
      const rate = set[2] === -1 ? defaultRate : set[2];
      const prio = set[0] === -1 ? SOUND_DEFAULT_PRIORITY : set[0];
      const n = snd.decodedBlocks * blockLen;
      totalIn += data.length;
      totalSamples += n;
      const methods = [0, 0, 0, 0, 0, 0];
      const shrinks = [0, 0, 0];
      for (const m of snd.stats.methods) {
        if (m < 6) methods[m]!++;
        allMethods.set(m, (allMethods.get(m) ?? 0) + 1);
      }
      for (const s of snd.stats.shrinks) if (s < 3) shrinks[s]!++;
      rows.push({ kind: 'sflx', id, name, blocks, n, secs: n / rate, bytes: data.length, prio, most: set[1], methods, shrinks });
      decoded.push({ id, name, payload: data, pcm: snd.error ? null : snd.pcm, riff: false });
    }

    const fmtList = [...riffFormats.values()]
      .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
      .map((f) => `${f.n} x ${f.key[0]}-bit ${f.key[1] === 1 ? 'mono' : 'stereo'} ${f.key[2]} Hz`)
      .join(', ');
    const L: string[] = [
      'MW2 sounds - SNDS resources in MW2.PRJ, decoded by tools/dump_sounds.py',
      `SFLX codec: 128-sample blocks, mono 8-bit unsigned, ${defaultRate} Hz for every sound (no per-sound rate is set)`,
      'method 0 silence, 1 repeat, 2/3/4 delta with 1/2/4-bit codes, 5 raw; shrink x2 / x4 = stored at half / quarter length and linearly upsampled',
      'priority: the channel-stealing priority (default 0x32 = 50); max: most copies playing at once (-1 unlimited)',
      '',
      `${rows.length} sounds: ${rows.length - riff} SFLX (${totalSamples} samples, ${(totalSamples / defaultRate).toFixed(1)} s; blocks by method ${[...allMethods.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, v]) => `${k}:${v}`)
        .join(', ')}) and ${riff} RIFF WAV ambient loops; ${totalIn} bytes stored`,
      `decode check: ${
        problems.length
          ? `${problems.length} PROBLEMS`
          : `every SFLX record's size field is its payload - 4 and its counted blocks decode; ${exact} end exactly there and ${extra} carry exactly one further, never-played block; the RIFF records are PCM: ${fmtList}`
      }`,
      '',
      ' id  name        blocks  samples   secs   bytes  prio max  methods (0/1/2/3/4/5)       shrink (1/x2/x4)',
    ];
    for (const p of problems) L.splice(8, 0, '  PROBLEM ' + p);
    for (const r of rows) {
      if (r.kind === 'riff') {
        L.push(`${padL(r.id, 3)}  ${padR(r.name, 10)}   RIFF ${padL(r.frames, 8)} ${padL(r.secs.toFixed(2), 6)} ${padL(r.bytes, 7)}   ${r.desc}, ambient loop (sound_emitter_update)`);
      } else {
        L.push(
          `${padL(r.id, 3)}  ${padR(r.name, 10)} ${padL(r.blocks, 6)} ${padL(r.n, 8)} ${padL(r.secs.toFixed(2), 6)} ${padL(r.bytes, 7)}  ${padL(r.prio, 4)} ${padL(r.most, 3)}  ${padR(r.methods.join('/'), 26)} ${r.shrinks.join('/')}`,
        );
      }
    }
    expect(problems).toEqual([]);
    expectSameLines('sounds.txt', lines(readListing('sounds.txt')), L);
  });

  describe.runIf(hasWavs)('decoded PCM matches decompiled/mw2/sounds/*.wav', () => {
    it('every SFLX data chunk byte-equal, every RIFF record copied unchanged', () => {
      expect(decoded.length).toBeGreaterThan(0);
      let sflx = 0;
      let riffN = 0;
      const bad: string[] = [];
      for (const d of decoded) {
        const file = path.join(WAV_DIR, `${String(d.id).padStart(3, '0')}_${d.name}.wav`);
        if (!fs.existsSync(file)) {
          bad.push(`${file} missing`);
          continue;
        }
        const bytes = new Uint8Array(fs.readFileSync(file));
        if (d.riff) {
          riffN++;
          if (!equalBytes(bytes, d.payload)) bad.push(`${d.id} ${d.name}: RIFF file differs from the resource`);
          continue;
        }
        sflx++;
        const w = parseRiffWave(bytes);
        if (!w || !d.pcm) {
          bad.push(`${d.id} ${d.name}: no data chunk / not decoded`);
          continue;
        }
        if (!equalBytes(w.data, d.pcm)) {
          const at = firstDiff(w.data, d.pcm);
          bad.push(`${d.id} ${d.name}: PCM differs at sample ${at} (wav ${w.data.length}, port ${d.pcm.length})`);
        }
      }
      expect(bad.slice(0, 20)).toEqual([]);
      expect(sflx).toBe(337);
      expect(riffN).toBe(28);
    });
  });
});

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}
