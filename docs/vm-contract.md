# Mission VM contract (M1.7)

`project_chunk_exec` (src/mission/vm/chunkExec.ts) is the project file's
interpreter. It calls into three clusters, each owned by one file set. These
are the exact exports it imports - names, files and signatures are fixed so
the pieces can be written in parallel. A cluster may export more; it must not
rename these.

Chunks are `Chunk` objects (src/data/bwd/stream.ts): `c.i16(o)`, `c.i32(o)`,
`c.u16(o)`, `c.str(o, max)`, `c.ref(o)` read at offsets FROM THE CHUNK START,
exactly as the decompiled code indexes `cur` (payload begins at +8). A
`{short id; char name[]}` stream/resource reference is a `StreamRef`
(`c.ref(8)`).

Stream handlers (the callback project_item_apply / project_gpspec_apply run
an opened stream through) have the type `StreamHandler = (item: ProjectItem)
=> number` and return the 0/1 success the C returns.

Every ported function follows docs/porting-notes.md (`@mw2 name 0xaddr` looked
up in decompiled/mw2/build/names.csv, `@fidelity`, width coercion, no guessed
meanings). State lives in `registerGlobals` objects; boot values from the EXE
image through `imageI32(LABEL.x, fallback)` (src/engine/image.ts,
src/generated/labels.gen.ts). Stored callbacks are the TS functions, registered
with `registerCode(name, address, fn)` (src/engine/codePtr.ts).

