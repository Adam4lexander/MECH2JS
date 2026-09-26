/**
 * What main does once its loop ends (quitCountdown reaches 3), in order:
 *   palette_fade_screen_to_preset(missionEndCode & 4); cockpit_save_config();
 *   mech_dispatch_hook5(); netplay_shutdown(); sound_save_config();
 *   ui_context_clear_all(); project_shutdown(); vfx_video_sub_010780();
 *   game_boot_sub_0158e0(); input_sub_048c20(); [main_sub_049f40()];
 *   mission_clock_update(); mission_save_results(); exit.
 * The original writes its results to MW2CAR.CFG (the tallies) and
 * mw2msn.cfg (the mission record) and exits; the shell program shows the
 * debriefing from them. The port never writes those files: the same bytes
 * come back to the host as a MissionResults, and the host shows the
 * debriefing (src/app).
 */
import { soundSaveConfig } from '../sim/sound/music.ts';
import { cacheLoadResource, cacheUnlock } from '../engine/resources/cache.ts';
import { imageU8 } from '../engine/image.ts';
import { mechDispatchHook5 } from '../sim/mech/hooks.ts';
import { mechs } from '../sim/mech/mechGlobals.ts';
import { missionEndCode } from '../sim/mech/damage.ts';
import { simTables } from '../sim/effects/simTables.ts';
import { paletteApplySlot, paletteFadeUsedColours, palettes } from '../sim/world/palettes.ts';
import { defaultCanvas } from '../sim/display/video.ts';
import { unestablished } from '../core/provenance.ts';
import { missionClockUpdate } from './missionClock.ts';
import { objectives } from './objectives.ts';

/** mw2msn.cfg's record: 0x9d4 bytes. */
export const MISSION_RECORD_SIZE = 0x9d4;

export interface MissionObjectiveResult {
  succeeded: number;
  category: number;
  startedAt: number;
  changedAt: number;
  /** Objective.isPrerequisite - the objective is required (the 'M' flag) */
  required: number;
  text: string;
}

/** @portOnly what the original leaves in mw2msn.cfg and MW2CAR.CFG, handed to the host */
export interface MissionResults {
  /** the 0x9d4-byte mw2msn.cfg record, byte for byte */
  record: Uint8Array;
  /** 2 successful, 3 failed, 4 time exceeded, 0 undecided */
  result: number;
  /** seconds: the player's table's start and decision times */
  startTime: number;
  decidedAt: number;
  /** the player's listed objectives, in table order */
  objectives: MissionObjectiveResult[];
  /** the 0x50 bytes at 0xa5630 - the tallies and missionEndCode - as MW2CAR.CFG gets them */
  career: Uint8Array;
  missionEndCode: number;
}

/**
 * Fades the screen to preset slot 0x10, or 0x11 when the player died with
 * ejection refused (missionEndCode 4), then applies that slot.
 *
 * @mw2 palette_fade_screen_to_preset 0x00028980
 * @fidelity exact
 */
export function paletteFadeScreenToPreset(ejectRefused: number): void {
  const slot = (ejectRefused !== 0 ? 1 : 0) + 0x10;
  const id = palettes.paletteResourceIds[slot]!;
  const rgb = cacheLoadResource(id, 'PAL');
  if (rgb) {
    paletteFadeUsedColours(defaultCanvas, rgb, 0x5a);
    cacheUnlock(id, 'PAL');
    paletteApplySlot(slot);
  }
}

/**
 * Saves the 0x50 bytes at 0xa5630 - the kill and loss tallies and
 * missionEndCode - to MW2CAR.CFG.
 *
 * @mw2 cockpit_save_config 0x00051d20
 * @fidelity partial
 * @divergence the port never writes the game's cfg files: the block is returned to the host instead
 */
export function cockpitSaveConfig(): Uint8Array {
  return simTables.dat000a5630.slice(0, 0x50);
}

/**
 * Packs the player's table into mw2msn.cfg's record: 'MW2M', the count of
 * listed objectives, the table's start and decision times and result, and
 * per listed objective {succeeded (state 5), category, startedAt,
 * changedAt, required, text} at a 0x34 stride. The text is strcpy'd into a
 * 0x20-byte field, so a longer one runs into the next record's head, which
 * that record then overwrites.
 *
 * @mw2 mission_save_results 0x000170e0
 * @fidelity partial
 * @divergence the record is returned to the host rather than written to mw2msn.cfg
 */
export function missionSaveResults(): MissionResults {
  const b = new Uint8Array(MISSION_RECORD_SIZE);
  const dv = new DataView(b.buffer);
  for (let k = 0; k < 4; k++) b[k] = imageU8(0x90150 + k, 'MW2M'.charCodeAt(k));
  const T = objectives.objectiveTables[mechs.playerGroupIndex]!;
  dv.setInt32(8, T.startTime, true);
  dv.setInt32(0xc, T.decidedAt, true);
  dv.setUint32(0x10, T.result & 0xff, true);
  const list: MissionObjectiveResult[] = [];
  let n = 0;
  for (let i = 0; i < T.count; i++) {
    const o = T.objectives[i]!;
    if (o.listed === 0) continue;
    const at = 0x14 + n * 0x34;
    const r: MissionObjectiveResult = {
      succeeded: o.state === 5 ? 1 : 0,
      category: o.category & 0xff,
      startedAt: o.startedAt,
      changedAt: o.changedAt,
      required: o.isPrerequisite,
      text: o.text,
    };
    dv.setUint32(at, r.succeeded, true);
    dv.setUint32(at + 4, r.category, true);
    dv.setInt32(at + 8, r.startedAt, true);
    dv.setInt32(at + 0xc, r.changedAt, true);
    dv.setInt32(at + 0x10, r.required, true);
    for (let k = 0; k <= o.text.length; k++) {
      const p = at + 0x14 + k;
      if (p >= b.length) {
        unestablished('mission_save_results: an objective text runs past the end of the record, onto the stack', 'mission_save_results');
        break;
      }
      b[p] = k < o.text.length ? o.text.charCodeAt(k) & 0xff : 0;
    }
    list.push(r);
    n++;
  }
  dv.setInt32(4, n, true);
  return {
    record: b,
    result: T.result & 0xff,
    startTime: T.startTime,
    decidedAt: T.decidedAt,
    objectives: list,
    career: new Uint8Array(0),
    missionEndCode: 0,
  };
}

/**
 * main's shutdown after the loop (see the file note), up to the results.
 *
 * @portOnly main (0x15a30) is claimed by nothing; its parts are tagged
 */
export function missionEnd(): MissionResults {
  paletteFadeScreenToPreset(missionEndCode() & 4);
  const career = cockpitSaveConfig();
  mechDispatchHook5();
  // netplay_shutdown: single player, nothing to shut
  soundSaveConfig();
  // ui_context_clear_all, project_shutdown, vfx_video_sub_010780, game_boot_sub_0158e0 and
  // input_sub_048c20 tear down the UI, project, video and input;
  // the port's next mission load resets every table instead (resetAllGlobals)
  missionClockUpdate();
  const r = missionSaveResults();
  r.career = career;
  r.missionEndCode = missionEndCode();
  return r;
}
