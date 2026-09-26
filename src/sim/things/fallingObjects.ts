/**
 * fallingObjects: 128 slots of 0x21 bytes, each simulating one detached scene
 * node under gravity with a random tumble (debris, blown-off parts). The
 * per-tick simulation (falling_object_tick) is ported with the frame loop.
 */
import { FallingObject } from '../../generated/classes.gen.ts';
import type { SceneNode } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { mulr16 } from '../../core/int/fx16.ts';
import { imul64, mulShr, regHi, regLo } from '../../core/int/i64.ts';
import { randomNext, randomRange } from '../../core/random.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import {
  sceneNodeDetachKeepWorld,
  sceneNodeGetUserdata,
  sceneNodeRemoveSubtreeFromWorld,
  sceneNodeRotateEuler,
  sceneNodeTranslate,
  sceneNodeWalk,
  sceneSubtreeMoveToAltList,
} from '../../engine/scene/sceneGraph.ts';
import { objectGetPosRadius } from '../../engine/scene/worldObject.ts';
import { worldGroundHeightNear } from '../world/collision.ts';
import { planet } from '../world/planet.ts';

export const FALLING_COUNT = 0x80;

export const falling = registerGlobals(
  'fallingObjects',
  {
    fallingObjects: Array.from({ length: FALLING_COUNT }, () => new FallingObject()),
    /** 0x9635c: bumped by every attach, dropped when falling_object_tick releases a slot (falling_object_clear leaves it) */
    fallingObjectCount: 0,
  },
  () => {
    falling.fallingObjects = Array.from({ length: FALLING_COUNT }, () => new FallingObject());
    falling.fallingObjectCount = imageI32(LABEL.fallingObjectCount, 0);
  },
);

/**
 * @mw2 falling_objects_full 0x0002b2d0
 * @fidelity exact
 */
export function fallingObjectsFull(): boolean {
  let i = 0;
  while (i < FALLING_COUNT && falling.fallingObjects[i]!.node) i++;
  return i === FALLING_COUNT;
}

/**
 * The slot already holding `node`, else the first free one; -1 when full.
 * Detaches the node (keeping its world transform) and seeds accelY = -gravity.
 *
 * @mw2 falling_object_attach 0x0002b310
 * @fidelity exact
 */
export function fallingObjectAttach(node: SceneNode | null, kind: number): number {
  if (!node) return -1;
  const f = falling.fallingObjects;
  let i = 0;
  while (i < FALLING_COUNT && f[i]!.node !== node) i++;
  if (i === FALLING_COUNT) {
    i = 0;
    while (i < FALLING_COUNT && f[i]!.node) i++;
  }
  if (i === FALLING_COUNT) return -1;
  const s = f[i]!;
  s.velX = s.velY = s.velZ = 0;
  s.pitchRate = s.yawRate = s.rollRate = 0;
  s.field_0x0 = 0;
  falling.fallingObjectCount++;
  s.node = null;
  s.accelY = 0;
  sceneNodeDetachKeepWorld(node);
  s.field_0x0 = kind & 0xff;
  s.node = node;
  s.accelY = -planet.gravity | 0;
  return i;
}

function speedScale(numerator: number): number {
  const q = cdiv(numerator, ((planet.gravitySetting << 10) >> 16) | 0);
  imul64(q, 0x57e98);
  const lo = regLo();
  return (((lo >>> 16) | (regHi() << 16)) + ((lo >>> 15) & 1)) | 0;
}

/**
 * Random linear and angular velocity for a claimed slot.
 *
 * @mw2 falling_object_randomise_motion 0x0002b3f0
 * @fidelity exact
 */
export function fallingObjectRandomiseMotion(slot: number): void {
  const s = falling.fallingObjects[slot]!;
  if (!s.node) return;
  s.velX = speedScale(randomNext() << 16);
  s.velZ = speedScale(randomNext() << 16);
  s.velY = speedScale(Math.imul((randomNext() + 0x400) | 0, 0x10000));
  s.pitchRate = cdiv(Math.imul(randomNext(), 0x7e98), 0x400);
  s.yawRate = cdiv(Math.imul(randomNext(), 0x7e98), 0x400);
  s.rollRate = cdiv(Math.imul(randomNext(), 0x7e98), 0x400);
}

/**
 * @mw2 falling_object_clear 0x0002bd70
 * @fidelity exact
 */
export function fallingObjectClear(slot: number): void {
  const s = falling.fallingObjects[slot]!;
  s.field_0x0 = 0;
  s.node = null;
  s.velX = s.velY = s.velZ = 0;
  s.pitchRate = s.yawRate = s.rollRate = 0;
  s.accelY = 0;
}

/**
 * @mw2 falling_object_find 0x0002bdc0
 * @fidelity exact
 */
