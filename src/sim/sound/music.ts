/**
 * The mission's music - a CD audio track - and the sound system's life
 * cycle: sound_init_all at boot, the pause and resume game_update_pause
 * calls, sound_save_config at exit.
 *
 * The music is Redbook audio on the game CD: the mission's MUS resource
 * (MUSI) holds 'N 0', N the track; music_start_mission_track plays it before
 * the loop and music_update plays it again whenever the drive's status
 * changes (the track ran out). The CD routines talk MSCDEX to the drive; the
 * port keeps their logic over engine/miles/cdDrive.ts, which the host backs
 * with the install's CD image.
 */
import { cdiv } from '../../core/int/cint.ts';
import { unestablished } from '../../core/provenance.ts';
import { systemError } from '../../core/systemError.ts';
import { cdDrive } from '../../engine/miles/cdDrive.ts';
import { clock } from '../../engine/clock.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { cacheLoadResource, cacheUnlock } from '../../engine/resources/cache.ts';
import { lighting } from '../world/environment.ts';
import { engineNoteMute, midiClose, midiOpen } from './engineNote.ts';
import { cdVolumeScale, sound, soundFlags, soundInit, soundSettingsInit, soundShutdown, soundStopChannels } from './mixer.ts';
import { voiceQueuePause, voiceResume } from './voice.ts';

export const music = registerGlobals(
  'music',
  {
    /** 0x97df0 */
    cdAudioReady: 0,
    /** 0x97df8: the mission's CD track, -1 none */
    musicCdTrack: -1,
    /** 0x97dfc: the MUS resource's second number (an XMIDI id), -1 once the CD plays */
    musicXmidi: -1,
    /** 0x97e44: the MUS resource has been read */
    musicTrackLoaded: 0,
    /** 0x97e40: sound_pause has run and sound_resume not yet */
    soundPaused: 0,
    /** 0x15034c: the drive status cd_status_update last recorded */
    cdLastStatus: 0,
    /** 0x150354, 0x150358: the disc's track range */
    cdTrackFirst: 0,
    cdTrackLast: 0,
  },
  () => {
    music.cdAudioReady = imageI32(0x97df0, 0);
    music.musicCdTrack = imageI32(0x97df8, -1);
    music.musicXmidi = imageI32(0x97dfc, -1);
    music.musicTrackLoaded = imageI32(0x97e44, 0);
    music.soundPaused = imageI32(0x97e40, 0);
    music.cdLastStatus = 0;
    music.cdTrackFirst = 0;
    music.cdTrackLast = 0;
  },
);

/**
 * main's res_load_named_config("mw2snd.cfg"): the file's 15 dwords become
 * soundConfigBuffer and are copied to 0x97e00..0x97e38; when there is none,
 * the image's are copied into a new buffer instead. (main then takes a
 * video driver name from it too, which the port has no use for.)
 *
 * @portOnly the mw2snd.cfg half of main (0x15a30); the file is never written back
 */
export function soundConfigLoad(): void {
  const f = dosFileLoad('mw2snd.cfg');
  if (!f || f.length < 0x3c) {
    sound.soundConfigBuffer = sound.soundConfig.slice();
    return;
  }
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  sound.soundConfigBuffer = Int32Array.from({ length: 15 }, (_, i) => dv.getInt32(i * 4, true));
  sound.soundConfig.set(sound.soundConfigBuffer);
}

/**
 * MSCDEX's audio status: 5 with no drive, 1 not ready, 4 paused, 3 playing
 * (the busy bit), else 2.
 *
 * @mw2 cd_audio_status 0x00042910
 * @fidelity partial
 * @divergence the IOCTL request goes to the port's CD drive interface
 */
export function cdAudioStatus(): number {
  const d = cdDrive.drive;
  if (music.cdAudioReady === 0 || !d) return 5;
  const s = d.status();
  if (s === 1) return 1;
  if (s === 4) return 4;
  return s === 3 ? 3 : 2;
}

/**
 * @mw2 cd_audio_ready 0x000435f0
 * @fidelity exact
 */
export function cdAudioReadyGet(): number {
  return music.cdAudioReady;
}

/**
 * @mw2 cd_track_in_range 0x00043600
 * @fidelity exact
 */
export function cdTrackInRange(track: number): number {
  return music.cdTrackFirst <= track && track <= music.cdTrackLast ? 1 : 0;
}

