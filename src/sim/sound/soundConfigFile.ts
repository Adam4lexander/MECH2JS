/**
 * MW2SND.CFG, the 0x3c-byte SoundConfig both programs keep: the shell's
 * options panel edits it (soundConfig, 0x7d3d0 in MW2SHELL.EXE) and MW2.EXE
 * loads it as soundConfigBuffer (sim/sound/music.ts soundConfigLoad) and
 * writes it back at exit. Fifteen little-endian dwords, the last four
 * holding a 16-byte video driver name.
 *
 * Neither program needs the file - each falls back to its own image's
 * values - but the two images disagree (MW2.EXE's: flags 0xb and
 * 'mcga.dll'; the shell's: flags 0xf and no name), so the port writes one on
 * a first run and both programs meet the same record.
 */
import { divergence } from '../../core/provenance.ts';
import { dosFileLoad, dosFileWrite } from '../../engine/dosFiles.ts';

/** The record, field by field (the names are the shell's; see SoundConfig in mw2shell_types.h). */
export interface SoundConfigFile {
  /** +0x00: MW2's sound_option_get selector 3; what it means is not established */
  word0: number;
  /** +0x04: 0..0x10000, MW2's sfxVolumeScale */
  sfxVolume: number;
  /** +0x08: 0..0x10000, MW2's voiceVolumeScale */
  voiceVolume: number;
  /** +0x0c: 0..0x10000, MW2's cdVolumeScale */
  musicVolume: number;
  /** +0x10: MW2's soundFlags - 2 speech, 4 XMIDI music, 8 CD music */
  flags: number;
  /** +0x14 .. +0x24: the panel's ON / OFF and HIGH / LOW rows */
  objectTextures: number;
  terrainTextures: number;
  displayDetail: number;
  objectDensity: number;
  explosionChunks: number;
  /** +0x28: MW2's brightness level */
  brightness: number;
  /** +0x2c, char[16]: '' (320x200), 'vesa480.dll' (640x480), 'vesa768.dll' (1024x768) */
  videoDriver: string;
}

/** The record's size. */
export const SOUND_CONFIG_SIZE = 0x3c;

/**
 * The port's MW2SND.CFG when its disk has none: MW2SHELL.EXE's boot
 * soundConfig - what its options panel writes when the file was missing.
 * test/sim/shellOptions.test.ts checks these against the shell's image.
 */
export const DEFAULT_SOUND_CONFIG: Readonly<SoundConfigFile> = {
  word0: 0x10000,
  sfxVolume: 0x10000,
  voiceVolume: 0x10000,
  musicVolume: 0x10000,
  flags: 0xf,
  objectTextures: 1,
  terrainTextures: 1,
  displayDetail: 1,
  objectDensity: 1,
  explosionChunks: 1,
  brightness: 8,
  videoDriver: '',
};

const DWORDS = ['word0', 'sfxVolume', 'voiceVolume', 'musicVolume', 'flags', 'objectTextures', 'terrainTextures', 'displayDetail', 'objectDensity', 'explosionChunks', 'brightness'] as const;

/** @portOnly the record's bytes */
export function soundConfigToBytes(cfg: Readonly<SoundConfigFile>): Uint8Array {
  const out = new Uint8Array(SOUND_CONFIG_SIZE);
  const dv = new DataView(out.buffer);
  DWORDS.forEach((k, i) => dv.setInt32(i * 4, cfg[k] | 0, true));
  for (let i = 0; i < 16 && i < cfg.videoDriver.length; i++) out[0x2c + i] = cfg.videoDriver.charCodeAt(i) & 0xff;
  return out;
}

/** @portOnly the record read from a file's bytes (a short file reads as zeroes past its end) */
export function soundConfigFromBytes(bytes: Uint8Array): SoundConfigFile {
  const b = new Uint8Array(SOUND_CONFIG_SIZE);
  b.set(bytes.subarray(0, SOUND_CONFIG_SIZE));
  const dv = new DataView(b.buffer);
  const cfg = {} as SoundConfigFile;
  DWORDS.forEach((k, i) => (cfg[k] = dv.getInt32(i * 4, true)));
  let name = '';
  for (let i = 0x2c; i < SOUND_CONFIG_SIZE && b[i] !== 0; i++) name += String.fromCharCode(b[i]!);
  cfg.videoDriver = name;
  return cfg;
}

/**
 * MW2SND.CFG on the port's disk: written from DEFAULT_SOUND_CONFIG when
 * absent, never replaced.
 *
 * @portOnly the port's first run
 */
export function soundConfigFileEnsure(): Uint8Array {
  const f = dosFileLoad('MW2SND.CFG');
  if (f) return f;
  divergence("no MW2SND.CFG on the disk: the port writes the shell's boot soundConfig, where each original program fell back to its own image's (and the installer may have left one)");
  const bytes = soundConfigToBytes(DEFAULT_SOUND_CONFIG);
  dosFileWrite('MW2SND.CFG', bytes);
  return bytes;
}
