/**
 * The General MIDI device the front end's music plays on: a MidiOut
 * (engine/miles/xmidiSequencer.ts) over WebAudio, synthesised from a GM
 * SoundFont by spessasynth_lib (Apache-2.0) in an AudioWorklet.
 *
 * The original sent the XMIDI's GM arrangement (DATABASE.MW2 items 66..73)
 * to whatever General MIDI device an MPU-401 / Sound Canvas / Ultrasound
 * driver drove; the port's device is this synth. The instrument sounds are
 * therefore the SoundFont's, not a 1995 card's.
 *
 * The SoundFont is not game data and is not in git. It is GeneralUser GS
 * 2.0.3 by S. Christian Collins (GeneralUser GS License v2.0: free to use,
 * modify and redistribute, including in software), as the SF3 (Vorbis-
 * compressed, 8.4 MB) the SpessaSynth project ships. It is looked for:
 *
 *   1. at <base>/soundfont/GeneralUserGS.sf3 - `npm run fetch-soundfont`
 *      puts it there (public/soundfont/, gitignored);
 *   2. on jsDelivr, pinned to a SpessaSynth commit, so the bytes cannot
 *      change under the port.
 *
 * When neither answers, `ready` resolves false, one warning is logged and
 * every message is dropped: the front end runs silent.
 *
 * @portOnly the host's MIDI device (the original's was hardware)
 */
import { WorkletSynthesizer } from 'spessasynth_lib';
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url';
import type { MidiOut } from '../engine/miles/xmidiSequencer.ts';

/** The pinned SpessaSynth commit whose soundfonts/GeneralUserGS.sf3 the port uses. */
export const GM_SOUNDFONT_COMMIT = '6f7505087eba09bdbf345c97f5cf573fc547412e';
export const GM_SOUNDFONT_FILE = 'GeneralUserGS.sf3';
/** SHA-256 of that file (tools/fetch-soundfont.ts checks it). */
export const GM_SOUNDFONT_SHA256 = 'e2ed326ff44d15f78f2fdc72403b6fa6b77ee7266d3aad0d2198bc95797bc66c';
export const GM_SOUNDFONT_CDN = `https://cdn.jsdelivr.net/gh/spessasus/SpessaSynth@${GM_SOUNDFONT_COMMIT}/soundfonts/${GM_SOUNDFONT_FILE}`;

/** Where the SoundFont is looked for, in order. */
export function gmSoundFontUrls(): string[] {
  return [`${import.meta.env.BASE_URL}soundfont/${GM_SOUNDFONT_FILE}`, GM_SOUNDFONT_CDN];
}

export interface GmSynthOptions {
  /** where to look for the SoundFont, in order (default gmSoundFontUrls()) */
  urls?: readonly string[];
  /** output gain, 1 = the synth's own level */
  gain?: number;
}

/** The worklet module, added once per AudioContext. */
const modules = new WeakMap<BaseAudioContext, Promise<void>>();
function addProcessor(ctx: BaseAudioContext): Promise<void> {
  let p = modules.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(processorUrl);
    modules.set(ctx, p);
  }
  return p;
}

/** SoundFont bytes are cached for the page: a second synth does not download them again. */
let soundFont: Promise<{ url: string; bytes: ArrayBuffer } | null> | null = null;

async function fetchFirst(urls: readonly string[]): Promise<{ url: string; bytes: ArrayBuffer } | null> {
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const bytes = await r.arrayBuffer();
      // a dev server answers a missing file with index.html and 200: only a RIFF is a SoundFont
      const h = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
      if (String.fromCharCode(...h.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...h.subarray(8, 12)) !== 'sfbk') continue;
      return { url, bytes };
    } catch {
      // offline, CORS, a blocked host: try the next one
    }
  }
  return null;
}

