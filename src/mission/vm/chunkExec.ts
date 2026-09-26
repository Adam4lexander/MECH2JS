/**
 * The project file's interpreter: project_chunk_exec walks a BWD stream chunk
 * by chunk and executes each by its four-character tag, recursing for
 * includes (INCL, GPS, PITF, VPTF). It is how a mission is built: world
 * settings (PLNT, LITE, PALG...), scenery (OBJ inside BLK), gamepieces (GP,
 * GPS and the chunks that follow them), navpoints, gamethings, tasks and the
 * mission tables.
 *
 * Structure notes carried from the decompilation:
 *  - REPR..ENDR group an object's detail levels (projectReprLevel counts them);
 *    they are not control flow.
 *  - BLK..ENDB are nested coordinate frames; ELSB is empty and unused.
 *  - GTBL, ORDR, GON, GOFF, PDSC, SDSC, SUPS are never handled by MW2.EXE
 *    (they occur only in the shell's briefing streams) - they fall to the
 *    unknown-chunk warning like any other unhandled tag.
 *  - REV and DTBL are skipped quietly; any other unknown tag is
 *    system_error(8), a warning, and the walk carries on.
 */
import type { MechEntity } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { imul64, regHi, regLo } from '../../core/int/i64.ts';
import { systemError } from '../../core/systemError.ts';
import { quirk } from '../../core/provenance.ts';
import { type Chunk, type ProjectItem, projectNextChunk } from '../../data/bwd/stream.ts';
import { widenObjectiveMask } from '../../data/bwd/payloads/objectiveMask.ts';
import { resolveCode } from '../../engine/codePtr.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { bootImage } from '../../engine/image.ts';
import { idByName } from '../../engine/resources/cache.ts';
import { sceneNodeGetWorldEuler, sceneNodeRemoveSubtreeFromWorld, sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk, sceneSubtreeMoveToAltList, sceneSubtreeSetObjectType } from '../../engine/scene/sceneGraph.ts';
import { polySetVertexOffset } from '../../engine/scene/wtboLoader.ts';
import { taskCreate, taskGlobals } from '../../engine/tasks/taskList.ts';
// registers anim_player_step (TSK type 3) so taskHandler resolves it
import '../../sim/mech/animTask.ts';
import { cameraGlobals } from '../../sim/camera/viewer.ts';
import { resLoadCockpit, resLoadHdi } from '../../sim/cockpit/resources.ts';
import { simTables } from '../../sim/effects/simTables.ts';
import { trackedGlobals } from '../../sim/ai/tracked.ts';
import { groupFormationsLoad, formationTableLoad, starTableLoad } from '../../sim/groups/formations.ts';
import { groupSetLeader, mechSetStarSlot } from '../../sim/groups/groups.ts';
import { pathTableLoad } from '../../sim/groups/paths.ts';
import { animEnsureLoaded } from '../../sim/mech/anim.ts';
import { gamepieceClasses } from '../../sim/mech/classes.ts';
import { mechLoadConfig, resLoadMgeo } from '../../sim/mech/config.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { mechSpawn, thingNodes } from '../../sim/mech/spawn.ts';
import { gamethingAlloc, things } from '../../sim/things/gameThings.ts';
import { anim2dAdd } from '../../sim/world/anim2d.ts';
import { bitmap3dAddFrame, bitmap3dSetEnable, bitmap3dSetId, bitmap3dSetSec } from '../../sim/world/bitmap3d.ts';
import { detailRecordNode, detailRecordSetLocation, detailRecordsClaim, mechCreatePartNodes } from '../../sim/world/detailRecords.ts';
import { lighting } from '../../sim/world/environment.ts';
import { framePrjAdd } from '../../sim/world/framePrj.ts';
import { paletteSlotSetResource } from '../../sim/world/palettes.ts';
import { planet } from '../../sim/world/planet.ts';
import { projectDetailFind, projectMangleId, projectMaps, projectObjectFind, projectSetMangle } from '../../sim/world/projectMaps.ts';
import { scroungeInstall } from '../../sim/world/scrounge.ts';
import {
  blockTransformPoint,
  blockXformSet,
  projectBlockBegin,
  projectBlockElse,
  projectBlockEnd,
  worldObjectGetPos,
  worldRecordAlloc,
  worldRecordFind,
  worldRecordLinkGamething,
  worldRecordTaskCreate,
  world,
} from '../../sim/world/worldRecords.ts';
import { missionMarkByName, missionMarksScanNop, missionRecordAddValue, missionTableLoad, missionTables } from '../tables/missionTables.ts';
import { scenarioTableLoad } from '../tables/scenario.ts';
import { projectObjExec } from './objExec.ts';
import { projectGpspecApply, projectItemApply, projectItemRelease, projectOpenStream } from './streams.ts';

