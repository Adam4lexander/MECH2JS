/**
 * Downloads the General MIDI SoundFont the front end's music plays with
 * (src/audio/gmSynth.ts) into public/soundfont/, which git ignores.
 *
 *   npm run fetch-soundfont
 *
 * GeneralUser GS 2.0.3 by S. Christian Collins, GeneralUser GS License
 * v2.0 (free to use, modify and redistribute, including in software; see
 * https://www.schristiancollins.com/generaluser). The file is the SF3 the
 * SpessaSynth project ships, pinned to a commit and checked by SHA-256, so
 * a local copy is byte-identical to what the synth otherwise fetches from
 * jsDelivr. Without it the port still runs; the music then comes from the
 * CDN, or is silent offline.
 *
 * @portOnly tooling
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the same pin as src/audio/gmSynth.ts (that module needs the DOM and vite, so it is not imported here)
const COMMIT = '6f7505087eba09bdbf345c97f5cf573fc547412e';
const FILE = 'GeneralUserGS.sf3';
const SHA256 = 'e2ed326ff44d15f78f2fdc72403b6fa6b77ee7266d3aad0d2198bc95797bc66c';
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/spessasus/SpessaSynth@${COMMIT}/soundfonts/${FILE}`,
  `https://raw.githubusercontent.com/spessasus/SpessaSynth/${COMMIT}/soundfonts/${FILE}`,
];

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'soundfont');
const target = path.join(dir, FILE);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function main(): Promise<void> {
  if (fs.existsSync(target) && sha(fs.readFileSync(target)) === SHA256) {
    console.log(`${target}: already present`);
    return;
  }
  for (const url of SOURCES) {
    try {
      console.log(`fetching ${url}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = new Uint8Array(await r.arrayBuffer());
      const got = sha(b);
      if (got !== SHA256) throw new Error(`SHA-256 ${got}, expected ${SHA256}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, b);
      console.log(`${target}: ${b.length} bytes`);
      return;
    } catch (e) {
      console.warn(`  failed: ${(e as Error).message}`);
    }
  }
  console.error('no source answered; the port will fetch the SoundFont from the CDN at run time, or play silent');
  process.exitCode = 1;
}

await main();
