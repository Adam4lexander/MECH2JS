/**
 * The voice queue: every spoken line - cockpit cues, lancemate radio, damage
 * callouts, the mission-result announcements - goes through
 * sound_seq_queue_message into one of eight VoiceLine records, kept in a list
 * in descending priority behind the line playing now (voiceQueueHead). A
 * line plays on a reserved mixer channel (flags 0x150), a prefix first and
 * its body chained after it by sound_sample_eos; with speech off (soundFlags
 * bit 2 clear) its text is posted to the message line instead.
 *
 * The lines come from one static array of 12-byte {soundId, text, buffer}
 * records in the image (0x97950 onward: radioAddressees, lanceRadioMessages,
 * the formation lines, soundCueVariants, soundCues, the damage callouts).
 * sound_seq_queue_message WRITES to them - a record with a negative id or a
 * buffer gets id 0, an empty text becomes null - so they are game state here,
 * read from the image and reset with it.
 */
import { quirk } from '../../core/provenance.ts';
import { ailEndSample, ailResumeSample, ailSampleUserData, ailSetSampleUserData, ailSetSampleVolume, ailStopSample, type WordRef } from '../../engine/miles/ail.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage, imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { VoiceLine } from '../../generated/classes.gen.ts';
import { messagePost } from '../cockpit/messages.ts';
import { sound, soundChannelStart, soundFlags, soundSetting, SoundSetting, voiceVolumeScale } from './mixer.ts';

/** One 12-byte line record {int soundId; char *text; void *buffer}. @portOnly */
export interface CueRecord {
  soundId: number;
  /** null for a null pointer; '' for a pointer to an empty string */
  text: string | null;
  buffer: Uint8Array | null;
}

export const RADIO_ADDRESSEES = 0x97950;
export const LANCE_RADIO_MESSAGES = 0x97974;
export const FORMATION_LINES = 0x979f8;
export const SOUND_CUE_VARIANTS = 0x97a4c;
export const SOUND_CUES = 0x97a70;
/** damage_callout_play's prefix record */
export const DAMAGE_CALLOUT_PREFIX = 0x97af4;
export const DAMAGE_CALLOUTS = 0x97c08;
const STRIDE = 12;
/** the separator and terminator sound_seq_queue_message appends (0x916f0, 0x916f4) */
const SEPARATOR = ' ';
const TERMINATOR = '.';
const TEXT_MAX = 0x33;

export const voice = registerGlobals(
  'voice',
  {
    /** 0x1500a0: the eight lines */
    voiceLines: Array.from({ length: 8 }, () => new VoiceLine()),
    /** 0x97ddc: the line playing (or posted) now */
    voiceQueueHead: null as VoiceLine | null,
    /** 0x97de4: set once the mission is decided; nothing more is queued */
    voiceQueueClosed: 0,
    /** the static line records by address, read from the image on first use */
    records: new Map<number, CueRecord>(),
  },
  () => {
    for (let i = 0; i < 8; i++) voice.voiceLines[i] = new VoiceLine();
    voice.voiceQueueHead = null;
    voice.voiceQueueClosed = 0;
    voice.records.clear();
  },
);

/** The static record at `addr` (0x97950 + 12 * n), as the game has left it. @portOnly */
export function cueRecord(addr: number): CueRecord {
  let r = voice.records.get(addr);
  if (!r) {
    const exe = bootImage();
    r = { soundId: imageI32(addr, 0), text: exe ? exe.strPtr(addr + 4) : null, buffer: null };
    if (imageI32(addr + 8, 0) !== 0) quirk(`voice: static record 0x${addr.toString(16)} has a buffer word; the port reads it as none`, 'sound_seq_queue_message');
    voice.records.set(addr, r);
  }
  return r;
}

const voiceSampleRef: WordRef = { get: () => sound.voiceSample, set: (v) => (sound.voiceSample = v) };

