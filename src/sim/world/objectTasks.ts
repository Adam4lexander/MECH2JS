/**
 * The scheduled tasks mission scripts attach to objects (TSK chunks, types
 * 0..5 through projectEntryHandlers at 0x9eba0): 0 rotate, 1 colour cycle,
 * 2 drive, 3 anim (anim_player_step, sim/mech/animTask.ts), 4 sound, 5
 * track. Each argument is '<object id>;<parameters>'; the id goes through
 * project_mangle_id and world_record_find, and a miss refuses the task
 * (INIT returns 0). The task holds the record's object SLOT, so a rebuilt
 * record's new object is picked up on the next tick. listing/tasks.txt
 * decodes every TSK chunk in MW2.PRJ.
 *
 * The protocol (engine/tasks/taskList.ts): callback(message, arg, simTick,
 * period) - 0 INIT, 1 TICK (0 removes the task), 2 DESTROY, -1 REBUILT.
 */
import { newRamp, newRampAngle, rampAngleStart, rampAngleStep, rampStart, rampStep } from '../../core/ramp.ts';
import { fixedAsin, fixedAtan2, fixedCos, fixedSin } from '../../core/angle/trig.ts';
import { cdiv, cmod, i16 } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { sdivShl } from '../../core/int/i64.ts';
import { quirk, unestablished } from '../../core/provenance.ts';
import type { ProjectPath, Ramp, RampAngle, SceneNode, WorldObject } from '../../generated/classes.gen.ts';
import { registerCode } from '../../engine/codePtr.ts';
import { idByName } from '../../engine/resources/cache.ts';
import { sceneNodeRotateEuler, sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeTranslate, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { objectGetNode } from '../../engine/scene/worldObject.ts';
import { taskCurrent, taskData, type TaskNode } from '../../engine/tasks/taskList.ts';
import { clibAtoi } from '../../mission/vm/projectWalk.ts';
import { paths } from '../groups/paths.ts';
import { soundEmitterStop, soundEmitterUpdate, type SoundEmitter } from '../sound/sound.ts';
import { projectMangleId } from './projectMaps.ts';
import { worldRecordFind, worldRecordObjectSlot } from './worldRecords.ts';

type Slot = { get(): WorldObject | null };

/** The '<id>' before the ';', resolved to its record's object slot; null when no record has it. @portOnly */
function resolveSlot(arg: string): Slot | null {
  const rec = worldRecordFind(projectMangleId(clibAtoi(arg)));
  return rec === -1 ? null : worldRecordObjectSlot(rec);
}

/** The parameters after the first ';', or null (the C writes a NUL over the ';'). @portOnly */
function tail(arg: string): string | null {
  const i = arg.indexOf(';');
  return i < 0 ? null : arg.slice(i + 1);
}

/** sscanf's %f: a leading float, as a 32-bit float; null when none matches. @portOnly clib */
function scanFloat(s: string): number | null {
  const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s);
  return m ? Math.fround(parseFloat(m[0])) : null;
}

/** sscanf's %d: a leading decimal int; null when none matches. @portOnly clib */
function scanInt(s: string): number | null {
  const m = /^\s*[+-]?\d+/.exec(s);
  return m ? parseInt(m[0], 10) | 0 : null;
}

/** Splits for sscanf formats of comma-separated fields: the fields up to the first that fails. @portOnly clib */
function scanFields(s: string, kinds: ('f' | 'd' | 's')[]): (number | string)[] {
  const out: (number | string)[] = [];
  let rest = s;
  for (let k = 0; k < kinds.length; k++) {
    if (k > 0) {
      if (rest[0] !== ',') break;
      rest = rest.slice(1);
    }
    const kind = kinds[k]!;
    if (kind === 's') {
      // %[^,]: one or more characters up to a comma
      const m = /^[^,]+/.exec(rest);
      if (!m) break;
      out.push(m[0]);
      rest = rest.slice(m[0].length);
    } else {
      const re = kind === 'f' ? /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/ : /^\s*[+-]?\d+/;
      const m = re.exec(rest);
      if (!m) break;
      out.push(kind === 'f' ? scanFloat(m[0])! : scanInt(m[0])!);
      rest = rest.slice(m[0].length);
    }
  }
  return out;
}

