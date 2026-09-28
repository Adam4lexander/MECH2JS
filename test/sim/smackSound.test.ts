// The in-screen animations' sound: main opens every movie with
// smackerOpenFlags - all seven Smacker sound tracks (0xfe00) when movie
// sound is on, as it is in the image - and the library plays a frame's
// sound as it decodes it. AWOBRIEF, the Mission Briefing zone lighting up,
// carries a 22 kHz track.
import { afterEach, describe, expect, it } from 'vitest';
import { hardware } from '../../src/shell/host/hardware.ts';
import { openSmacker } from '../../src/data/formats/smacker.ts';
import { SMACK_TRACKS, smackDoFrame, smackGoto, smackNextFrame, smackOpen } from '../../src/shell/video/smack.ts';
import { openCdImage } from '../support/cdImage.ts';
import { hasCdImage } from '../support/env.ts';

describe.runIf(hasCdImage)('Smacker sound on the tracks a movie is opened with', () => {
  afterEach(() => {
    hardware.pcmOut = null;
  });

  async function play(flags: number): Promise<{ samples: number; rate: number; restarts: number; streams: Set<object>; chunks: number }> {
    const iso = await openCdImage();
    const s = smackOpen(await iso.read('SMK/AWOBRIEF.SMK'), flags)!;
    let samples = 0;
    let rate = 0;
    let restarts = 0;
    let chunks = 0;
    const streams = new Set<object>();
    hardware.pcmOut = (pcm, r, _c, stream, restart) => {
      samples += pcm.length;
      rate = r;
      streams.add(stream);
      if (restart) restarts++;
      chunks++;
    };
    for (let i = 0; i < s.frames; i++) {
      smackDoFrame(s);
      smackNextFrame(s);
    }
    // looped back to the first frame, as a looping animation does: a restart of its timeline
    smackGoto(s, 1);
    smackDoFrame(s);
    return { samples, rate, restarts, streams, chunks };
  }

  it('AWOBRIEF opened with the sound tracks: its audio reaches the host', async () => {
    const r = await play(SMACK_TRACKS);
    expect(r.rate).toBe(22050);
    expect(r.samples).toBeGreaterThan(22050 / 2);
    // one stream (the movie) for the host to keep its own timeline; frame 0 - first and after the loop - restarts it
    expect(r.streams.size).toBe(1);
    expect(r.restarts).toBe(2);
    expect(r.chunks).toBe(2);
  });

  it('the whole track, decoded without the video, is every frame\'s sound end to end', async () => {
    const iso = await openCdImage();
    for (const name of ['AWOBRIEF', 'AWOHOLOP', 'MINTRO']) {
      const bytes = await iso.read(`SMK/${name}.SMK`);
      const whole = openSmacker(bytes).decodeAudioTrack(0);
      const d = openSmacker(bytes);
      const parts: number[] = [];
      for (let f; (f = d.decodeNextFrame()) && f.index < d.header.frames; ) parts.push(...f.audio[0]!);
      expect(whole.length, name).toBe(parts.length);
      expect(Array.from(whole).every((v, i) => v === parts[i]), name).toBe(true);
    }
  }, 120_000);

  it('opened without them (movie sound off): silent', async () => {
    expect((await play(0)).samples).toBe(0);
  });
});