/** strncat(dst, src, n) into the 0x33-byte text field. */
function strncat(dst: string, src: string, n: number): string {
  return dst + src.slice(0, Math.max(0, n));
}

/**
 * Queues a line from two records - a prefix and a body, either possibly null.
 * Takes a free VoiceLine, joins the texts with ' ' and ends them with '.',
 * gives it `priority` (or the first id's soundSettings priority for -1), and
 * starts it at once when nothing plays; otherwise links it in behind the head
 * before the first line of lower priority. A line whose ids match a queued
 * one is dropped (after maxPlaying matches, or at once when that is -1), as
 * is one with the same buffer - and in both cases the record it took stays
 * marked in use, lost to the queue for the rest of the mission.
 *
 * @mw2 sound_seq_queue_message 0x00041b30
 * @fidelity exact
 */
export function soundSeqQueueMessage(firstIn: CueRecord | null, secondIn: CueRecord | null, priority: number): boolean {
  if (voice.voiceQueueClosed !== 0) return false;
  let first = firstIn;
  let body = secondIn;
  if (!first) {
    if (!secondIn) return false;
    body = null;
    first = secondIn;
  }
  if (first.soundId < 0 || first.buffer) first.soundId = 0;
  if (first.text !== null && first.text === '') first.text = null;
  if (first.soundId === 0 && first.text === null && !first.buffer) first = body;
  if (!first) return false;
  if (body) {
    if (body.soundId < 0) body.soundId = 0;
    if (!body.buffer && body.soundId !== 0) {
      if (body.text !== null && body.text === '') body.text = null;
    } else body = null;
  }
  const line = voice.voiceLines.find((l) => l.inUse === 0) ?? null;
  if (!line) return false;
  Object.assign(line, new VoiceLine());
  line.inUse = 1;
  line.soundId = first.soundId;
  line.buffer = first.buffer;
  if (body) {
    line.bodySoundId = body.soundId;
    line.bodyBuffer = body.buffer;
  }
  let text = '';
  if (first.text !== null) text = strncat(text, first.text, TEXT_MAX);
  if (body && body.text) {
    text = strncat(text, SEPARATOR, TEXT_MAX - text.length);
    text = strncat(text, body.text, TEXT_MAX - text.length);
  }
  if (text !== '') text = strncat(text, TERMINATOR, TEXT_MAX - text.length);
  line.text = text;
  if (priority === -1 && line.soundId !== 0) priority = soundSetting(line.soundId, SoundSetting.Priority);
  line.priority = priority;
  const head = voice.voiceQueueHead;
  if (head) {
    let matches = 0;
    let prev = head;
    let cur = head.next;
    for (;;) {
      if (!cur) {
        prev.next = line;
        return true;
      }
      if (!cur.buffer) {
        if (cur.soundId !== 0 && cur.soundId === line.soundId && (cur.bodySoundId === 0 || cur.bodySoundId === line.bodySoundId)) {
          const max = soundSetting(line.soundId, SoundSetting.MaxPlaying);
          if (max === -1 || max <= ++matches) {
            quirk('sound_seq_queue_message: a dropped duplicate keeps its VoiceLine marked in use', 'sound_seq_queue_message');
            return false;
          }
        }
        if (cur.priority < line.priority) {
          prev.next = line;
          line.next = cur;
          prev.next = line;
          return true;
        }
      } else if (cur.buffer === line.buffer) {
        quirk('sound_seq_queue_message: a dropped duplicate keeps its VoiceLine marked in use', 'sound_seq_queue_message');
        return false;
      }
      prev = cur;
      cur = cur.next;
    }
  }
  if (voiceLineStart(line)) {
    voice.voiceQueueHead = line;
    return true;
  }
  line.inUse = 0;
  return false;
}

/**
 * Starts a line: with no mixer or speech off it posts the text for 0x71c
 * ticks; otherwise it plays the prefix with the body chained after it, or
 * the one id, or the caller's buffer, on a reserved channel whose user
 * data 0 is voiceSample. Returns whether something is playing or posted.
 *
 * @mw2 voice_line_start 0x00041e50
 * @fidelity exact
 */