/** clib_fp_trunc then fistp of a double. @portOnly */
const trunc = (v: number): number => {
  const t = Math.trunc(v);
  return !Number.isFinite(t) || t > 0x7fffffff || t < -0x80000000 ? -0x80000000 : t | 0;
};

/** The running task's data record. @portOnly */
function data<T>(): T | null {
  const t = taskCurrent();
  return t ? (taskData(t).value as T | null) : null;
}

// --- 1: colour cycle ----------------------------------------------------------

interface ColourCycle {
  slot: Slot | null;
  object: WorldObject | null;
  /** -1 until the polygon count is read */
  polyCount: number;
  values: number[];
}

/**
 * Blinking and chasing lights: every period, polygon i of the object's
 * current mesh gets code values[((t / period) mod n + i) mod n] - the
 * script's palette indices shifted into a mode-0 code (<< 4). Period 0 is
 * read as 1. Removed when the object or its mesh is gone.
 *
 * @mw2 task_object_colour_cycle 0x0001b270
 * @fidelity exact
 */
export const taskObjectColourCycle = registerCode('task_object_colour_cycle', 0x1b270, (message: number, arg: unknown, now: number, period: number): number => {
  if (period === 0) period = 1;
  if (message === 0) {
    const text = typeof arg === 'string' ? arg : '';
    const s: ColourCycle = { slot: null, object: null, polyCount: -1, values: [] };
    taskData(taskCurrent()!).value = s;
    const t = tail(text);
    if (t !== null) {
      // strtok on ',' (0x902d0), atoi each token, up to 16
      for (const tok of t.split(',').filter((x) => x.length > 0)) {
        if (s.values.length >= 0x10) break;
        s.values.push(clibAtoi(tok) << 4);
      }
    }
    const slot = resolveSlot(text);
    if (!slot) return 0;
    s.slot = slot;
    return 1;
  }
  if (message !== 1) return 1;
  const s = data<ColourCycle>();
  if (!s || !s.slot) return 0;
  const obj = s.slot.get();
  if (!obj) return 0;
  s.object = obj;
  if (s.polyCount === -1) {
    const counts = objectMeshCounts(obj);
    if (counts) s.polyCount = counts[1];
  }
  const n = s.values.length;
  if (s.polyCount < 1) return 1;
  if (n === 0) {
    unestablished('task_object_colour_cycle: no values - the C divides by the count (0) and faults', 'task_object_colour_cycle');
    return 1;
  }
  const step = cmod(cdiv(now, period), n);
  for (let i = 0; i < s.polyCount; i++) polySetCode(obj, i, s.values[cmod(step + i, n)]!);
  return 1;
});

/**
 * The vertex and polygon counts of the object's current mesh, or null
 * without one.
 *
 * @mw2 object_mesh_counts 0x00038800
 * @fidelity exact
 */
export function objectMeshCounts(obj: WorldObject): [number, number] | null {
  const m = obj.currentMesh;
  return m ? [i16(m.vertexCount), i16(m.polygonCount)] : null;
}

/**
 * Writes polygon n's code in the object's current mesh, when there is one
 * and n is below its polygon count.
 *
 * @mw2 poly_set_code 0x00038950
 * @fidelity exact
 */
export function polySetCode(obj: WorldObject, n: number, code: number): void {
  const m = obj.currentMesh;
  if (m && n < i16(m.polygonCount)) m.polygons[n]!.code = code & 0xffff;
}

// --- 0: rotate -------------------------------------------------------------------

interface Rotate {
  slot: Slot | null;
  node: SceneNode | null;
  pitch: number;
  yaw: number;
  roll: number;
  period: number;
  last: number;
}