/** Fetches the SoundFont (once per page). Null when no source answered. */
export function loadGmSoundFont(urls: readonly string[] = gmSoundFontUrls()): Promise<{ url: string; bytes: ArrayBuffer } | null> {
  if (!soundFont) soundFont = fetchFirst(urls);
  return soundFont;
}

export class GmSynth implements MidiOut {
  /** true once the SoundFont is loaded and messages sound; false when the synth is unavailable. Never rejects. */
  readonly ready: Promise<boolean>;
  private synth: WorkletSynthesizer | null = null;
  private readonly out: GainNode;
  private when: number | null = null;
  private disposed = false;

  constructor(
    readonly ctx: AudioContext,
    destination: AudioNode,
    opts: GmSynthOptions = {},
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = opts.gain ?? 1;
    this.out.connect(destination);
    this.ready = this.open(opts.urls ?? gmSoundFontUrls());
  }

  private async open(urls: readonly string[]): Promise<boolean> {
    try {
      const sf = await loadGmSoundFont(urls);
      if (!sf) {
        console.warn(`[gmSynth] no General MIDI SoundFont at ${urls.join(' or ')}; the music is silent (run \`npm run fetch-soundfont\` for a local copy)`);
        return false;
      }
      await addProcessor(this.ctx);
      if (this.disposed) return false;
      const synth = new WorkletSynthesizer(this.ctx);
      // the bytes stay cached for another synth: the worklet gets a copy
      await synth.soundBankManager.addSoundBank(sf.bytes.slice(0), 'gm');
      await synth.isReady;
      if (this.disposed) {
        synth.destroy();
        return false;
      }
      synth.connect(this.out);
      this.synth = synth;
      return true;
    } catch (e) {
      console.warn('[gmSynth] the General MIDI synth could not start; the music is silent', e);
      return false;
    }
  }

  /**
   * The audio-clock time (ctx.currentTime seconds) the next messages are
   * meant for, or null for "now". A host that runs several 1/120 s services
   * in one frame sets each one's time so the notes keep their spacing.
   */
  at(time: number | null): void {
    this.when = time;
  }

  private opt(): { time: number } | undefined {
    return this.when === null ? undefined : { time: this.when };
  }

  noteOn(ch: number, key: number, vel: number): void {
    this.synth?.noteOn(ch, key, vel, this.opt());
  }

  noteOff(ch: number, key: number): void {
    this.synth?.noteOff(ch, key, this.opt());
  }

  controlChange(ch: number, cc: number, value: number): void {
    this.synth?.controllerChange(ch, cc as Parameters<WorkletSynthesizer['controllerChange']>[1], value, this.opt());
  }

  programChange(ch: number, program: number): void {
    this.synth?.programChange(ch, program, this.opt());
  }

  pitchBend(ch: number, value14: number): void {
    this.synth?.pitchWheel(ch, value14, this.opt());
  }

  polyPressure(ch: number, key: number, value: number): void {
    this.synth?.polyPressure(ch, key, value, this.opt());
  }

  channelPressure(ch: number, value: number): void {
    this.synth?.channelPressure(ch, value, this.opt());
  }

  sysex(bytes: Uint8Array): void {
    // spessasynth takes the message without its F0
    if (bytes[0] === 0xf0) this.synth?.systemExclusive(bytes.subarray(1), 0, this.opt());
  }

  /** Every sounding note released (their envelopes finish). */
  allNotesOff(): void {
    this.synth?.stopAll(false);
  }

  /** Silence at once, and the channels back to their GM defaults. */
  reset(): void {
    this.synth?.stopAll(true);
    this.synth?.reset();
  }

  set gain(v: number) {
    this.out.gain.value = v;
  }

  get gain(): number {
    return this.out.gain.value;
  }

  dispose(): void {
    this.disposed = true;
    if (this.synth) {
      this.synth.stopAll(true);
      this.synth.disconnect();
      this.synth.destroy();
      this.synth = null;
    }
    this.out.disconnect();
  }
}