Existing modules to build on (do not duplicate): scene graph
(src/engine/scene/sceneGraph.ts), world objects and meshes
(src/engine/scene/worldObject.ts), the WTBO loader
(src/engine/scene/wtboLoader.ts), object lists, resource cache
(src/engine/resources/cache.ts: cacheLoadResource, idByName), task lists
(src/engine/tasks/taskList.ts), clock (src/engine/clock.ts), world records,
block frames, detail records, project id maps (src/sim/world/*), gamethings,
destructibles, falling objects (src/sim/things/*), mech/group globals
(src/sim/mech/mechGlobals.ts: mechTable, mechCount, playerMechIndex,
currentGamepiece, groupTable, formationTable, playerGroupIndex,
affiliationAllegiance, netGameEnabled), viewer (src/sim/camera/viewer.ts),
planet (src/sim/world/planet.ts), EXE tables (src/data/exe/tables/*), BWD
payload decoders (src/data/bwd/payloads/*), formats (src/data/formats/*).

## A. Gamepieces - src/sim/mech/*, src/sim/groups/*

| export | file | original |
|---|---|---|
| `mechSpawn(index: number, createLoadout: CodeFn \| null): void` | sim/mech/spawn.ts | mech_spawn |
| `mechLoadConfig(loadout: MechLoadout, chassisName: string, mekId: number, configName: string): boolean` | sim/mech/config.ts | mech_load_config |
| `resLoadMgeo(ref: StreamRef, loadout: MechLoadout): void` | sim/mech/config.ts | res_load_mgeo (writes rideHeight, eyeOffsetY, mgeoWord2..4, torsoPanLimit, radius) |
| `mechDispatchHook0() .. mechDispatchHook5(): void` | sim/mech/hooks.ts | mech_dispatch_hook0..5 |
| `gamepieceClasses(): GamepieceClassLive[]` with `{classId, createLoadout: CodeFn\|null, hooks: (CodeFn\|null)[]}` | sim/mech/classes.ts | the table at 0x96088, resolved through resolveCode |
| `thingNodeQueue` state + `thingNodeQueuePop(): SceneNode \| null` | sim/mech/spawn.ts | thing_node_queue_pop (state: thingNodeQueue[150], thingNodeCount, thingNodeNext) |
| `groupReset(): void` | sim/groups/groups.ts | group_reset |
| `groupSetLeader(group: number, mech: number): void` | sim/groups/groups.ts | group_set_leader |
| `mechSetStarSlot(mech: number, slot: number): void` | sim/groups/groups.ts | mech_set_star_slot |
| `groupFormationsLoad(c: Chunk): void` | sim/groups/formations.ts | group_formations_load (GRP) |
| `starTableLoad(c: Chunk): void` | sim/groups/formations.ts | star_table_load (STAR) |
| `pathTableLoad(c: Chunk): void` | sim/groups/paths.ts | path_table_load (PTBL) |
| `formationTableLoad(c: Chunk): void` | sim/groups/formations.ts | formation_table_load (FTBL) |
| `groupsStartMission(): void` | sim/groups/groups.ts | groups_start_mission |

The create hooks and loadout constructors the class table points at
(mech_std_create_loadout, mech_std_create, mech_alt_create_loadout,
mech_alt_create, door_create_loadout, door_create) are ported in full and
registered with registerCode. The per-tick hooks (mech_std_tick_terrain, ...)
are registered as clearly marked `@fidelity stub` functions (Phase 2).
Also install `setPolyOwnerAffiliation` (src/engine/scene/wtboLoader.ts).

## B. Mission tables and streams - src/mission/*

| export | file | original |
|---|---|---|
| `projectOpenStream(ref: StreamRef): ProjectItem \| null` | mission/vm/streams.ts | project_open_stream (id -1 resolves the name via TABL 14; loose files via the FileSource overlay; BWD from mainProject) |
| `projectItemRelease(item: ProjectItem \| null): void` | mission/vm/streams.ts | project_item_release |
| `projectItemApply(c: Chunk, handler: StreamHandler): number` | mission/vm/streams.ts | project_item_apply (INCL; '^' substitution from the scenario table) |
| `projectGpspecApply(c: Chunk, handler: StreamHandler): number` | mission/vm/streams.ts | project_gpspec_apply (GPS) |
| `streamSeenAdd/Find/Clear` | mission/vm/streams.ts | stream_seen_* |
| `scenarioTableLoad(c: Chunk): number` | mission/tables/scenario.ts | scenario_table_load (STBL) |
| `missionTableLoad(c: Chunk): void` + `mtblMarkName: string` state | mission/tables/missionTables.ts | mission_table_load (MTBL) |
| `missionMarkByName(name: string): number` | mission/tables/missionTables.ts | mission_mark_by_name |
| `missionMarksScanNop(): void` | mission/tables/missionTables.ts | mission_marks_scan_nop |
| `missionRecordAddValue(name: string, mask: number, value: number): void` | mission/tables/missionTables.ts | mission_record_add_value |
| `missionTablesFree(): void` | mission/tables/missionTables.ts | mission_tables_free |
| `objectiveTableInstall(...)`, `objectiveTableStart(i: number)` | mission/objectives.ts | objective_table_install / _start |
| `projectChunkReadValues(c: Chunk): [number, number]` | mission/vm/streams.ts | project_chunk_read_values (+8 first, +0xc second) |

`StreamHandler` and a `setLooseFiles(source)` hook for the loose-file
overlay (USERSTAR.BWD etc.) are defined in mission/vm/streams.ts.

## C. Visual and misc handlers - src/sim/world/*, src/sim/effects/*, src/engine/*

| export | file | original |
|---|---|---|
| `paletteSlotSetResource(resId: number, slot: number): number` + palette slot state | sim/world/palettes.ts | palette_slot_set_resource |
| `bitmap3dAddFrame(celId: number, x: number)`, `bitmap3dSetId(id: number, x: number)`, `bitmap3dSetSec(slot: number, sec: number)`, `bitmap3dSetEnable(slot: number, mode: number)`, `bitmap3dReset()`, `bitmap3dAnimate()` + tables | sim/world/bitmap3d.ts | bitmap3d_* |
| `framePrjAdd(id: number, a: number, b: number)` | sim/world/framePrj.ts | frame_prj_add |
| `anim2dAdd(c: Chunk)` | sim/world/anim2d.ts | anim2d_add |
| `animEnsureLoaded(ref: StreamRef): number` | sim/mech/anim.ts | anim_ensure_loaded (+ res_load_anim) |
| `resLoadCockpit(ref: StreamRef): void`, `resLoadHdi(ref: StreamRef): void` | sim/cockpit/resources.ts | res_load_cockpit / res_load_hdi (may be partial: record what they load) |
| `scroungeInstall(node: SceneNode): void` | sim/world/scrounge.ts | scrounge_install |
| `simTablesReset(): void`, `projectileClear(i)`, projectiles[175] + simSlots[256] state | sim/effects/simTables.ts | sim_tables_reset, projectile_clear |
| `projectileSlotFill`, `xploSlotFill` state | sim/effects/simTables.ts | (BTHG / XPLO fill cursors) |
| `trackedObjects[128]`, `trackedObjectCount` state | sim/ai/tracked.ts | (NAVP / NAVO) |
| lighting/scene globals: `lighting` state with lumaTableId, lightDimDistance, groundColour, skyColour, horizonBandHeight, hrzmChunkValue, climChunkValue, missionMusicResource, missionMusicName, hiddenText, timeOfDay, dayOfYear, daysPerYear, dayLengthSeconds, ambientTemperature, ejectDisabled, damageShadeRaises, effectLightsAllowed, skyEnabled, groundEnabled, horizonBandEnabled, jetClimbLimit, mapHeightHigh, mapHeightLow, slopeThreshold, lightObjectFollow, lightObjectRecord, viewportModes[9] | sim/world/environment.ts | globals PLNT/CLIM/HTXT/LTBL/MUSI/INIT/LITE/GNDM/HRZM/SKYM/VWSP/LITO write |
| `dayCycleInit()`, `dayCycleTick()` | sim/world/dayCycle.ts | day_cycle_init / day_cycle_tick |
| `simPreloadData()` | engine/resources/preload.ts | sim_preload_data |