/**
 * Spins an object: '<id>;pitch,yaw,roll,seconds' - the three angles turned
 * per period (whole degrees to 16.16, rounded), the period in seconds to
 * ticks (0 read as one second). Each tick composes the elapsed fraction of
 * the angles onto the node (scene_node_rotate_euler).
 *
 * @mw2 task_object_rotate 0x0001b400
 * @fidelity exact
 */
export const taskObjectRotate = registerCode('task_object_rotate', 0x1b400, (message: number, arg: unknown, now: number): number => {
  if (message === 0) {
    const text = typeof arg === 'string' ? arg : '';
    const s: Rotate = { slot: null, node: null, pitch: 0, yaw: 0, roll: 0, period: 0, last: 0 };
    taskData(taskCurrent()!).value = s;
    const t = tail(text);
    if (t !== null) {
      const f = scanFields(t, ['f', 'f', 'f', 'f']);
      if (f.length < 4) unestablished('task_object_rotate: fewer than four values - the rest are uninitialised stack in the C (0 here)', 'task_object_rotate');
      const v = (k: number) => (typeof f[k] === 'number' ? (f[k] as number) : 0);
      s.pitch = trunc(v(0) * 65536.0 + 0.5);
      s.yaw = trunc(v(1) * 65536.0 + 0.5);
      s.roll = trunc(v(2) * 65536.0 + 0.5);
      s.period = trunc(v(3) * 182.0);
      if (s.period === 0) s.period = 0xb6;
      s.last = now;
    } else unestablished('task_object_rotate: no parameters - the angles and period stay as malloc left them (0 here)', 'task_object_rotate');
    const slot = resolveSlot(text);
    if (!slot) return 0;
    s.slot = slot;
    return 1;
  }
  if (message !== 1) return 1;
  const s = data<Rotate>();
  if (!s || !s.slot) return 0;
  const obj = s.slot.get();
  if (!obj) return 0;
  s.node = objectGetNode(obj);
  if (s.period === 0) {
    unestablished('task_object_rotate: a period of 0 faults the divide in the C', 'task_object_rotate');
    return 1;
  }
  const f = ((Math.imul((now - s.last) | 0, 0x10000) / s.period) | 0);
  s.last = now;
  if (!s.node) {
    unestablished('task_object_rotate: the object has no node, and the C rotates through a null pointer', 'task_object_rotate');
    return 1;
  }
  sceneNodeRotateEuler(s.node, mulr16(s.pitch, f), mulr16(s.yaw, f), mulr16(s.roll, f), 0);
  sceneNodeWalk(s.node);
  return 1;
});

// --- 2: drive ------------------------------------------------------------------

interface Drive {
  slot: Slot | null;
  node: SceneNode | null;
  heading: number;
  turn: number;
  speed: number;
  gate: number;
  last: number;
}

/**
 * Drives an object round a circle: '<id>;radius,lap seconds,gate,unused' -
 * the turn a full circle per lap (360 / lap, 16.16) and the speed a
 * circumference per lap (radius * 2 pi / lap); each tick it moves along its
 * heading in the ground plane and yaws by the elapsed fraction. A gate of 0
 * removes the task.
 *
 * @mw2 task_object_drive 0x0001b5e0
 * @fidelity exact
 * @divergence INIT's two products are evaluated in doubles, not the x87's 80 bits (0x1b66e..0x1b6ae); every shipped lap is a small integer, which leaves them far from a rounding boundary
 */
