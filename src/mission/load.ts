/**
 * Loading a mission: sim_load_by_name and the part of main() between
 * project_open and the frame loop, in the original's order.
 *
 * Steps of main() that belong to hardware or to later phases are listed in
 * order below with what the port does for each, so the sequence stays
 * checkable against game_boot.c (main @ 0x15a30, lines ~540-590 of the
 * export).
 */
import { musicStartMissionTrack, soundConfigLoad, soundInitAll } from '../sim/sound/music.ts';
import { randomTablesInit } from '../core/random.ts';
import { audioTimerInit, simClockReset } from '../engine/clock.ts';
import { uiContextRegister } from '../sim/ui/uiContext.ts';
import { setDosFiles } from '../engine/dosFiles.ts';
import { inputInit } from '../sim/controls/input.ts';
import { cameraInit } from '../sim/camera/cameraUpdate.ts';
import { terrainTableReset } from '../sim/mech/animTask.ts';
import { resetProvenanceSeen, divergence } from '../core/provenance.ts';
import type { IniFile } from '../data/config/ini.ts';
import type { ExeImage } from '../data/exe/ExeImage.ts';
import type { ProjectFile } from '../data/prj/ProjectFile.ts';
import { systemError } from '../core/systemError.ts';
import { resetAllGlobals } from '../engine/globals.ts';
import { setBootImage } from '../engine/image.ts';
import { setMainProject } from '../engine/resources/cache.ts';
import { simPreloadData } from '../engine/resources/preload.ts';
import { polySetVertexOffset } from '../engine/scene/wtboLoader.ts';
import { installSystemErrorHandler } from '../engine/systemErrors.ts';
import { simTablesReset } from '../sim/effects/simTables.ts';
import { groupReset } from '../sim/groups/groups.ts';
import { groupsStartMission } from '../sim/groups/orders.ts';
import { mechDispatchHook0 } from '../sim/mech/hooks.ts';
import { thingNodes } from '../sim/mech/spawn.ts';
import { layoutRescaleAll } from '../sim/display/rescale.ts';
import { defaultCanvas, videoInit } from '../sim/display/video.ts';
import { vfxVideoSub010320 } from '../sim/display/mainView.ts';
import { setMekSource } from '../sim/mech/looseFiles.ts';
import { destructiblesReset } from '../sim/things/destructibles.ts';
import { gamethingTableReset } from '../sim/things/gameThings.ts';
import { dayCycleInit } from '../sim/world/dayCycle.ts';
import { projectMapsAlloc, projectMapsFree, projectSetMangle } from '../sim/world/projectMaps.ts';
import { worldRecordsAllDefined, worldRecordsBuildAll, worldRecordsTick } from '../sim/world/worldRecords.ts';
import { objectiveTableStart } from './objectives.ts';
import { vfxVideoSub0103c0 } from '../sim/world/viewScene.ts';
import { brightnessLoad, brightnessTablesBuild } from '../sim/world/brightness.ts';
import { screenFadeIn } from '../sim/world/palettes.ts';
import { detailOptionsApplyThunk } from '../sim/ui/menuCallbacks.ts';
import { missionTables, missionTablesFree } from './tables/missionTables.ts';
import { projectChunkExec } from './vm/chunkExec.ts';
import { projectItemRelease, projectOpenStream, setLooseFiles } from './vm/streams.ts';

/**
 * Loads the named mission stream and runs it through the interpreter.
 * A name starting with a digit is taken as a BWD id.
 *
 * @mw2 sim_load_by_name 0x0004fc00
 * @fidelity exact
 */
export function simLoadByName(name: string): boolean {
  groupReset();
  thingNodes.thingNodeQueue.fill(-1);
  thingNodes.thingNodeCount = 0;
  thingNodes.thingNodeNext = 0;
  polySetVertexOffset(0, 0, 0);
  const id = /^\d/.test(name) ? parseInt(name, 10) | 0 : -1;
  const ref = { id: (id << 16) >> 16, name: name.slice(0, 12) };
  projectSetMangle(0);
  let ok = 0;
  const item = projectOpenStream(ref);
  if (item && projectMapsAlloc()) {
    ok = projectChunkExec(item);
    projectItemRelease(item);
    missionTablesFree();
    projectMapsFree();
    if (!worldRecordsAllDefined()) systemError(0x4b);
  }
  if (!ok) systemError(0xb, name);
  return ok !== 0;
}

export interface MissionBootOptions {
  exe: ExeImage;
  prj: ProjectFile;
  ini?: IniFile | null;
  /**
   * the install's loose files (USERSTAR.BWD, EN0?STAR.BWD, MEK/*.MEK,
   * INPUT.MAP, GAMEKEY.MAP, GIDDI/*.DLL ...), upper-case keys with '/'
   */
  looseFiles?: Map<string, Uint8Array>;
  /** the mission stream to load, e.g. 'AMY_SCN1' */
  mission: string;
  /** the RNG seed (the original's is the argv pointer; see core/random.ts) */
  randomSeed?: number;
}

/**
 * main()'s start-up from project_open to the frame loop.
 *
 * @portOnly the sequence is main's (0x15a30); every call in it is a ported function or a stated gap
 */
export function bootMission(opts: MissionBootOptions): boolean {
  setBootImage(opts.exe);
  resetAllGlobals();
  resetProvenanceSeen();
  installSystemErrorHandler(opts.exe, opts.ini ?? null);
  // project_open
  setMainProject(opts.prj);
  setLooseFiles(opts.looseFiles ?? new Map());
  setMekSource(opts.looseFiles ?? new Map());
  setDosFiles(opts.looseFiles ?? new Map());
  // main reads mw2snd.cfg before anything else it brings up
  soundConfigLoad();
  brightnessLoad();
  // sim_options_load happens before this in main; the timer comes up here
  audioTimerInit();
  videoInit();
  // static_arena_init: the DTBL pre-pass sizes arenas; the port allocates on demand
  divergence('static_arena_init: no arena pre-pass; tables are allocated on demand', 'main');
  randomTablesInit(opts.randomSeed);
  brightnessTablesBuild();
  soundInitAll();
  vfxVideoSub010320();
  simTablesReset();
  gamethingTableReset();
  destructiblesReset();
  const ok = simLoadByName(opts.mission);
  // project_scan_dev_dir: the loose files are the host's overlay
  layoutRescaleAll();
  dayCycleInit();
  worldRecordsBuildAll();
  simPreloadData();
  // sim_count_mechs_by_status, terrain_table_reset, camera_init, input_init: Phase 2
  // sim_count_mechs_by_status: the allegiance tallies (0xa5668..) feed the results screen, Phase 6
  divergence('sim_count_mechs_by_status is not ported (Phase 6: its tallies feed the results)', 'main');
  terrainTableReset();
  cameraInit();
  // game_boot_sub_015670 re-hooks the keyboard interrupt: the host's
  inputInit();
  for (const id of [4, 5, 6, 7, 8, 3]) uiContextRegister(id);
  for (let i = 0; i < missionTables.missionTableCount; i++) objectiveTableStart(i);
  mechDispatchHook0();
  groupsStartMission();
  // netplay_start (single player: nothing); ui_callbacks_sub_0196a0 is an empty function
  musicStartMissionTrack();
  simClockReset();
  worldRecordsTick();
  vfxVideoSub0103c0();
  detailOptionsApplyThunk();
  // hangAround's debug title (input_sub_048e80, hud_draw_title): not ported; game_boot_sub_0155a0 stops the launch animation, which the port has none of
  screenFadeIn(0, defaultCanvas);
  return ok;
}
