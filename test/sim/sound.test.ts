// Phase 7's exit checks, on the shipped data through the ported sound code
// and the port's Miles layer: an SFLX sound streamed through the double
// buffer comes out of the mixer sample for sample as the decoder makes it;
// channels are claimed, refused and stolen by the original's rules; a voice
// line's prefix is followed by its body on the same channel and the queue
// moves on; the positional emitters loop their RIFF files on channels 8..15;
// the engine note's MIDI messages follow the throttle; and the mission's CD
// track plays, repeats when it ends, and pauses with the game.
import { beforeAll, describe, expect, it } from 'vitest';
import { ExeImage } from '../../src/data/exe/ExeImage.ts';
import { decodeSflx, SflxBuffers } from '../../src/data/formats/sflx.ts';
import { ProjectFile } from '../../src/data/prj/ProjectFile.ts';
import { ail, ailMidiListen, ailSample, ailTimerService, digTakeOutput, SMP_PLAYING } from '../../src/engine/miles/ail.ts';
import { setCdDrive, SilentCdDrive } from '../../src/engine/miles/cdDrive.ts';
import { bootMission } from '../../src/mission/load.ts';
import { mainLoopFrame } from '../../src/mission/mainLoop.ts';
import { mechs } from '../../src/sim/mech/mechGlobals.ts';
import { sound, soundChannelStart, soundPlay, soundRefillBuffers, soundSetting, SoundSetting } from '../../src/sim/sound/mixer.ts';
import { music, soundPause, soundResume } from '../../src/sim/sound/music.ts';
import { cueRecord, LANCE_RADIO_MESSAGES, RADIO_ADDRESSEES, radioLanceMessage, soundCuePlay, SOUND_CUES, voice, voiceQueueAdvance } from '../../src/sim/sound/voice.ts';
import { lighting } from '../../src/sim/world/environment.ts';
import { gameSource, hasGameData, installFiles } from '../support/env.ts';

let exe: ExeImage;
let prj: ProjectFile;
let files: Map<string, Uint8Array>;

function frame(ticks = 7) {
  for (let i = 0; i < ticks; i++) ailTimerService();
  mainLoopFrame();
}

/** the Miles clock and the refill only, with the sim standing still */
function audioOnly(ticks = 7) {
  soundRefillBuffers();
  for (let i = 0; i < ticks; i++) ailTimerService();
}

function boot(mission: string) {
  bootMission({ exe, prj, looseFiles: files, mission });
}