export const vmGlobals = registerGlobals(
  'projectVm',
  {
    /** 0x96c68: inside a REPR..ENDR nest */
    projectReprActive: 0,
    /** 0x96c6c: which detail level the OBJs being read belong to */
    projectReprLevel: 0,
    /** 0x9eb90: MON steps its high half and hands it to project_set_mangle */
    projectMangleNext: 0,
  },
  () => {
    vmGlobals.projectReprActive = 0;
    vmGlobals.projectReprLevel = 0;
    vmGlobals.projectMangleNext = 0;
  },
);

/** The TSK handler for task type 0..5, from projectEntryHandlers (0x9eba0), resolved through the code registry. */
function taskHandler(type: number): ReturnType<typeof resolveCode> {
  const img = bootImage();
  return img ? resolveCode(img.u32(LABEL.projectEntryHandlers + type * 4)) : null;
}

/** (int)(((int64)a * b) >> 16) rounded by bit 15. */
function mulRound16(a: number, b: number): number {
  imul64(a, b);
  const lo = regLo();
  return (((lo >>> 16) | (regHi() << 16)) + ((lo >>> 15) & 1)) | 0;
}

/**
 * Executes every chunk of a stream. Returns 1, or 0 if an include or a
 * gamepiece failed (results are ANDed through the recursion).
 *
 * @mw2 project_chunk_exec 0x0004e5d0
 * @fidelity partial
 * @divergence of the TSK handlers only anim_player_step (type 3) is ported; the others (Phase 6) create tasks with no callback
 */