export function voiceLineStart(line: VoiceLine): boolean {
  sound.voiceSample = 0;
  const m = sound.soundMixer;
  if (!m || (soundFlags() & 2) === 0) {
    if (line.text !== '') {
      messagePost(line.text, 0, 0x71c, 0x32);
      line.endTick = (clock.simTick + 0x71c) | 0;
      return true;
    }
    return false;
  }
  let first = line.soundId;
  let second = line.bodySoundId;
  line.endTick = 0;
  if (first === 0 && second !== 0) {
    first = second;
    second = 0;
  }
  if (first === 0) {
    if (!line.buffer) return false;
    first = -1;
  }
  if (second !== 0) {
    if (cacheLoadResource(second, 'SNDS')) {
      if (!cacheLoadResource(first, 'SNDS')) cacheUnlock(second, 'SNDS');
      else {
        const ch = soundChannelStart(0, 0, first, null, 100, voiceVolumeScale(), 0x40, 0x2b11, voiceSampleRef, 0x150);
        if (-1 < ch) {
          sound.voiceSample = m.sampleHandles[ch]!;
          ailSetSampleUserData(sound.voiceSample, 1, first);
          ailSetSampleUserData(sound.voiceSample, 2, ch);
          ailSetSampleUserData(sound.voiceSample, 3, second);
        }
      }
    }
  } else if (first !== 0) {
    const ch = soundChannelStart(0, 0, first, line.buffer, 100, voiceVolumeScale(), 0x40, 0x2b11, voiceSampleRef, 0x150);
    if (-1 < ch) sound.voiceSample = m.sampleHandles[ch]!;
  } else if (line.text !== '') messagePost(line.text, 0, 0x71c, 0x32);
  return sound.voiceSample !== 0;
}

/**
 * main's voice step: when the head is done - a sound line once voiceSample
 * is 0; a text line while its endTick is still AHEAD (the comparison is the
 * wrong way round, so a text line goes the next frame) - frees it and starts
 * the next line that will start.
 *
 * @mw2 voice_queue_advance 0x00041dd0
 * @fidelity exact
 */
export function voiceQueueAdvance(): void {
  let head = voice.voiceQueueHead;
  if (!head) return;
  let done: boolean;
  if (head.endTick !== 0) {
    done = !(head.endTick <= clock.simTick);
    if (done) quirk('voice_queue_advance: a posted text line is dropped while its endTick is still ahead', 'voice_queue_advance');
  } else done = sound.voiceSample === 0;
  if (!done) return;
  let started = false;
  do {
    head!.inUse = 0;
    head = head!.next;
    if (head && voiceLineStart((voice.voiceQueueHead = head))) started = true;
  } while (head && !started);
  voice.voiceQueueHead = head;
}

/** A line leaves the queue: unused, unlinked, its buffers freed (nothing to free in JS). */
function dropLine(l: VoiceLine): VoiceLine | null {
  l.inUse = 0;
  const next = l.next;
  l.next = null;
  return next;
}

/**
 * Once the mission is decided (mission_results_update, every frame, with 1):
 * ends the head when it is a sound below priority 0x50, drops every queued
 * line but the buffers and sounds of priority 0x50 up (the announcements)
 * - all of them with 0 - and closes the queue.
 *
 * @mw2 voice_queue_close 0x00042080
 * @fidelity exact
 */
