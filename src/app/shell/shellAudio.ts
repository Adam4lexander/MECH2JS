/**
 * The front end's sound card on WebAudio: the MIDI side is a General MIDI
 * SoundFont synth (the XMIDI songs' GM arrangement), the digital side plays
 * RIFF WAV samples with Miles' volume (0..127) and loop count, and movie
 * audio streams out frame by frame.
 *
 * @portOnly the sound card under the shell's Miles
 */
import { hardware, type SampleVoice } from '../../shell/host/hardware.ts';
import { GmSynth } from '../../audio/gmSynth.ts';
import type { Game } from '../Game.ts';

/** A RIFF WAVE's PCM as an AudioBuffer (8-bit unsigned or 16-bit signed). */
function wavBuffer(ctx: AudioContext, wav: Uint8Array): AudioBuffer | null {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(wav[o]!, wav[o + 1]!, wav[o + 2]!, wav[o + 3]!);
  if (wav.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let channels = 1;
  let rate = 11025;
  let bits = 8;
  let data: Uint8Array | null = null;
  for (let o = 12; o + 8 <= wav.length; ) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(o + 10, true);
      rate = dv.getUint32(o + 12, true);
      bits = dv.getUint16(o + 22, true);
    } else if (id === 'data') data = wav.subarray(o + 8, Math.min(wav.length, o + 8 + size));
    o += 8 + size + (size & 1);
  }
  if (!data || channels < 1) return null;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  if (frames === 0) return null;
  const buf = ctx.createBuffer(channels, frames, rate);
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let c = 0; c < channels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const at = (i * channels + c) * bytes;
      ch[i] = bits === 8 ? (data[at]! - 128) / 128 : ddv.getInt16(at, true) / 32768;
    }
  }
  return buf;
}

/** Puts the shell's sound card in: GM synth, samples, movie audio. */
export async function attachShellAudio(game: Game): Promise<void> {
  const { ctx, out } = game.audio.output();
  const synth = new GmSynth(ctx, out);
  hardware.midi = synth;
  let playing = 0;
  hardware.digital = {
    activeCount: () => playing,
    sample(wav: Uint8Array): SampleVoice | null {
      const buf = wavBuffer(ctx, wav);
      if (!buf) return null;
      const gain = ctx.createGain();
      gain.connect(out);
      let src: AudioBufferSourceNode | null = null;
      let loops = 1;
      let ended = true;
      return {
        setVolume: (v) => gain.gain.setValueAtTime(Math.max(0, Math.min(127, v)) / 127, ctx.currentTime),
        setLoopCount: (n) => {
          loops = n;
        },
        start: () => {
          src?.stop();
          src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = loops === 0;
          src.connect(gain);
          if (ended) playing++;
          ended = false;
          const mine = src;
          src.onended = () => {
            if (src === mine && !ended) {
              ended = true;
              playing--;
            }
          };
          src.start();
        },
        stop: () => {
          src?.stop();
          if (!ended) playing--;
          ended = true;
        },
        done: () => ended,
        release: () => gain.disconnect(),
      };
    },
  };
  // each movie's own timeline: its chunks play back to back from when it started (or last went back to
  // its first frame, whose chunk carries Smacker's lead-in), and different movies' sound mixes
  const movieTimes = new WeakMap<object, number>();
  hardware.pcmOut = (samples, rate, channels, stream, restart) => {
    const frames = Math.floor(samples.length / channels);
    if (frames === 0) return;
    const buf = ctx.createBuffer(channels, frames, rate);
    for (let c = 0; c < channels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) ch[i] = samples[i * channels + c]! / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(out);
    const at = restart ? ctx.currentTime + 0.05 : Math.max(movieTimes.get(stream) ?? 0, ctx.currentTime + 0.05);
    src.start(at);
    movieTimes.set(stream, at + frames / rate);
  };
  // the SoundFont loads in the background; the shell starts after a few seconds either way
  await Promise.race([synth.ready, new Promise((r) => setTimeout(r, 8000))]);
}