export function projectChunkExec(item: ProjectItem): number {
  let result = 1;
  let affiliation = -1; // local_4c, set by AFFL
  let markActive = missionMarkByName(item.name); // local_48
  let markName = item.name; // local_28
  let lastSpawned: MechEntity | null = null; // local_34
  const cg = () => mechs.currentGamepiece;
  const isPlayerPiece = () => cg() !== null && cg()!.controlSource === 0;

  for (;;) {
    const c = projectNextChunk(item);
    if (!c) break;
    const trackedIndex = trackedGlobals.trackedObjectCount;
    const xploIndex = simTables.xploSlotFill;
    switch (c.tag) {
      case 'PLNT': {
        planet.gravity = mulRound16(c.i32(8), 0x794);
        lighting.daysPerYear = c.i32(0x10);
        lighting.dayLengthSeconds = c.i32(0x14);
        lighting.ambientTemperature = c.i32(0x24);
        lighting.ejectDisabled = c.i32(0x38) === 0 ? 1 : 0;
        lighting.damageShadeRaises = c.i32(0x3c);
        lighting.effectLightsAllowed = c.i32(0x40) === 0 ? 1 : 0;
        lighting.skyEnabled = c.i32(0x44) === 0 ? 1 : 0;
        lighting.groundEnabled = c.i32(0x48) === 0 ? 1 : 0;
        lighting.horizonBandEnabled = c.i32(0x4c) === 0 ? 1 : 0;
        if (c.i32(0x28) > 0) lighting.jetClimbLimit = c.i32(0x28);
        if (c.i32(0x2c) !== 0 || c.i32(0x30) !== 0) {
          lighting.mapHeightHigh = c.i32(0x2c);
          lighting.mapHeightLow = c.i32(0x30);
        }
        if (c.i32(0x34) > 0) lighting.slopeThreshold = c.i32(0x34);
        break;
      }
      case 'CLIM':
        lighting.climChunkValue = c.i16(0xc);
        break;
      case 'HTXT':
        lighting.hiddenText = c.str(8);
        break;
      case 'VIEW':
        cameraGlobals.mainViewer.nearClip = c.i32(8);
        cameraGlobals.mainViewer.farClip = c.i32(0xc);
        break;
      case 'LTBL': {
        let id = c.i16(8);
        if (id === -1) id = idByName(0xd, c.str(10));
        if (id !== -1) lighting.lumaTableId = id;
        break;
      }
      case 'MUSI':
        lighting.missionMusicResource = c.i16(8);
        if (lighting.missionMusicResource === -1) lighting.missionMusicResource = idByName(0xc, c.str(10));
        lighting.missionMusicName = c.str(10);
        break;
      case 'ASND':
        if (isPlayerPiece()) {
          cg()!.animSoundId = c.i16(8);
          if (c.i16(8) === -1) cg()!.animSoundId = idByName(0xb, c.str(10));
        }
        break;
      case 'AFFL':
        affiliation = c.i32(8);
        break;
      case 'TERR':
        break;
      case 'INIT':
        lighting.timeOfDay = c.i32(0x10);
        lighting.dayOfYear = c.i16(0x14);
        break;
      case 'PALG':
        for (let g = 0; g < 4; g++) {
          paletteSlotSetResource(c.i16(8 + g * 8), g * 4);
          paletteSlotSetResource(c.i16(10 + g * 8), g * 4 + 1);
          paletteSlotSetResource(c.i16(12 + g * 8), g * 4 + 2);
          paletteSlotSetResource(c.i16(14 + g * 8), g * 4 + 3);
        }
        paletteSlotSetResource(c.i16(0x28), 0x10);
        paletteSlotSetResource(c.i16(0x2a), 0x11);
        paletteSlotSetResource(c.i16(0x2c), 0x12);
        paletteSlotSetResource(c.i16(0x2e), 0x13);
        break;
      case 'LITE': {
        const v = cameraGlobals.mainViewer;
        v.lightPos[0] = c.i32(0x10);
        v.lightPos[1] = c.i32(0x14);
        v.lightPos[2] = c.i32(0x18);
        v.lightDirectional = c.i16(0x1e);
        (cameraGlobals.viewerPosition ?? v).ambientLight = c.i16(0x1c);
        lighting.lightDimDistance = c.i32(0x20);
        if (lighting.lightDimDistance > 0) lighting.lightDimFlag = 1;
        break;
      }
      case 'GNDM':
        lighting.groundColour = c.i32(8);
        break;
      case 'HRZM':
        lighting.hrzmChunkValue = c.i32(8);
        lighting.horizonBandHeight = c.i32(0xc);
        break;
      case 'SKYM':
        lighting.skyColour = c.i32(8);
        break;
      case 'VWSP': {
        const n = ((c.size - 8) >>> 0) >>> 5;
        if (n < 9) {
          for (let k = 0; k < n; k++) {
            const e = 8 + k * 32;
            const idx = c.i32(e);
            if (idx < 9 && idx > -1) {
              const w = lighting.viewportModes[idx]!;
              w.left = c.i32(e + 4);
              w.top = c.i32(e + 8);
              w.right = (c.i32(e + 4) + c.i32(e + 12) - 1) | 0;
              w.bottom = (c.i32(e + 8) + c.i32(e + 16) - 1) | 0;
            } else systemError(0x27);
          }
        } else systemError(0x27);
        break;
      }
      case 'VWST': {
        const v = cameraGlobals.mainViewer;
        v.posX = c.i32(8);
        v.posY = c.i32(0xc);
        v.posZ = c.i32(0x10);
        v.yaw = c.i32(0x14);
        v.pitch = c.i32(0x18);
        v.roll = c.i32(0x1c);
        v.zoom = c.i32(0x20);
        break;
      }
      case 'STBL':
        scenarioTableLoad(c);
        break;
      case 'STAR':
        starTableLoad(c);
        break;
      case 'PTBL':
        pathTableLoad(c);
        break;
      case 'FTBL':
        formationTableLoad(c);
        break;
      case 'MTBL':
        missionTableLoad(c);
        markActive = missionMarkByName(missionTables.mtblMarkName);
        markName = missionTables.mtblMarkName;
        break;
      case 'BMPJ': {
        let id = c.i16(8);
        if (id === -1) id = idByName(8, c.str(10));
        if (id === -1) systemError(0x28);
        else bitmap3dAddFrame(id, -1);
        break;
      }
      case 'BMID':
        bitmap3dSetId(c.i16(8), -1);
        break;
      case 'BSEC':
        bitmap3dSetSec(c.i16(8), c.i16(10));
        bitmap3dSetEnable(c.i16(8), 1);
        break;
      case 'BMEN':
        bitmap3dSetEnable(c.i16(8), c.i16(10));
        break;
      case 'FPRJ': {
        let a = c.i16(8);
        let b = c.i16(10);
        if (a === -1) a = 1;
        if (b === -1) b = 0;
        if (c.u16(0xc) !== 0xffff) framePrjAdd(c.u16(0xc), a, b);
        break;
      }
      case 'PLGO':
        polySetVertexOffset(c.i32(8), c.i32(0xc), c.i32(0x10));
        break;
      case 'BLKX':
        blockXformSet(Array.from({ length: 9 }, (_, k) => c.i32(8 + k * 4)));
        break;
      case 'REPR':
        if (vmGlobals.projectReprActive === 0) {
          vmGlobals.projectReprLevel = 0;
          projectMaps.detailMapCount = 0;
          vmGlobals.projectReprActive = 1;
          projectMaps.detailMapValues = [];
        } else vmGlobals.projectReprLevel++;
        break;
      case 'ENDR':
        vmGlobals.projectReprActive = 0;
        break;
      case 'BLK':
        projectBlockBegin(Array.from({ length: 6 }, (_, k) => c.i32(8 + k * 4)));
        break;
      case 'ELSB':
        projectBlockElse();
        break;
      case 'ENDB':
        projectBlockEnd();
        break;
      case 'OBJ':
        projectObjExec(c, world.projectBlockDepth, vmGlobals.projectReprActive, vmGlobals.projectReprLevel);
        break;
      case 'ANIM':
        if (animEnsureLoaded(c.ref(8)) === 0) systemError(0x4f);
        break;
      case 'SCRG': {
        const obj = projectObjectFind(projectMangleId(c.i16(8)));
        if (!obj || !obj.node) systemError(0x2e);
        else scroungeInstall(obj.node);
        break;
      }
      case 'THNG': {
        const id = projectMangleId(c.i16(8));
        const t = thingNodes;
        if (t.thingNodeCount < 0x96) {
          const rec = projectDetailFind(id);
          if (rec === -1) systemError(0x2f);
          else t.thingNodeQueue[t.thingNodeCount++] = rec;
        }
        break;
      }
      case 'GP': {
        const classId = c.i16(10);
        if (mechs.mechCount > 0x3b) return finish();
        const id = projectMangleId(c.i16(8));
        if (classId < 0 || classId > 8) {
          systemError(0x30);
          break;
        }
        const obj = projectObjectFind(id);
        if (!obj) {
          mechs.currentGamepiece = null;
          if (lastSpawned) {
            quirk('GP with no object: the original clears the PREVIOUS gamepiece node', 'project_chunk_exec');
            lastSpawned.node = null;
          }
          break;
        }
        const node = obj.node;
        if (!node) break;
        const classes = gamepieceClasses();
        let k = classes.findIndex((g) => g.classId === classId);
        if (k === -1) {
          systemError(0x30);
          k = 0;
        }
        const cls = classes[k]!;
        mechSpawn(mechs.mechCount, cls.createLoadout);
        const e = mechs.mechTable[mechs.mechCount];
        lastSpawned = e ?? null;
        if (!e) systemError(0xd);
        else if (!e.loadout) systemError(0xe);
        if (!e) break;
        e.gamepieceClass = cls.classId;
        e.hooks[0] = cls.hooks[0] ?? null;
        e.hooks[1] = cls.hooks[1] ?? null;
        e.hooks[2] = cls.hooks[2] ?? null;
        e.hooks[5] = cls.hooks[5] ?? null;
        e.spawnDetailLevel = vmGlobals.projectReprLevel;
        e.detailLevel = -1;
        if (mechs.mechCount === mechs.playerMechIndex) {
          e.controlSource = 0;
          e.hooks[3] = cls.hooks[3] ?? null;
          e.hooks[4] = cls.hooks[4] ?? null;
        } else {
          e.controlSource = (mechs.netGameEnabled === 0 ? 1 : 0) + 1;
          e.hooks[3] = null;
          e.hooks[4] = null;
        }
        e.index = mechs.mechCount;
        mechs.currentGamepiece = e;
        e.node = node;
        mechs.mechCount++;
        e.aimNode = node;
        detailRecordsClaim(e);
        mechCreatePartNodes(e);
        break;
      }
      case 'CPTF':
        if (isPlayerPiece()) resLoadCockpit(c.ref(8));
        break;
      case 'PITF':
      case 'VPTF':
        if (isPlayerPiece()) {
          const sub = projectOpenStream(c.ref(8));
          if (!sub) systemError(c.tag === 'PITF' ? 0x31 : 0x32);
          else {
            result = result & projectChunkExec(sub);
            projectItemRelease(sub);
          }
        }
        break;
      case 'HUDF':
        if (isPlayerPiece()) resLoadHdi(c.ref(8));
        break;
      case 'MGDF':
        if (cg() && cg()!.loadout) resLoadMgeo(c.ref(8), cg()!.loadout!);
        break;
      case 'EYEO':
        if (cg()) {
          const rec = projectDetailFind(projectMangleId(c.i16(8)));
          const n = rec > -1 ? detailRecordNode(rec) : null;
          if (n) cg()!.aimNode = n;
        }
        break;
      case 'POFO':
        if (cg()) {
          const lo = cg()!.loadout;
          const rec = projectDetailFind(projectMangleId(c.i16(8)));
          const n = rec > -1 ? detailRecordNode(rec) : null;
          if (n && lo) lo.sectionNodes[c.i16(10)] = n;
        }
        break;
      case 'GT': {
        const hp = c.i16(0x18);
        const mask = widenObjectiveMask(c.u16(0x1a));
        const idx = gamethingAlloc();
        if (idx === -1) break;
        const g = things.gameThings[idx]!;
        g.flags = c.u16(0x1c);
        g.hitPoints = hp;
        g.affiliation = affiliation;
        g.name = c.str(0x20, 0x15);
        g.nameAlt = c.str(0x36, 0x15);
        const replId = c.i16(10);
        let rec = -1;
        if (c.i16(8) !== -1) {
          const m = projectMangleId(c.i16(8));
          rec = worldRecordFind(m);
          if (rec === -1) rec = worldRecordAlloc(m);
          let repl = -1;
          if (replId !== -1) {
            const m2 = projectMangleId(replId);
            repl = worldRecordFind(m2);
            if (repl === -1) repl = worldRecordAlloc(m2);
          }
          if (rec !== -1) worldRecordLinkGamething(rec, repl, idx);
        }
        g.geomIndex = rec;
        if (markActive) missionRecordAddValue(markName, mask, (idx & 0xff) | 0x400);
        break;
      }
      case 'OBJL': {
        const loc = c.u16(10);
        const id = projectMangleId(c.i16(8));
        if (loc !== 0xffff) {
          const rec = projectDetailFind(id);
          if (rec !== -1) detailRecordSetLocation(rec, loc);
        }
        break;
      }
      case 'BTHG': {
        const pid = c.i16(10);
        const s = simTables;
        if (s.projectileSlotFill < 0xaf && s.projectileSlotFill > -1) {
          const id = projectMangleId(c.i16(8));
          const p = s.projectiles[s.projectileSlotFill]!;
          if (!p.node) {
            const obj = projectObjectFind(id);
            const node = obj?.node ?? null;
            if (node) {
              p.id = pid;
              p.node = node;
              p.motionHeld = 0;
              sceneSubtreeMoveToAltList(node);
              sceneNodeRemoveSubtreeFromWorld(node);
              sceneSubtreeSetObjectType(node, 0x400);
            }
          }
          s.projectileSlotFill++;
        }
        break;
      }
      case 'XPLO': {
        const bitmapSlot = c.i16(10);
        let type = c.i16(0xc);
        const s = simTables;
        if (s.xploSlotFill > -1 && s.xploSlotFill < 0x100) {
          if (type < 0 || type > 0x1f) type = 3;
          const slot = s.simSlots[s.xploSlotFill]!;
          if (!slot.node) {
            if (c.i16(8) !== -1) {
              const obj = projectObjectFind(projectMangleId(c.i16(8)));
              const node = obj?.node ?? null;
              if (obj && node) {
                slot.node = node;
                sceneSubtreeMoveToAltList(node);
                sceneNodeRemoveSubtreeFromWorld(node);
                if ((obj.type & 0xf0) === 0) sceneSubtreeSetObjectType(node, 0x20);
                s.simSlots[xploIndex]!.bitmapSlot = bitmapSlot;
                if (bitmapSlot > 0) bitmap3dSetEnable(bitmapSlot, 2);
              }
            }
            s.simSlots[xploIndex]!.active = 0;
            s.simSlots[xploIndex]!.typeIndex = type;
          }
          s.xploSlotFill++;
        }
        break;
      }
      case 'NAVP': {
        const tg = trackedGlobals;
        if (tg.trackedObjectCount < 0x80 && tg.trackedObjectCount !== -1) {
          const p = [c.i32(8), c.i32(0xc), c.i32(0x10)];
          blockTransformPoint(p);
          const t = tg.trackedObjects[trackedIndex]!;
          t.x = p[0]!;
          t.y = p[1]!;
          t.z = p[2]!;
          t.inUse = c.i16(0x18);
          t.flags = c.u16(0x1a);
          t.groupId = c.i16(0x1e);
          t.targetHandle = c.i16(0x1c);
          t.heading = c.i32(0x14);
          t.range = Math.imul(c.u16(0x20), 100);
          t.followNode = null;
          t.name = c.str(0x24, 0x15);
          const mask = widenObjectiveMask(c.u16(0x22));
          const idx = tg.trackedObjectCount++;
          if (markActive) missionRecordAddValue(markName, mask, (idx & 0xff) | 0x100);
        }
        break;
      }
      case 'NAVO': {
        const tg = trackedGlobals;
        if (tg.trackedObjectCount < 0x80 && tg.trackedObjectCount !== -1) {
          const m = projectMangleId(c.i16(10));
          const rec = worldRecordFind(m);
          let ok = false;
          const t = tg.trackedObjects[tg.trackedObjectCount]!;
          if (rec === -1) {
            const obj = projectObjectFind(m);
            if (obj && obj.node) {
              const e = sceneNodeGetWorldEuler(obj.node);
              t.followNode = obj.node;
              ok = true;
              t.heading = e.yaw;
            }
          } else {
            const [x, y, z] = worldObjectGetPos(rec);
            t.x = x;
            t.y = y;
            ok = true;
            t.z = z;
          }
          if (ok) {
            t.range = c.i16(0xc);
            t.inUse = 1;
            t.flags = 0;
            t.targetHandle = 0;
            const mask = widenObjectiveMask(c.u16(0xe));
            const idx = tg.trackedObjectCount++;
            if (markActive) missionRecordAddValue(markName, mask, (idx & 0xff) | 0x100);
          }
        }
        break;
      }
      case 'LITO':
        if (c.i16(8) !== -1) {
          const rec = worldRecordFind(projectMangleId(c.i16(8)));
          if (rec !== -1) {
            lighting.lightObjectFlag = 1;
            lighting.lightObjectFollow = 1;
            lighting.lightObjectRecord = rec;
          }
        }
        break;
      case 'TSK': {
        const type = c.i16(8);
        const period = c.i32(10);
        const arg = c.str(0xe);
        let target = -1;
        const semi = arg.indexOf(';');
        if (semi >= 0) target = projectMangleId(atoi(arg.slice(0, semi)));
        if (type < 0 || type > 5) systemError(0x33);
        else {
          const rec = worldRecordFind(target);
          const handler = taskHandler(type);
          if (rec === -1) taskCreate(taskGlobals.missionTaskList, handler, period, arg);
          else worldRecordTaskCreate(rec, handler, period, arg);
        }
        break;
      }
      case 'POS': {
        const obj = projectObjectFind(projectMangleId(c.i16(8)));
        if (obj && obj.node) {
          sceneNodeSetOrigin(obj.node, c.i32(10), c.i32(0xe), c.i32(0x12));
          sceneNodeWalk(obj.node);
        }
        break;
      }
      case 'ROT': {
        const obj = projectObjectFind(projectMangleId(c.i16(8)));
        if (obj && obj.node) {
          // whole degrees -> 16.16: trunc(v * 65536.0 + 0.5) (constants 0x93956, 0x9395e)
          const deg = (o: number) => Math.trunc(c.i32(o) * 65536.0 + 0.5) | 0;
          sceneNodeSetEuler(obj.node, deg(0xa), deg(0xe), deg(0x12), 0);
          sceneNodeWalk(obj.node);
        }
        break;
      }
      case 'INCL':
        result = result & projectItemApply(c, projectChunkExec);
        break;
      case 'GRP':
        groupFormationsLoad(c);
        break;
      case 'GPS':
        result = execGps(c, result, markActive, markName);
        break;
      case 'MOFF':
        projectSetMangle(0);
        break;
      case 'MON':
        vmGlobals.projectMangleNext = (vmGlobals.projectMangleNext + 0x10000) | 0;
        projectSetMangle(vmGlobals.projectMangleNext);
        break;
      case 'ANM2':
        anim2dAdd(c);
        break;
      case 'REV':
      case 'DTBL':
        break;
      default:
        systemError(8, `unknown chunk '${c.tag}' in ${item.name}`);
    }
  }
  return finish();

  function finish(): number {
    if (markActive) missionMarksScanNop();
    return result;
  }
}

