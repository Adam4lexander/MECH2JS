// The in-screen animations' sound: main opens every movie with
// smackerOpenFlags - all seven Smacker sound tracks (0xfe00) when movie
// sound is on, as it is in the image - and the library plays a frame's
// sound as it decodes it. AWOBRIEF, the Mission Briefing zone lighting up,
// carries a 22 kHz track.
import { afterEach, describe, expect, it } from 'vitest';
import { hardware } from '../../src/shell/host/hardware.ts';
import { SMACK_TRACKS, smackDoFrame, smackNextFrame, smackOpen } from '../../src/shell/video/smack.ts';
import { openCdImage } from '../support/cdImage.ts';
import { hasCdImage } from '../support/env.ts';

describe.runIf(hasCdImage)('Smacker sound on the tracks a movie is opened with', () => {
  afterEach(() => {
    hardware.pcmOut = null;
  });

  async function play(flags: number): Promise<{ samples: number; rate: number }> {
    const iso = await openCdImage();
    const s = smackOpen(await iso.read('SMK/AWOBRIEF.SMK'), flags)!;
    let samples = 0;
    let rate = 0;
    hardware.pcmOut = (pcm, r) => {
      samples += pcm.length;
      rate = r;
    };
    for (let i = 0; i < s.frames; i++) {
      smackDoFrame(s);
      smackNextFrame(s);
    }
    return { samples, rate };
  }

  it('AWOBRIEF opened with the sound tracks: its audio reaches the host', async () => {
    const r = await play(SMACK_TRACKS);
    expect(r.rate).toBe(22050);
    expect(r.samples).toBeGreaterThan(22050 / 2);
  });

  it('opened without them (movie sound off): silent', async () => {
    expect((await play(0)).samples).toBe(0);
  });
});