/**
 * Finds the drive, sets cdAudioReady, records its status, reads the disc's
 * track range (status 2..4) and sets the CD volume (cd_volume_apply's
 * computation, inlined: cdVolumeScale * 255 through cd_set_volume).
 *
 * @mw2 cd_audio_init 0x00042800
 * @fidelity partial
 * @divergence the drive search, IOCTLs and track table are the port's CD drive interface
 */
export function cdAudioInit(): number {
  const d = cdDrive.drive;
  if (!d) return 0;
  music.cdAudioReady = 1;
  music.cdLastStatus = cdAudioStatus();
  if (music.cdLastStatus >= 2 && music.cdLastStatus <= 4) {
    const r = d.trackRange();
    if (r) {
      music.cdTrackFirst = r.first;
      music.cdTrackLast = r.last;
    }
  }
  cdVolumeApply();
  return 1;
}

/**
 * The CD's volume from v (0..255) on a square law - v * v * 255 / 0xfe01,
 * clamped to 255 - into all four audio channels (MSCDEX audio channel
 * control: read, modified, written). Returns 1, or 0 when an IOCTL fails.
 *
 * @mw2 cd_set_volume 0x00043650
 * @fidelity partial
 * @divergence the IOCTLs are the port's CD drive interface: no drive is a failed read
 */
export function cdSetVolume(v: number): number {
  const d = cdDrive.drive;
  if (!d || music.cdAudioReady === 0) return 0;
  let vol = cdiv(Math.imul(Math.imul(v, v), 255), 0xfe01);
  if (vol >= 0xff) vol = 0xff;
  d.setVolume(vol & 0xff);
  return 1;
}

/**
 * cd_set_volume(cdVolumeScale * 255, 16.16 rounded).
 *
 * @mw2 cd_volume_apply 0x000436d0
 * @fidelity exact
 */
export function cdVolumeApply(): number {
  const p = BigInt(cdVolumeScale()) * 255n;
  return cdSetVolume(Number(BigInt.asIntN(32, (p >> 16n) + ((p >> 15n) & 1n))));
}

/**
 * @mw2 cd_status_update 0x00042980
 * @fidelity exact
 */
export function cdStatusUpdate(): void {
  music.cdLastStatus = cdAudioStatus();
}

/**
 * 1, recording the new status, when the drive's differs from the last
 * recorded one; else 0.
 *
 * @mw2 cd_status_changed 0x00042d70
 * @fidelity partial
 * @divergence the track table's free and re-read on a not-ready drive are the drive interface's
 */
export function cdStatusChanged(): number {
  if (music.cdAudioReady === 0) return 0;
  const s = cdAudioStatus();
  if (s === music.cdLastStatus) return 0;
  music.cdLastStatus = s;
  return 1;
}

/**
 * Plays track n when it is on the disc and the drive reports 2..4.
 *
 * @mw2 cd_play_track 0x00042f70
 * @fidelity partial
 * @divergence the MSCDEX play request (from the track's start sector, length computed from the table) is the drive interface's play(n)
 */
export function cdPlayTrack(n: number): void {
  const d = cdDrive.drive;
  if (music.cdAudioReady === 0 || !d) return;
  const s = cdAudioStatus();
  if (s < 2 || 4 < s) return;
  if (n < music.cdTrackFirst || music.cdTrackLast < n) return;
  if (s === 3) d.stop();
  d.play(n);
}

/**
 * By status: stopped plays from the disc's first track; playing pauses (a
 * first MSCDEX stop); paused resumes.
 *
 * @mw2 cd_pause_toggle 0x000429d0
 * @fidelity partial
 * @divergence a paused drive at the very start of the first track is replayed rather than resumed in the original; the port resumes
 */
export function cdPauseToggle(): void {
  const d = cdDrive.drive;
  if (music.cdAudioReady === 0 || !d) return;
  const s = cdAudioStatus();
  if (s === 2) d.play(music.cdTrackFirst);
  else if (s === 3) d.pause();
  else if (s === 4) d.resume();
}

/**
 * Stops the drive until it reports stopped.
 *
 * @mw2 cd_stop 0x00042c30
 * @fidelity partial
 * @divergence one stop request to the drive interface
 */
export function cdStop(): void {
  const d = cdDrive.drive;
  if (music.cdAudioReady === 0 || !d) return;
  d.stop();
}

