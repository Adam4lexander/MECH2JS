// Smacker frame timing: SmackWait holds frame n until frameMs * n into the
// movie, counted from frame 0 - on the shell's timer, or on the movie's
// sound while the host is playing it. The host's clock moves once a display
// frame; timed frame to frame, mintro fell 9.5 s behind its sound at 60 Hz.
import { afterEach, describe, expect, it } from 'vitest';
import { hardware, hwAdvanceTime } from '../../src/shell/host/hardware.ts';
import { SMACK_TRACKS, smackDoFrame, smackNextFrame, smackOpen, smackWait } from '../../src/shell/video/smack.ts';
import { openCdImage } from '../support/cdImage.ts';
import { hasCdImage } from '../support/env.ts';

describe.runIf(hasCdImage)('Smacker frame timing', () => {
  afterEach(() => {
    hardware.pcmOut = null;
    hardware.pcmClock = null;
  });

  it('mintro at a 60 Hz host: every frame goes up on its time, and the last with the sound\'s end', async () => {
    const s = smackOpen(await (await openCdImage()).read('SMK/MINTRO.SMK'), 0)!;
    const start = hardware.timeMs;
    smackDoFrame(s);
    for (let frame = 1; frame < s.frames; frame++) {
      // movie_play's order: next, then wait
      smackNextFrame(s);
      while (smackWait(s) !== 0) hwAdvanceTime(1000 / 60);
      smackDoFrame(s);
      const late = hardware.timeMs - start - frame * s.frameMs;
      expect(late).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThan(1000 / 60 + 4);
    }
  });

  it('an animation asks before it advances: the same rate', async () => {
    const s = smackOpen(await (await openCdImage()).read('SMK/MINTRO.SMK'), 0)!;
    smackDoFrame(s);
    const start = hardware.timeMs;
    let shown = 1;
    while (hardware.timeMs - start < 10_000) {
      hwAdvanceTime(1000 / 60);
      if (smackWait(s) === 0) {
        smackNextFrame(s);
        smackDoFrame(s);
        shown++;
      }
    }
    expect(Math.abs(shown - (1 + 10_000 / s.frameMs))).toBeLessThanOrEqual(1);
  });

  it('while its sound plays, the movie keeps to the sound, not the shell\'s timer', async () => {
    const s = smackOpen(await (await openCdImage()).read('SMK/MINTRO.SMK'), SMACK_TRACKS)!;
    let heard = -50;
    hardware.pcmOut = () => {};
    hardware.pcmClock = () => heard;
    smackDoFrame(s);
    // a 500 ms stall at the start: the sound goes on, the shell's timer gets 100 of it
    heard += 500;
    hwAdvanceTime(100);
    for (let frame = 1; frame < 300; frame++) {
      smackNextFrame(s);
      while (smackWait(s) !== 0) {
        hwAdvanceTime(1000 / 60);
        heard += 1000 / 60;
      }
      smackDoFrame(s);
      // caught up after the stall: each frame within a display frame of its sound
      if (frame > 20) expect(Math.abs(heard - frame * s.frameMs)).toBeLessThan(1000 / 60 + 1);
    }
  });
});
