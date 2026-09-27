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
import { dosDiskSnapshot, dosFileLoad, setDosFiles, setOverlayFiles, setOwnFiles } from '../engine/dosFiles.ts';
import { checkLaunchedByShell } from './commandLine.ts';
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
import { bootLoadLaunchAnims, gameBootSub0155a0 } from '../sim/display/launchScreen.ts';
import { setMekSource } from '../sim/mech/looseFiles.ts';
import { DEFAULT_RULES, rulesToBytes, simOptionsLoad, type SimRules } from '../sim/mech/simOptions.ts';
import { destructiblesReset } from '../sim/things/destructibles.ts';
import { gamethingTableReset } from '../sim/things/gameThings.ts';
import { simCountMechsByStatus } from '../sim/things/allegianceTally.ts';
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
   * The whole disk for this run (USERSTAR.BWD, EN0?STAR.BWD, MEK/*.MEK,
   * INPUT.MAP, GAMEKEY.MAP, GIDDI/*.DLL ...), upper-case keys with '/' -
   * tests' way of supplying files. Omitted, the mission reads the disk as
   * the host has set it up (engine/dosFiles.ts).
   */
  looseFiles?: Map<string, Uint8Array>;
  /**
   * The rule toggles to use instead of the disk's mw2dif.cfg; null for the
   * original's no-file zeroes. Omitted: mw2dif.cfg from the disk, or
   * DEFAULT_RULES when the disk has none.
   */
  rules?: SimRules | null;
  /** MW2.EXE's argv, as MECH2 spawns it (argv[0] 'mw2.exe', then the command line mw2prm.cfg carries) */
  argv?: readonly string[];
  /** the mission stream to load, e.g. 'AMY_SCN1', when there is no argv (the dev route and tests) */
  mission?: string;
  /** the RNG seed (the original's is the argv pointer; see core/random.ts) */
  randomSeed?: number;
}

/**
 * main()'s start-up up to and including the launch screen
 * (boot_load_launch_anims): returns the rest of it to run, or false when
 * check_launched_by_shell says stop. The host shows the launch screen
 * (sim/display/launchScreen.ts) between the two.
 *
 * @portOnly the sequence is main's (0x15a30); every call in it is a ported function or a stated gap
 */
export function bootMissionStart(opts: MissionBootOptions): (() => boolean) | false {
  setBootImage(opts.exe);
  resetAllGlobals();
  resetProvenanceSeen();
  installSystemErrorHandler(opts.exe, opts.ini ?? null);
  // project_open
  setMainProject(opts.prj);
  if (opts.looseFiles) {
    setDosFiles(opts.looseFiles);
    setOwnFiles(new Map());
    setOverlayFiles(null);
  }
  const disk = dosDiskSnapshot();
  setLooseFiles(disk);
  setMekSource(disk);
  // main reads mw2snd.cfg before anything else it brings up
  soundConfigLoad();
  brightnessLoad();
  // check_launched_by_shell: the scenario and the shell's options
  let mission = opts.mission ?? '';
  if (opts.argv) {
    const r = checkLaunchedByShell(opts.argv);
    if (!r.ok) return false;
    mission = r.args;
  }
  const dif = dosFileLoad('mw2dif.cfg');
  if (opts.rules === undefined && !dif) divergence("no mw2dif.cfg on the disk: the port's DEFAULT_RULES, not the original's all-off record", 'sim_options_load');
  simOptionsLoad(opts.rules === undefined ? (dif ?? rulesToBytes(DEFAULT_RULES)) : opts.rules ? rulesToBytes(opts.rules) : null);
  audioTimerInit();
  videoInit();
  bootLoadLaunchAnims();
  return () => bootMissionFinish(opts, mission);
}

/**
 * main()'s start-up from project_open to the frame loop, all at once.
 *
 * @portOnly the sequence is main's (0x15a30): bootMissionStart then bootMissionFinish
 */
export function bootMission(opts: MissionBootOptions): boolean {
  const finish = bootMissionStart(opts);
  return finish ? finish() : false;
}

/** The rest of main's start-up, after the launch screen is up (its animation running meanwhile). */
function bootMissionFinish(opts: MissionBootOptions, mission: string): boolean {
  // static_arena_init: the DTBL pre-pass sizes arenas; the port allocates on demand
  divergence('static_arena_init: no arena pre-pass; tables are allocated on demand', 'main');
  randomTablesInit(opts.randomSeed);
  brightnessTablesBuild();
  soundInitAll();
  vfxVideoSub010320();
  simTablesReset();
  gamethingTableReset();
  destructiblesReset();
  const ok = simLoadByName(mission);
  // project_scan_dev_dir: the loose files are the host's overlay
  layoutRescaleAll();
  dayCycleInit();
  worldRecordsBuildAll();
  simPreloadData();
  simCountMechsByStatus();
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
  // hangAround's debug title (input_sub_048e80, hud_draw_title): not ported
  gameBootSub0155a0();
  screenFadeIn(0, defaultCanvas);
  return ok;
}