/**
 * First call: reads the mission's MUS resource ('N M') into musicCdTrack and
 * musicXmidi. Then, with a drive and soundFlags 8: a drive that is not ready
 * is a system error; a track on the disc is played, and musicCdTrack is
 * cleared unless the drive then reports playing.
 *
 * @mw2 music_start_mission_track 0x00043c10
 * @fidelity exact
 */
export function musicStartMissionTrack(): void {
  if (music.musicTrackLoaded === 0) {
    music.musicTrackLoaded = 1;
    const id = lighting.missionMusicResource;
    if (id < 1) return;
    const res = cacheLoadResource(id, 'MUS');
    if (!res) return;
    const m = /^\s*([-+]?\d+)\s+([-+]?\d+)/.exec(String.fromCharCode(...res.subarray(0, Math.min(res.length, 64))));
    if (m) {
      music.musicCdTrack = Number(m[1]) | 0;
      music.musicXmidi = Number(m[2]) | 0;
    } else unestablished('music_start_mission_track: MUS resource not "%d %d"; sscanf would leave the fields as they were', 'music_start_mission_track');
    cacheUnlock(id, 'MUS');
  }
  if (cdAudioReadyGet() !== 0 && music.musicCdTrack !== -1 && (soundFlags() & 8) !== 0) {
    if (cdAudioStatus() === 1) {
      systemError(0x53);
      return;
    }
    if (cdTrackInRange(music.musicCdTrack) !== 0) {
      cdPlayTrack(music.musicCdTrack);
      cdStatusUpdate();
      if (music.cdLastStatus !== 3) {
        music.musicCdTrack = -1;
        return;
      }
      music.musicXmidi = -1;
    }
  }
}

/**
 * main's per-frame music step: unless paused, with soundFlags 8, the track is
 * played again when the drive's status changes (it ran out).
 *
 * @mw2 music_update 0x00043dd0
 * @fidelity exact
 */
export function musicUpdate(): void {
  if (music.soundPaused === 0 && (soundFlags() & 8) !== 0) {
    if (cdStatusChanged() !== 0 && music.musicCdTrack !== -1) {
      cdPlayTrack(music.musicCdTrack);
      cdStatusUpdate();
    }
  }
}

/**
 * The sound system up: the mixer with 8 channels, the MIDI driver, the CD,
 * the per-sound settings, and the enemy-lock warning's first check.
 *
 * @mw2 sound_init_all 0x00043e10
 * @fidelity exact
 */
export function soundInitAll(): number {
  soundInit(8);
  midiOpen();
  cdAudioInit();
  soundSettingsInit();
  sound.enemyLockWarnTick = (clock.simTick + 0x38e) | 0;
  return 1;
}

/**
 * At exit: the CD stopped, the MIDI driver closed, the mixer shut down, and
 * mw2snd.cfg written back.
 *
 * @mw2 sound_save_config 0x00043f20
 * @fidelity partial
 * @divergence sound_release_sequences has no sequence to release (no XMIDI is loaded in a mission)
 */
export function soundSaveConfig(): void {
  if (music.musicCdTrack !== -1) cdStop();
  midiClose();
  soundShutdown();
  // sound_config_write("mw2snd.cfg", soundConfigBuffer): 0x3c bytes
  const out = new Uint8Array(0x3c);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 15; i++) dv.setInt32(i * 4, sound.soundConfigBuffer?.[i] ?? 0, true);
  dosFileWrite('mw2snd.cfg', out);
}

/**
 * game_update_pause's pause: every effect but the voice line stopped, the
 * queue behind it dropped and the line stopped, the music paused once, the
 * engine note muted.
 *
 * @mw2 sound_pause 0x00043f70
 * @fidelity exact
 */
export function soundPause(): void {
  soundStopChannels(0);
  voiceQueuePause();
  if (music.soundPaused === 0) {
    // XMIDI sequences (musicXmidi, soundFlags 4): none is ever loaded in a mission
    if (music.musicCdTrack !== -1 && (soundFlags() & 8) !== 0) cdPauseToggle();
    music.soundPaused = 1;
  }
  engineNoteMute();
}

/**
 * game_update_pause's resume: the music resumed, then the voice line.
 *
 * @mw2 sound_resume 0x00043fd0
 * @fidelity exact
 */
export function soundResume(): void {
  if (music.soundPaused !== 0) {
    if (music.musicCdTrack !== -1 && (soundFlags() & 8) !== 0) cdPauseToggle();
    music.soundPaused = 0;
  }
  voiceResume();
}