export const taskObjectDrive = registerCode('task_object_drive', 0x1b5e0, (message: number, arg: unknown, now: number): number => {
  if (message === 0) {
    const text = typeof arg === 'string' ? arg : '';
    const s: Drive = { slot: null, node: null, heading: 0, turn: 0, speed: 0, gate: 0, last: 0 };
    taskData(taskCurrent()!).value = s;
    const t = tail(text);
    if (t !== null) {
      const f = scanFields(t, ['f', 'f', 'd', 'd']);
      if (f.length < 3) unestablished('task_object_drive: fewer than three values - the rest are uninitialised stack in the C (0 here)', 'task_object_drive');
      const radius = typeof f[0] === 'number' ? (f[0] as number) : 0;
      const lap = typeof f[1] === 'number' ? (f[1] as number) : 0;
      s.turn = trunc((360.0 / lap) * 65536.0 + 0.5);
      s.speed = trunc(((radius * Math.PI * 2.0) / lap) * 65536.0 + 0.5);
      s.heading = 0;
      s.gate = typeof f[2] === 'number' ? (f[2] as number) : 0;
    }
    s.last = now;
    const slot = resolveSlot(text);
    if (!slot) return 0;
    s.slot = slot;
    return 1;
  }
  if (message !== 1) return 1;
  const s = data<Drive>();
  if (!s || !s.slot || s.gate === 0) return 0;
  const obj = s.slot.get();
  if (!obj) return 0;
  s.node = objectGetNode(obj);
  if (!s.node) {
    unestablished('task_object_drive: the object has no node, and the C moves through a null pointer', 'task_object_drive');
    return 1;
  }
  const c = fixedCos(s.heading);
  const sn = fixedSin(s.heading);
  const f = sdivShl((now - s.last) | 0, 16, 0xb6);
  s.last = now;
  const d = mulr16(s.speed, f) >> 16;
  sceneNodeTranslate(s.node, mulr16(c, d) >> 13, 0, mulr16(-sn | 0, d) >> 13);
  sceneNodeWalk(s.node);
  const turn = mulr16(s.turn, f);
  sceneNodeRotateEuler(s.node, 0, turn, 0, 0);
  sceneNodeWalk(s.node);
  s.heading = cmod((s.heading + turn) | 0, 0x1680000);
  return 1;
});

// --- 4: sound ------------------------------------------------------------------

/**
 * A looped sound on an object: '<id>;cutoff metres,SNDS name,gate' - handed
 * to sound_emitter_update each tick while the object lives and the gate is
 * non-zero; stopped (and the task removed) otherwise, and on DESTROY.
 *
 * @mw2 task_object_sound 0x0001b810
 * @fidelity exact
 */
export const taskObjectSound = registerCode('task_object_sound', 0x1b810, (message: number, arg: unknown): number => {
  if (message === 0) {
    const text = typeof arg === 'string' ? arg : '';
    const e: SoundEmitter = { cutoff: 0, channel: -1, resource: null, slot: null, node: null, gate: 0, skipFirst: 1, soundId: 0 };
    taskData(taskCurrent()!).value = e;
    let name = '';
    const t = tail(text);
    if (t !== null) {
      const f = scanFields(t, ['d', 's', 'd']);
      e.cutoff = Math.imul(typeof f[0] === 'number' ? (f[0] as number) : 0, 100);
      name = typeof f[1] === 'string' ? (f[1] as string) : '';
      if (typeof f[2] === 'number') e.gate = f[2] as number;
      else {
        quirk('task_object_sound: INIT never sets the gate, so a chunk without it leaves the heap\'s value; the port takes 1 (play)', 'task_object_sound');
        e.gate = 1;
      }
    }
    e.soundId = i16(idByName(0xb, name));
    const slot = resolveSlot(text);
    if (!slot) return 0;
    e.slot = slot;
    return 1;
  }
  if (message === 1) {
    const e = data<SoundEmitter>();
    if (!e) return 0;
    if (e.slot && e.gate !== 0) {
      const obj = e.slot.get();
      if (!obj) {
        soundEmitterStop(e);
        return 0;
      }
      e.node = objectGetNode(obj);
      soundEmitterUpdate(e);
      return 1;
    }
    soundEmitterStop(e);
    return 0;
  }
  if (message === 2) {
    const e = data<SoundEmitter>();
    if (e) soundEmitterStop(e);
  }
  return 1;
});

// --- 5: track -------------------------------------------------------------------