/** The GPS branch of project_chunk_exec: run the piece's stream, then place it in its group. */
function execGps(c: Chunk, result: number, markActive: number, markName: string): number {
  const mekId = c.i16(8);
  const chassis = c.str(0x24, 8);
  const config = c.str(0x2d, 8);
  let group = c.u8(0xc);
  if (group > 0xf) group = 0;
  const leader = c.i8(0xd);
  let side = c.u8(0xe);
  const mask = widenObjectiveMask(c.u16(0x20));
  if (projectGpspecApply(c, projectChunkExec) === 0) return 0;
  const e = mechs.currentGamepiece;
  if (!e) {
    systemError(0x43);
    return result;
  }
  const idx = e.index;
  if (mechs.netGameEnabled !== 0) side = idx !== mechs.playerMechIndex ? 1 : 0;
  const gt = mechs.groupTable[group]!;
  if (side === 0) {
    mechs.playerGroupIndex = group;
    gt.allegiance = 0;
    mechs.playerMechIndex = idx;
    mechs.affiliationAllegiance[gt.affiliation & 7] = 0;
  } else if (side === 1) {
    gt.allegiance = 1;
    mechs.affiliationAllegiance[gt.affiliation & 7] = 1;
  }
  for (let k = 0; k < 8; k++) e.gpsParams[k] = c.u16(0x10 + k * 2);
  e.flags = c.u16(0x22);
  e.name = c.str(0x36, 0x15);
  e.nameAlt = c.str(0x4c, 0x15);
  if (markActive) missionRecordAddValue(markName, mask, (idx & 0xff) | 0x200);
  e.groupId = group;
  mechSetStarSlot(idx, gt.memberCount);
  if (leader === 1) groupSetLeader(group, idx);
  gt.members[gt.memberCount] = idx;
  gt.memberCount++;
  if (e.loadout && !mechLoadConfig(e.loadout, chassis, mekId, config)) {
    systemError(0x43);
    return 0;
  }
  return result;
}

/** Watcom atoi: optional blanks and sign, then digits. */
function atoi(s: string): number {
  const m = /^\s*[+-]?\d+/.exec(s);
  return m ? parseInt(m[0], 10) | 0 : 0;
}