describe.runIf(hasGameData)('sound', () => {
  beforeAll(async () => {
    const src = gameSource();
    exe = ExeImage.fromExe(await src.read('MW2.EXE'));
    prj = new ProjectFile(await src.read('MW2.PRJ'));
    files = installFiles();
  });

  it('streams an SFLX sound through the double buffer exactly as it decodes', () => {
    boot('AMY_SCN1');
    // BET13, 205 blocks: more than one half buffer (64 blocks), so both halves and the chaining are used
    const id = 16;
    const expected = decodeSflx(prj.readResource('SNDS', id)!, new SflxBuffers())!.pcm;
    sound.sflxBuffers = new SflxBuffers();
    ail.outputWanted = true;
    digTakeOutput();
    // volume 127 at a 1.0 scale and pan 0x40: Miles scales by 128/128 on both sides, so each frame is exactly (s - 0x80) * 256
    const ch = soundChannelStart(0, 0, id, null, 127, 0x10000, 0x40, 0, -1, 0x32);
    expect(ch).toBeGreaterThanOrEqual(0);
    const out: number[] = [];
    for (let f = 0; f < 800 && out.length < expected.length * 2 + 2000; f++) {
      audioOnly();
      out.push(...digTakeOutput());
    }
    ail.outputWanted = false;
    const left = out.filter((_, i) => (i & 1) === 0);
    const got = left.slice(0, expected.length).map((v) => (v >> 8) + 0x80);
    expect(got).toEqual([...expected]);
    // and then it ends: the channel is free, the sample DONE
    expect(sound.soundMixer!.inUse[ch]).toBe(0);
    expect(left.slice(expected.length, expected.length + 500).every((v) => v === 0)).toBe(true);
  });

  it('claims, refuses and steals channels by the original rules', () => {
    boot('AMY_SCN1');
    const m = sound.soundMixer!;
    expect(m.channelCount).toBe(8);
    for (let i = 0; i < 8; i++) soundPlay(0xdc, 100, 0x40, 5, 0x32);
    expect([...m.inUse.slice(0, 8)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // a ninth at the same priority finds no channel below it
    const prio = soundSetting(0xdc, SoundSetting.Priority);
    expect(soundChannelStart(0, 0, 0xdc, null, 100, 0x10000, 0x40, 0, -1, 0x32)).toBe(-8);
    // a high-byte flag outranks every priority byte: the LAST busy channel is stolen
    expect(soundChannelStart(0, 0, 0xdc, null, 100, 0x10000, 0x40, 0, -1, 0x250)).toBe(7);
    expect(m.flags[7]).toBe(0x200 | (prio === -1 ? 0x32 : prio));
    // 0x200 on both with the same id: that channel is ended and reused
    expect(soundChannelStart(0, 0, 0xdc, null, 100, 0x10000, 0x40, 0, -1, 0x250)).toBe(7);
    // 0x400 on both with the same id: refused
    m.flags[6] = 0x400 | 0x32;
    expect(soundChannelStart(0, 0, 0xdc, null, 100, 0x10000, 0x40, 0, -1, 0x450)).toBe(-10);
    // volume 0 is refused before anything
    expect(soundChannelStart(0, 0, 0xdc, null, 0, 0x10000, 0x40, 0, -1, 0x32)).toBe(-0xb);
  });

  it('a radio line plays its prefix, then its body on the same channel, then the queue moves on', () => {
    boot('AMY_SCN1');
    const prefix = cueRecord(RADIO_ADDRESSEES + 1 * 12).soundId;
    const body = cueRecord(LANCE_RADIO_MESSAGES + 5 * 12).soundId;
    expect(prefix).toBeGreaterThan(0);
    expect(body).toBeGreaterThan(0);
    radioLanceMessage(5, 1);
    soundCuePlay(0, -1);
    const head = voice.voiceQueueHead!;
    expect(head.text).toBe(`${cueRecord(RADIO_ADDRESSEES + 12).text} ${cueRecord(LANCE_RADIO_MESSAGES + 60).text}.`);
    expect(head.next?.soundId).toBe(cueRecord(SOUND_CUES).soundId);
    const h = sound.voiceSample;
    expect(h).not.toBe(0);
    const ch = sound.soundMixer!.sampleHandles.indexOf(h);
    const played: number[] = [];
    for (let f = 0; f < 3000 && voice.voiceQueueHead === head; f++) {
      audioOnly();
      const id = sound.soundMixer!.soundId[ch]!;
      if (id && played[played.length - 1] !== id) played.push(id);
      voiceQueueAdvance();
    }
    expect(played).toEqual([prefix, body]);
    // the heat cue came next
    expect(voice.voiceQueueHead?.soundId).toBe(cueRecord(SOUND_CUES).soundId);
    expect(head.inUse).toBe(0);
  });

  it('with speech off a line is posted as text instead', () => {
    boot('AMY_SCN1');
    sound.soundConfig[4] = sound.soundConfig[4]! & ~2;
    soundCuePlay(0, -1);
    expect(voice.voiceQueueHead?.endTick).toBeGreaterThan(0);
    expect(sound.voiceSample).toBe(0);
  });

  it('emitters loop their RIFF file on channels 8..15, louder nearer', () => {
    let found = false;
    for (const m of ['TNJ1SCN1', 'BRONSCN1']) {
      boot(m);
      for (let f = 0; f < 60; f++) frame();
      const mx = sound.soundMixer!;
      for (let ch = 8; ch < 16; ch++) {
        if (!mx.inUse[ch]) continue;
        const s = ailSample(mx.sampleHandles[ch]!)!;
        expect(s.file).toBe(true);
        expect(s.status).toBe(SMP_PLAYING);
        expect(s.loopCount).toBe(0);
        expect(mx.flags[ch]).toBe(0x1000);
        expect(s.volume).toBeLessThanOrEqual(25);
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('the engine note: MIDI note on at power-up, then a pitch bend that follows the throttle', () => {
    const msgs: number[][] = [];
    const off = ailMidiListen((s, a, b) => msgs.push([s, a, b]));
    boot('AMY_SCN1');
    const p = mechs.mechTable[mechs.playerMechIndex]!;
    for (let f = 0; f < 400 && (p.flags & 0x2000) === 0; f++) frame();
    for (let f = 0; f < 20; f++) frame();
    off();
    const on = msgs.findIndex((m) => (m[0]! & 0xf0) === 0x90);
    expect(on).toBeGreaterThan(0);
    expect(msgs.slice(on - 5, on + 1).map((m) => [m[0]! & 0xf0, m[1], m[2]])).toEqual([
      [0xb0, 0x72, 0],
      [0xc0, 3, 0],
      [0xe0, 0, 0x30],
      [0xb0, 0x0a, 0x40],
      [0xb0, 0x07, 0],
      [0x90, 0x26, 0x7f],
    ]);
    const bend = msgs.slice(on + 1).find((m) => (m[0]! & 0xf0) === 0xe0)!;
    const throttle = p.loadout!.ramps[4]!.current;
    const x = throttle * 4 + 0x2000;
    // neutral throttle 0x400: x = 0x3000, MSB (x & 0x3f00) >> 8 = 0x30
    expect(bend[2]).toBe((x & 0x3f00) >> 8);
  });

  it('the mission CD track plays, repeats when it ends, and pauses with the game', () => {
    const drive = new SilentCdDrive({ first: 1, last: 27 });
    setCdDrive(drive);
    try {
      boot('AMY_SCN1');
      const res = prj.readResource('MUS', lighting.missionMusicResource)!;
      const track = Number(String.fromCharCode(...res).trim().split(/\s+/)[0]);
      expect(music.musicCdTrack).toBe(track);
      expect(drive.track).toBe(track);
      expect(drive.state).toBe(3);
      frame();
      drive.end();
      frame();
      expect(drive.state).toBe(3);
      soundPause();
      expect(drive.state).toBe(4);
      soundResume();
      expect(drive.state).toBe(3);
    } finally {
      setCdDrive(null);
    }
  });
});