/** PathTask (mw2_types.h) with the object slot the port holds. @portOnly */
interface Track {
  objectSlot: Slot | null;
  node: SceneNode | null;
  path: ProjectPath | null;
  startTick: number;
  totalDuration: number;
  rotate: number;
  /** 0 loop, 1 repeat, 2 anything else ('oneshot') */
  mode: number;
  rampX: Ramp;
  rampY: Ramp;
  rampZ: Ramp;
  anglePitch: RampAngle;
  angleYaw: RampAngle;
  angleRoll: RampAngle;
}

/** The smoothers put on point 0, angles 0, 0.3 s. @portOnly the start INIT, repeat and -1 share */
function trackRestart(s: Track, path: ProjectPath, now: number): void {
  const p0 = path.points[0]!;
  rampStart(s.rampX, p0.x, p0.x, 0.3, now);
  rampStart(s.rampY, p0.y, p0.y, 0.3, now);
  rampStart(s.rampZ, p0.z, p0.z, 0.3, now);
  rampAngleStart(s.anglePitch, 0, 0, 0.3, 0x1680000, now);
  rampAngleStart(s.angleYaw, 0, 0, 0.3, 0x1680000, now);
  rampAngleStart(s.angleRoll, 0, 0, 0.3, 0x1680000, now);
}

/** Sets a RampAngle's target, moving current by whole turns until target - current is within half a turn. @portOnly */
function unwrapTo(r: RampAngle, angle: number): void {
  let d = (angle - r.current) | 0;
  while (0xb40000 < d) d = (d - 0x1680000) | 0;
  while (d < -0xb40000) d = (d + 0x1680000) | 0;
  r.target = angle;
  r.current = (angle - d) | 0;
}

/** stricmp against a C string. @portOnly clib */
const ieq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * An object on a keyframed path: '<id>;mode,rotate,path' - mode 'loop' (0),
 * 'repeat' (1) or anything else (2, 'oneshot'); 'rotate' takes heading and
 * pitch from each segment's direction; the path by name among projectPaths.
 * Each tick finds the segment by the elapsed time, interpolates toward the
 * next point (from the last, point 0) and eases the object after it through
 * three Ramps and three RampAngles (0.3 s); at the last point oneshot ends,
 * repeat starts over, loop runs the closing segment and wraps. -1 (the
 * record rebuilt) restarts the smoothers and re-finds the object.
 *
 * @mw2 task_object_track 0x0001b970
 * @fidelity partial
 * @divergence the -1 arm: task_list_notify_rebuilt neither sets currentTask nor passes an argument (0x17450..0x17477), so the C works on whatever task last ran (usually none: address 4) and atoi's a null pointer; the port answers 0 with the task untouched when there is no current task, and otherwise keeps the object slot rather than atoi'ing nothing
 */