export function voiceQueueClose(keepAnnouncements: number): void {
  let head = voice.voiceQueueHead;
  if (!head || voice.voiceQueueClosed !== 0) return;
  if (0 < head.soundId && head.priority < 0x50) {
    if (sound.voiceSample !== 0) ailEndSample(sound.voiceSample);
    head = dropLine(voice.voiceQueueHead!);
    voice.voiceQueueHead = head;
    if (!head) return;
  }
  let prev = voice.voiceQueueHead!;
  let cur = prev.next;
  while (cur) {
    let remove = true;
    if (keepAnnouncements !== 0 && (cur.buffer || (0 < cur.soundId && 0x4f < cur.priority))) remove = false;
    if (remove) {
      const next = dropLine(cur);
      prev.next = next;
      cur = next;
    } else {
      prev = cur;
      cur = cur.next;
    }
  }
  voice.voiceQueueClosed = 1;
}

/**
 * sound_pause's: drops every line behind the head and stops the voice sample.
 *
 * @mw2 voice_queue_pause 0x000421c0
 * @fidelity exact
 */
export function voiceQueuePause(): void {
  const head = voice.voiceQueueHead;
  if (head) {
    let cur = head.next;
    while (cur) cur = dropLine(cur);
  }
  if (sound.voiceSample !== 0) ailStopSample(sound.voiceSample);
}

/**
 * sound_resume's: the voice channel's volume from voiceVolumeScale * 100 on
 * the channel and the sample, and the sample resumed.
 *
 * @mw2 voice_resume 0x00042230
 * @fidelity exact
 */
export function voiceResume(): void {
  const h = sound.voiceSample;
  if (h === 0) return;
  const p = BigInt(voiceVolumeScale()) * 100n;
  const v = Number(BigInt.asIntN(32, (p >> 16n) + ((p >> 15n) & 1n)));
  const ch = ailSampleUserData(h, 2) as number;
  if (-1 < ch) sound.soundMixer!.volume[ch] = v;
  ailSetSampleVolume(h, v);
  ailResumeSample(h);
}

/**
 * A mission-result line at priority 0x50, which voice_queue_close keeps.
 *
 * @mw2 voice_queue_announcement 0x000423d0
 * @fidelity exact
 */
export function voiceQueueAnnouncement(r: CueRecord): void {
  soundSeqQueueMessage(r, null, 0x50);
}

/**
 * soundCues[cue], with soundCueVariants[control] after it; control 0 plays
 * nothing and -1 the cue alone.
 *
 * @mw2 sound_cue_play 0x00042340
 * @fidelity exact
 */
export function soundCuePlay(cue: number, control: number): void {
  if (control === 0) return;
  const variant = control === -1 ? null : cueRecord(SOUND_CUE_VARIANTS + control * STRIDE);
  soundSeqQueueMessage(cueRecord(SOUND_CUES + cue * STRIDE), variant, -1);
}

/**
 * lanceRadioMessages[message] (0..10) prefixed by radioAddressees[addressee]
 * (none for -1). An addressee of 3 up reads on into the message records.
 *
 * @mw2 radio_lance_message 0x000422a0
 * @fidelity exact
 */
export function radioLanceMessage(message: number, addressee: number): void {
  if (message === -1 || message >= 0xb) return;
  const prefix = addressee === -1 ? null : cueRecord(RADIO_ADDRESSEES + addressee * STRIDE);
  soundSeqQueueMessage(prefix, cueRecord(LANCE_RADIO_MESSAGES + message * STRIDE), -1);
}

/**
 * 'Formation change to' and formation n (0..5).
 *
 * @mw2 radio_formation_change 0x00042300
 * @fidelity exact
 */
export function radioFormationChange(n: number): void {
  if (-1 < n && n < 6) soundSeqQueueMessage(cueRecord(FORMATION_LINES), cueRecord(FORMATION_LINES + (n + 1) * STRIDE), -1);
}

/**
 * damageCallouts[n] after its prefix record - a destroyed component.
 *
 * @mw2 damage_callout_play 0x00042390
 * @fidelity exact
 */
export function damageCalloutPlay(n: number): void {
  soundSeqQueueMessage(cueRecord(DAMAGE_CALLOUT_PREFIX), cueRecord(DAMAGE_CALLOUTS + n * STRIDE), -1);
}
