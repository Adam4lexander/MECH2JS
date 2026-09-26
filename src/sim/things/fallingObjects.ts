/**
 * fallingObjects: 128 slots of 0x21 bytes, each simulating one detached scene
 * node under gravity with a random tumble (debris, blown-off parts). The
 * per-tick simulation (falling_object_tick) is ported with the frame loop.
 */
import { FallingObject } from '../../generated/classes.gen.ts';
import type { SceneNode } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { cdiv } from '../../core/int/cint.ts';
import { imul64, regHi, regLo } from '../../core/int/i64.ts';
import { randomNext } from '../../core/random.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { sceneNodeDetachKeepWorld } from '../../engine/scene/sceneGraph.ts';
import { planet } from '../world/planet.ts';

export const FALLING_COUNT = 0x80;

export const falling = registerGlobals(
  'fallingObjects',
  {
    fallingObjects: Array.from({ length: FALLING_COUNT }, () => new FallingObject()),
    /** 0x9635c: bumped by every attach; nothing found decrements it */
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