export const taskObjectTrack = registerCode('task_object_track', 0x1b970, (message: number, arg: unknown, now: number): number => {
  if (message === -1) {
    const cur = taskCurrent();
    if (!cur) {
      unestablished('task_object_track: REBUILT with no current task - the C reads the data word at address 4', 'task_object_track');
      return 0;
    }
    const s = taskData(cur).value as Track | null;
    if (!s) return 0;
    s.startTick = now;
    if (!s.path) return 1;
    trackRestart(s, s.path, now);
    let total = 0;
    for (let k = 0; k < s.path.pointCount; k++) total = (total + s.path.points[k]!.duration) | 0;
    s.totalDuration = total;
    unestablished('task_object_track: REBUILT looks its object up by atoi(NULL); the port keeps the slot it has', 'task_object_track');
    return 1;
  }
  if (message === 0) {
    const text = typeof arg === 'string' ? arg : '';
    const s: Track = {
      objectSlot: null,
      node: null,
      path: null,
      startTick: now,
      totalDuration: 0,
      rotate: 0,
      mode: 0,
      rampX: newRamp(),
      rampY: newRamp(),
      rampZ: newRamp(),
      anglePitch: newRampAngle(),
      angleYaw: newRampAngle(),
      angleRoll: newRampAngle(),
    };
    taskData(taskCurrent()!).value = s;
    const t = tail(text);
    if (t !== null) {
      const w = scanFields(t, ['s', 's', 's']) as string[];
      if (w.length < 3) unestablished('task_object_track: fewer than three words - the rest are uninitialised stack buffers in the C (empty here)', 'task_object_track');
      const w1 = w[0] ?? '';
      const w2 = w[1] ?? '';
      const w3 = w[2] ?? '';
      s.mode = ieq(w1, 'loop') ? 0 : ieq(w1, 'repeat') ? 1 : 2;
      s.rotate = ieq(w2, 'rotate') ? 1 : 0;
      for (let k = 0; k < paths.projectPathCount; k++) {
        if (ieq(w3, paths.projectPaths[k]!.name)) {
          s.path = paths.projectPaths[k]!;
          break;
        }
      }
    }
    if (!s.path) return 1;
    trackRestart(s, s.path, now);
    let total = 0;
    for (let k = 0; k < s.path.pointCount; k++) total = (total + s.path.points[k]!.duration) | 0;
    s.totalDuration = total;
    const slot = resolveSlot(text);
    if (!slot) return 0;
    s.objectSlot = slot;
    return 1;
  }
  if (message !== 1) return 1;
  const s = data<Track>();
  if (!s || !s.objectSlot || !s.path) return 0;
  const obj = s.objectSlot.get();
  if (!obj) return 0;
  const node = objectGetNode(obj);
  s.node = node;
  if (!node) return 0;
  const path = s.path;
  const count = path.pointCount;
  if (count < 2) return 0;
  let i = 0;
  let elapsed = (now - s.startTick) | 0;
  let segStart = 0;
  let acc = 0;
  while (i < count) {
    const next = (acc + path.points[i]!.duration) | 0;
    segStart = acc;
    if (!(next < elapsed)) break;
    acc = next;
    i++;
  }
  if (count - 1 <= i) {
    if (s.mode === 2) return 0;
    if (s.mode === 1) {
      s.startTick = now;
      trackRestart(s, path, now);
      i = 0;
      elapsed = 0;
      segStart = 0;
    } else if (i === count) {
      elapsed = (elapsed - s.totalDuration) | 0;
      i = 0;
      s.startTick = (now - elapsed) | 0;
      segStart = 0;
    }
  }
  const p1 = path.points[i]!;
  const p2 = i !== count - 1 ? path.points[i + 1]! : path.points[0]!;
  if (p1.duration === 0) {
    unestablished('task_object_track: a point with duration 0 faults the divide in the C', 'task_object_track');
    return 1;
  }
  const f = sdivShl((elapsed - segStart) | 0, 16, p1.duration);
  s.rampX.target = (p1.x + mulr16(f, (p2.x - p1.x) | 0)) | 0;
  s.rampY.target = (p1.y + mulr16(f, (p2.y - p1.y) | 0)) | 0;
  s.rampZ.target = (p1.z + mulr16(f, (p2.z - p1.z) | 0)) | 0;
  const z = rampStep(s.rampZ, now);
  const y = rampStep(s.rampY, now);
  const x = rampStep(s.rampX, now);
  sceneNodeSetOrigin(node, x, y, z);
  let yaw = p1.yaw;
  if (s.rotate !== 0) yaw = (yaw + fixedAtan2((p2.x - p1.x) | 0, (p2.z - p1.z) | 0)) | 0;
  unwrapTo(s.angleYaw, yaw);
  let pitch = p1.pitch;
  if (s.rotate !== 0) pitch = (pitch - fixedAsin(((p2.y - p1.y) << 13) | 0)) | 0;
  unwrapTo(s.anglePitch, pitch);
  unwrapTo(s.angleRoll, p1.roll);
  const r = rampAngleStep(s.angleRoll, now);
  const yw = rampAngleStep(s.angleYaw, now);
  const pt = rampAngleStep(s.anglePitch, now);
  sceneNodeSetEuler(node, pt, yw, r, 0);
  sceneNodeWalk(node);
  return 1;
});

/** For the inspector: a task node's data as the handler holds it. @portOnly */
export function objectTaskState(t: TaskNode): unknown {
  return taskData(t).value;
}
