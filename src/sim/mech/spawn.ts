/**
 * Spawning a gamepiece: mech_spawn allocates and resets the MechEntity for a
 * mechTable slot and runs the class's createLoadout; the GP chunk
 * (project_chunk_exec) fills in the rest.
 *
 * The THNG queue: each THNG chunk appends a DetailRecord index; a
 * gamepiece's create hook pops two of them for its torso and weapon-aim
 * nodes (thing_node_queue_pop).
 */
import { ControlState, MechEntity } from '../../generated/classes.gen.ts';
import type { SceneNode } from '../../generated/classes.gen.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { rampStart } from '../../core/ramp.ts';
import type { CodeFn } from '../../engine/codePtr.ts';
import { clock } from '../../engine/clock.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32 } from '../../engine/image.ts';
import { detailRecordNode } from '../world/detailRecords.ts';
import { mechs } from './mechGlobals.ts';

export const THING_NODE_QUEUE_SIZE = 0x96;

export const thingNodes = registerGlobals(
  'thingNodes',
  {
    /** 0x153600: DetailRecord indices from THNG chunks; sim_load_by_name fills it with -1 before a load */
    thingNodeQueue: new Array<number>(THING_NODE_QUEUE_SIZE).fill(0),
    /** 0x9eb84 */
    thingNodeCount: 0,
    /** 0x9eb88 */
    thingNodeNext: 0,
  },
  () => {
    // 0x153600 is zero-initialised data in the image; sim_load_by_name fills it with -1 before any use
    thingNodes.thingNodeQueue = new Array<number>(THING_NODE_QUEUE_SIZE).fill(0);
    thingNodes.thingNodeCount = imageI32(LABEL.thingNodeCount, 0);
    thingNodes.thingNodeNext = imageI32(LABEL.thingNodeNext, 0);
  },
);

/**
 * The next THNG node: the detail record's node for the next queued index, or
 * null once the queue is used up.
 *
 * @mw2 thing_node_queue_pop 0x0004e540
 * @fidelity exact
 */
export function thingNodeQueuePop(): SceneNode | null {
  const t = thingNodes;
  if (t.thingNodeNext < t.thingNodeCount) {
    const node = detailRecordNode(t.thingNodeQueue[t.thingNodeNext]!);
    t.thingNodeNext++;
    return node;
  }
  return null;
}

/**
 * The AI's control block: every mech but the player's gets 0x48 extra bytes
 * after its MechEntity (allocated 0x1ec rather than 0x1a4), and its
 * MechEntity.control points there.
 */
const inlineControl = new WeakMap<MechEntity, ControlState>();

/**
 * Allocates the entity for a slot: 0x1a4 bytes for the player's mech, 0x1ec
 * (with the inline control block) for any other. Returns 1.
 *
 * @mw2 mech_entity_alloc 0x00024a80
 * @fidelity exact
 * @divergence cannot fail (the original returns 0 when static_malloc does)
 */
export function mechEntityAlloc(mechIndex: number): number {
  const e = new MechEntity();
  if (mechIndex !== mechs.playerMechIndex) inlineControl.set(e, new ControlState());
  mechs.mechTable[mechIndex] = e;
  return 1;
}

/**
 * The new entity's initialiser: zeroes or sets to -1 the fields from +0 to
 * +0xfe, and starts the two ramps at +0x98 and +0xa8 at 50000.
 *
 * @mw2 mech_entity_reset 0x00024ac0
 * @fidelity exact
 * @divergence the dwords at +0x24, +0xe0 and +0xe4 (padding in the header, no port fields) are zeroed in the original
 */
export function mechEntityReset(e: MechEntity): void {
  e.gamepieceClass = 0;
  e.index = 0;
  e.groupId = 0;
  e.starSlot = 0;
  e.controlSource = 0;
  e.flags = 0;
  e.seenByGroups = 0;
  e.spawnDetailLevel = 0;
  e.detailLevel = -1;
  e.loadout = null;
  // +0x24 = 0: no port field
  e.hooks.fill(null);
  e.node = null;
  e.aimNode = null;
  e.mountNode = null;
  e.control = null;
  e.posZ = 0;
  e.roll = 0;
  e.torsoRoll = 0;
  e.groundHeight = 0;
  e.onGround = 0;
  e.blockedByMech = -1;
  e.motionFlags = 0; // a dword store: the byte and its three pad bytes
  e.animState = -1;
  e.animTarget = -1;
  e.gaitBand = 0;
  e.animSoundId = -1;
  e.posY = e.posZ;
  e.posX = e.posZ;
  e.heading = e.roll;
  e.pitch = e.roll;
  e.aimAngle = e.torsoRoll;
  e.torsoPitch = e.torsoRoll;
  e.animFrameTicks = 0;
  rampStart(e.aimRange, 50000, 50000, 0.2, clock.simTick);
  rampStart(e.aimRangeSeek, 50000, 50000, 20.0, clock.simTick);
  e.headingCos = 0;
  e.targetDistance = 0;
  e.targetSlantRange = 0;
  e.targetZ = 0;
  e.desiredHeading = 0;
  e.torsoTilt = 0;
  e.targetHandle = 0xffffffff;
  // +0xe0 = 0, +0xe4 = 0: no port fields
  e.headingSin = e.headingCos;
  e.targetY = e.targetZ;
  e.targetX = e.targetZ;
  e.name = ''; // memset(+0xe8, 0, 0x16)
}

/**
 * Creates mechTable[mechIndex]: allocate, reset, index, the control block
 * (the player's playerControls with controlSource 0, otherwise the inline
 * block with controlSource 2), its first 0x48 bytes zeroed, then
 * createLoadout(mechIndex, entity).
 *
 * @mw2 mech_spawn 0x000249f0
 * @fidelity exact
 */
export function mechSpawn(mechIndex: number, createLoadout: CodeFn | null): void {
  mechs.mechTable[mechIndex] = null;
  if (mechEntityAlloc(mechIndex) === 0) return;
  const e = mechs.mechTable[mechIndex]!;
  mechEntityReset(e);
  e.index = mechIndex;
  if (mechIndex === mechs.playerMechIndex) {
    e.control = mechs.playerControls;
    e.controlSource = 0;
  } else {
    e.controlSource = 2;
    e.control = inlineControl.get(e) ?? null;
  }
  if (e.control) controlStateClear48(e.control);
  if (createLoadout) createLoadout(mechIndex, e);
}

/**
 * memset(control, 0, 0x48): every ControlState field below +0x48 - the
 * analogue channels and the digital ones up to cheatJumpjets.
 *
 * @portOnly the memset in mech_spawn
 */
function controlStateClear48(c: ControlState): void {
  const o = c as unknown as Record<string, number>;
  for (const f of ControlState.schema.fields) {
    if (f.kind === 'pad' || f.offset >= 0x48) continue;
    o[f.name] = 0;
  }
}
