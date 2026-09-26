/**
 * Loading a mission: sim_load_by_name and the part of main() between
 * project_open and the frame loop, in the original's order.
 *
 * Steps of main() that belong to hardware or to later phases are listed in
 * order below with what the port does for each, so the sequence stays
 * checkable against game_boot.c (main @ 0x15a30, lines ~540-590 of the
 * export).
 */
import { randomTablesInit } from '../core/random.ts';
import { resetProvenanceSeen, divergence } from '../core/provenance.ts';
import type { IniFile } from '../data/config/ini.ts';
import type { ExeImage } from '../data/exe/ExeImage.ts';
import type { ProjectFile } from '../data/prj/ProjectFile.ts';
import { systemError } from '../core/systemError.ts';
import { resetAllGlobals } from '../engine/globals.ts';
import { setBootImage } from '../engine/image.ts';
import { setMainProject } from '../engine/resources/cache.ts';
import { simPreloadData } from '../engine/resources/preload.ts';
import { objectListsReset } from '../engine/scene/objectLists.ts';
import { polySetVertexOffset } from '../engine/scene/wtboLoader.ts';
import { installSystemErrorHandler } from '../engine/systemErrors.ts';
import { simTablesReset } from '../sim/effects/simTables.ts';
import { groupReset, groupsStartMission } from '../sim/groups/groups.ts';
import { mechDispatchHook0 } from '../sim/mech/hooks.ts';
import { thingNodes } from '../sim/mech/spawn.ts';
import { viewerUpdateProjection } from '../sim/camera/projection.ts';
import { cameraGlobals } from '../sim/camera/viewer.ts';
import { setMekSource } from '../sim/mech/looseFiles.ts';
import { destructiblesReset } from '../sim/things/destructibles.ts';
import { gamethingTableReset } from '../sim/things/gameThings.ts';
import { dayCycleInit } from '../sim/world/dayCycle.ts';
import { projectMapsAlloc, projectMapsFree, projectSetMangle } from '../sim/world/projectMaps.ts';
import { worldRecordsAllDefined, worldRecordsBuildAll, worldRecordsTick } from '../sim/world/worldRecords.ts';
import { objectiveTableStart } from './objectives.ts';
import { vfxVideoSub0103c0 } from '../sim/world/viewScene.ts';
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
  /** loose files beside MW2.PRJ (USERSTAR.BWD, EN0?STAR.BWD, ...), upper-case names */
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
  // static_arena_init: the DTBL pre-pass sizes arenas; the port allocates on demand
  divergence('static_arena_init: no arena pre-pass; tables are allocated on demand', 'main');
  randomTablesInit(opts.randomSeed);
  // vfx_video_sub_010320 (video setup) resets the object lists
  objectListsReset();
  simTablesReset();
  gamethingTableReset();
  destructiblesReset();
  const ok = simLoadByName(opts.mission);
  dayCycleInit();
  worldRecordsBuildAll();
  simPreloadData();
  // the frame renderer runs viewer_update_projection before drawing; done once here so lodScale is set for the editor
  viewerUpdateProjection(cameraGlobals.mainViewer);
  // sim_count_mechs_by_status, terrain_table_reset, camera_init, input_init: Phase 2
  divergence('camera_init, input_init and the mech status count run in Phase 2', 'main');
  for (let i = 0; i < missionTables.missionTableCount; i++) objectiveTableStart(i);
  mechDispatchHook0();
  groupsStartMission();
  // netplay_start, music_start_mission_track, sim_clock_reset: later phases
  worldRecordsTick();
  vfxVideoSub0103c0();
  return ok;
}