export function fallingObjectFind(node: SceneNode | null): number {
  for (let i = 0; i < FALLING_COUNT; i++) if (falling.fallingObjects[i]!.node === node) return i;
  return -1;
}

/**
 * Pushes a falling object: sets it tumbling, cuts any existing velocity
 * longer than twice the push down to that length (same direction), then
 * adds the push. Lengths are octagonal. Nothing for an empty slot or a zero
 * push.
 *
 * @mw2 falling_object_push 0x0002bbb0
 * @fidelity exact
 */
export function fallingObjectPush(slot: number, dx: number, dy: number, dz: number): void {
  const s = falling.fallingObjects[slot]!;
  if (!s.node) return;
  const oct = (a: number, b: number, c: number) => {
    a = Math.abs(a) | 0;
    b = Math.abs(b) | 0;
    c = Math.abs(c) | 0;
    let hi = a;
    let lo = b;
    if (a < b) {
      hi = b;
      lo = a;
    }
    let top = hi;
    let mid = c;
    if (hi < c) {
      top = c;
      mid = hi;
    }
    return ((Math.imul(top, 4) + lo + mid) | 0) >> 2;
  };
  let p = oct(dx, dy, dz);
  if (p === 0) return;
  fallingObjectRandomiseMotion(slot);
  const v = oct(s.velX, s.velY, s.velZ);
  if (p < v) {
    // (2p << 16) / v, 16.16
    p = Number(BigInt.asIntN(32, (BigInt(Math.imul(p, 2)) << 16n) / BigInt(v)));
    const r16 = (a: number) => {
      imul64(a, p);
      const l = regLo();
      return (((l >>> 16) | (regHi() << 16)) + ((l >>> 15) & 1)) | 0;
    };
    s.velX = r16(s.velX);
    s.velY = r16(s.velY);
    s.velZ = r16(s.velZ);
  }
  s.velX = (s.velX + dx) | 0;
  s.velY = (s.velY + dy) | 0;
  s.velZ = (s.velZ + dz) | 0;
}

/**
 * One step of a falling slot. The point moved and tested is the object's
 * centre lowered by half its radius. velY gains accelY * tickDelta and the
 * point drops by the half-step displacement; while falling (new velY <= 0),
 * reaching world_ground_height_near at the start-of-tick x, z lands it
 * there: a quarter-speed rebound, spin halved and reversed, and on a
 * random_range(2) roll the rebound halved again and velX / velZ halved and
 * reversed. A landing slower than 1 m/s (new velY above -0x8ca8) releases
 * the slot and the node rests where it is. A landing in a tick that began
 * rising frees the subtree from the world as well. Horizontal velocity and
 * spin carry through between bounces (no drag).
 *
 * @mw2 falling_object_tick 0x0002b930
 * @fidelity exact
 */
export function fallingObjectTick(slot: number): void {
  const f = falling.fallingObjects[slot]!;
  if (!f.node) return;
  let release = 0;
  const dt = clock.tickDelta;
  const p = objectGetPosRadius(sceneNodeGetUserdata(f.node)!);
  const x = p.x;
  const y = (p.y - (p.radius >> 1)) | 0;
  const z = p.z;
  const rising = f.velY > 0;
  const accelDt = Math.imul(f.accelY, dt);
  let velY = (f.velY + accelDt) | 0;
  let newY = (y + mulShr(((accelDt >> 1) + f.velY) | 0, dt, 16)) | 0;
  if (velY < 1) {
    const ground = worldGroundHeightNear(x, y, z);
    if (newY <= ground) {
      if (rising) {
        const n = f.node;
        if (n) {
          sceneSubtreeMoveToAltList(n);
          sceneNodeRemoveSubtreeFromWorld(n);
          sceneNodeWalk(n);
        }
        release = 1;
      }
      if (-0x8ca8 < velY) release = 1;
      velY = -(velY >> 2) | 0;
      if (randomRange(2) !== 0) {
        velY >>= 1;
        f.velX = -(f.velX >> 1) | 0;
        f.velZ = -(f.velZ >> 1) | 0;
      }
      f.pitchRate = -(f.pitchRate >> 1) | 0;
      f.yawRate = -(f.yawRate >> 1) | 0;
      f.rollRate = -(f.rollRate >> 1) | 0;
      newY = ground;
    }
  }
  f.velY = velY;
  const spinDt = dt << 16;
  sceneNodeTranslate(f.node, mulr16(f.velX, dt), (newY - y) | 0, mulr16(f.velZ, dt));
  sceneNodeRotateEuler(f.node, mulShr(f.pitchRate, spinDt, 16), mulShr(f.yawRate, spinDt, 16), mulShr(f.rollRate, spinDt, 16), 0);
  sceneNodeWalk(f.node);
  if (release !== 0) {
    falling.fallingObjectCount = (falling.fallingObjectCount - 1) | 0;
    fallingObjectClear(slot);
  }
}
