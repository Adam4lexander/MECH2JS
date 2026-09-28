/**
 * The netplay_* functions of MW2.EXE (decompiled/mw2/src/netplay/netplay.c):
 * the join, the per-frame exchange, the DA and SN packets and the sign-off.
 * netplay.ts describes the protocol and holds the session's globals.
 */
import { divergence, quirk, unestablished } from '../../core/provenance.ts';
import { cdiv, cmod, i16 } from '../../core/int/cint.ts';
import { bootImage, imageU8 } from '../../engine/image.ts';
import { clock, simStopwatchElapsed } from '../../engine/clock.ts';
import { stopwatchElapsed, stopwatchReset, timerInterrupt } from '../../engine/timer.ts';
import { sceneNodeSetEuler, sceneNodeSetOrigin, sceneNodeWalk } from '../../engine/scene/sceneGraph.ts';
import { mechs } from '../mech/mechGlobals.ts';
import { mechConfig } from '../mech/config.ts';
import { loadoutSections } from '../mech/loadout.ts';
import { mechDestroySection, sceneSubtreeRaiseDamageLevel } from '../mech/damage.ts';
import { things } from '../things/gameThings.ts';
import { gamethingDestroy } from '../things/gameThingDamage.ts';
import { messagePost } from '../cockpit/messages.ts';
import { inputPollControls } from '../controls/input.ts';
import { inputGlobals } from '../controls/inputGlobals.ts';
import { ui } from '../ui/uiContext.ts';
import { vfxVideoTextHandler } from '../display/videoText.ts';
import { weaponGlobals } from '../weapons/weapons.ts';
import { netWeapons, netplayWeaponsStartBurst } from './netWeapons.ts';
import {
  netDosAllocRecv,
  netDosAllocSend,
  netDosFreeRecv,
  netDosFreeSend,
  netDriver,
  netNextMessage,
  netPoll,
  netQueueMessage,
  netReceive,
  netSend,
  netStationInfo,
} from './transport.ts';
import { net, type NetBlocking } from './netplay.ts';

/** The message tags' addresses in the image. */
const TAG_DA = 0x9178c;
const TAG_SN = 0x91790;
const TAG_SS = 0x91794;
const TAG_DE = 0x917b8;
const TAG_SI = 0x917f4;
/** sprintf formats */
const FMT_EXITED = 0x91798;
const FMT_MECH_DESTROYED = 0x917bc;
const FMT_OPPONENT_DESTROYED = 0x917d8;

const FALLBACK: Record<number, string> = {
  [TAG_DA]: 'DA',
  [TAG_SN]: 'SN',
  [TAG_SS]: 'SS',
  [TAG_DE]: 'DE',
  [TAG_SI]: 'SI',
  [FMT_EXITED]: 'Opponent %i exited the game.',
  [FMT_MECH_DESTROYED]: 'Opponent mech destroyed.',
  [FMT_OPPONENT_DESTROYED]: 'Opponent mech %i destroyed.',
};

/** A string constant of the image, or its known text before an image is loaded. @portOnly */
function imageString(addr: number): string {
  return bootImage()?.cstrAt(addr, 64) ?? FALLBACK[addr]!;
}

/** A two-byte tag as the bytes the code copies. @portOnly */
function tagBytes(addr: number): Uint8Array {
  const s = FALLBACK[addr]!;
  return Uint8Array.of(imageU8(addr, s.charCodeAt(0)), imageU8(addr + 1, s.charCodeAt(1)));
}

/** The one %i the three formats take. @portOnly sprintf for these formats */
function formatI(fmt: string, v: number): string {
  return fmt.replace('%i', String(v | 0));
}

/** A station's flag byte (the code tests and ORs the low byte of each int). @portOnly */
const flagsOf = (s: number): number => net.netStationFlags[s] ?? 0;
const orFlags = (s: number, bits: number): void => {
  if (s >= 0 && s < 8) net.netStationFlags[s] = (net.netStationFlags[s]! & ~0xff) | ((net.netStationFlags[s]! | bits) & 0xff);
  else unestablished(`station ${s} is outside netStationFlags: the original writes past the table`, 'netplay');
};

let spin: () => void = timerInterrupt;

/**
 * How a netplay loop that the original spun in real time lets time pass:
 * one timer interrupt by default, which keeps a headless run deterministic.
 *
 * @portOnly the host's say over the busy-waits on the driver
 */
export function setNetSpin(fn: () => void): void {
  spin = fn;
}

/** @portOnly one tick of busy-waiting, as the original's loops spent it */
function netSpin(): void {
  spin();
}

/**
 * The second stopwatch's elapsed ticks: what a client adds to simTick in a
 * frame that heard nothing from the master.
 *
 * @mw2 net_stopwatch_elapsed 0x000159a0
 * @fidelity exact
 */
export function netStopwatchElapsed(): number {
  return stopwatchElapsed(clock.netStopwatch);
}

/**
 * @mw2 net_stopwatch_reset 0x000159c0
 * @fidelity exact
 */
export function netStopwatchReset(): void {
  stopwatchReset(clock.netStopwatch);
}

/** stricmp of a message's two tag bytes against a tag. @portOnly the stricmp the receivers make */
function messageIs(at: number, tagAddr: number): boolean {
  const b = netDriver.recvBuffer;
  const t = tagBytes(tagAddr);
  const low = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
  return b[at] !== 0 && b[at + 1] !== 0 && low(b[at]!) === low(t[0]!) && low(b[at + 1]!) === low(t[1]!);
}

/**
 * Only with -N: allocates and clears the DA and SN packet buffers, takes the
 * two real-mode transfer buffers, asks the driver for this station and the
 * station count, makes this station's mech the player's
 * (playerMechIndex = station), and clears the per-station tables. Sets
 * netRole 2 until the join decides.
 *
 * @mw2 netplay_init 0x000445e0
 * @fidelity exact
 */
export function netplayInit(): void {
  if (mechs.netGameEnabled === 0) return;
  const n = net;
  n.netRole = 2;
  n.netStatePacketSize = 0x48;
  n.netStatePacket = new Uint8Array(0x48);
  n.netThingPacketSize = 0x23;
  n.netThingPacket = new Uint8Array(0x23);
  n.netSendBufferLinear = i16(netDosAllocSend()) << 4;
  n.netRecvBufferLinear = i16(netDosAllocRecv()) << 4;
  const info = netStationInfo();
  n.netStationCount = i16(info & 0xff);
  n.netMyStation = i16((i16(info) & 0xff00) >> 8);
  mechs.playerMechIndex = n.netMyStation;
  for (let i = 0; i < 8; i++) {
    n.netStationFlags[i] = 0;
    n.dat00152930[i] = 0x1f;
    n.netOpponentAnnounced[i] = 0;
  }
}

/**
 * Mission start: 1 at once outside a network game; otherwise drains every
 * waiting packet and runs the join, returning its result - main quits on 0.
 *
 * @mw2 netplay_start 0x000446d0
 * @fidelity exact
 * @divergence a generator: the join waits on the network across host frames
 */
export function* netplayStart(): NetBlocking<number> {
  if (net.netRole === 0) return 1;
  while ((netPoll() & 1) !== 0) netReceive();
  return yield* netplayJoin();
}

/**
 * The SI handshake. Phase 1 sends SI round-robin every 18 ticks and counts
 * each station the first time an SI arrives from it; phase 2 sends SI to
 * every station until each has taken one (every pass - its timer is reset
 * to "now" after each send). ESC ends either phase. When every station was
 * counted the session starts: netActiveStations = the count, state 1, the
 * master elected, unused stations marked gone, 'Link established' shown,
 * and this machine becomes the master (netRole 1, simClockMode 0) or a
 * client (netRole 2, simClockMode 2), with simTick from the sim stopwatch.
 * Otherwise 'Connection NOT made', state 0, netRole 0, and 0.
 *
 * @mw2 netplay_join 0x000451b0
 * @fidelity exact
 * @divergence a generator: each pass of either loop yields to the host before its input_poll_controls; dataSelector2 = dataSelector (DOS selectors) has no counterpart
 */
export function* netplayJoin(): NetBlocking<number> {
  const n = net;
  let counted = 1;
  let cursor = 0;
  let nextSend = 0;
  const si = tagBytes(TAG_SI);
  while ((netPoll() & 1) !== 0) netReceive();
  for (;;) {
    if (counted === n.netStationCount) break;
    if (simStopwatchElapsed() >= nextSend) {
      cursor = cmod(cursor + 1, n.netStationCount);
      if (cursor !== n.netMyStation) {
        const len = netQueueMessage(si, 2);
        netSend(i16(len), i16(cursor));
      }
      nextSend = (simStopwatchElapsed() + 0x12) | 0;
    }
    if ((netPoll() & 1) !== 0) {
      const r = netReceive();
      for (;;) {
        const m = netNextMessage(r.length);
        if (m === null) break;
        if (!messageIs(m, TAG_SI)) continue;
        if ((flagsOf(r.station) & 4) === 0) {
          counted++;
          orFlags(r.station, 4);
        }
        break;
      }
    }
    yield 'pass';
    inputPollControls();
    if (i16(inputGlobals.controlKey) === 0x1b) break;
  }
  if (counted === n.netStationCount) {
    counted = 1;
    let next = 0;
    for (;;) {
      if (counted === n.netStationCount) break;
      if (simStopwatchElapsed() >= next) {
        cursor = cmod(cursor + 1, n.netStationCount);
        if (cursor !== n.netMyStation) {
          const len = netQueueMessage(si, 2);
          if ((flagsOf(cursor) & 2) === 0 && i16(netSend(i16(len), i16(cursor))) === 0) {
            orFlags(cursor, 2);
            counted++;
          }
        }
        next = simStopwatchElapsed();
      }
      yield 'pass';
      inputPollControls();
      if (i16(inputGlobals.controlKey) === 0x1b) break;
    }
  }
  if (counted !== n.netStationCount) {
    n.netSessionState = 0;
    n.netRole = 0;
    vfxVideoTextHandler(0x4f, 1, 10, 0, 0);
    return 0;
  }
  n.netActiveStations = n.netStationCount;
  n.netSessionState = 1;
  netplayElectMaster();
  for (let s = counted; s < 8; s++) n.netStationFlags[s] = 0x1f;
  vfxVideoTextHandler(0x4f, 1, 9, 0, 0);
  if (n.netMyStation === n.netMasterStation) {
    n.netRole = 1;
    clock.simClockMode = 0;
  } else {
    n.netRole = 2;
    clock.simClockMode = 2;
  }
  clock.simTick = simStopwatchElapsed();
  return 1;
}

/**
 * The first call of main's loop. While a session runs and no quit is
 * pending: clears the round bits of every live station; RECEIVES and
 * dispatches every waiting packet for up to 4 ticks (DA to
 * netplay_apply_state, SN to netplay_apply_thing_bitmap; SS: reply SS until
 * delivered, mark the station gone, remove its mech (status 4, flags 6), one
 * station fewer, re-elect if it was the master, 'Opponent %i exited the
 * game.'; DE: the same reply and removal, 'Opponent mech destroyed.' - an SS
 * or DE ends that packet); SENDS, once simTick reaches netNextSendTick (then
 * 18 ticks on), this machine's DA and SN in one packet round-robin to every
 * live station until all have it or 9 ticks have passed; and on a CLIENT,
 * when nothing came from or went to the master this frame, advances simTick
 * by the net stopwatch, which it then resets.
 *
 * @mw2 netplay_frame_exchange 0x00044720
 * @fidelity exact
 * @divergence a failed send, or a round with no live station left to send to, spends a tick through netSpin, which is how the original's 9-tick bound passes when the driver is not delivering; the SS/DE reply loop ("until delivered") gives up after 0xb6 failed sends instead of hanging the tab
 */
export function netplayFrameExchange(): number {
  const n = net;
  let delivered = 1;
  let spent = 0;
  if (n.netSessionState !== 1) return 1;
  if (ui.quitRequested !== 0) return 1;
  for (let s = 0; s < 8; s++) if ((flagsOf(s) & 0xf0) === 0) n.netStationFlags[s] = 0;
  let cursor = 8;
  const t0 = simStopwatchElapsed();
  while ((netPoll() & 1) !== 0 && spent < 5) {
    const r = netReceive();
    const station = r.station;
    orFlags(station, 4);
    for (;;) {
      const m = netNextMessage(r.length);
      if (m === null) break;
      if (messageIs(m, TAG_DA)) {
        netplayApplyState(m, station);
        continue;
      }
      if (messageIs(m, TAG_SN)) {
        netplayApplyThingBitmap(m);
        continue;
      }
      if (messageIs(m, TAG_SS)) {
        replyUntilDelivered(station);
        n.netStationFlags[station] = 0x1f;
        removeMech(station);
        n.netActiveStations = i16(n.netActiveStations - 1);
        if (i16(station) === n.netMasterStation) netplayElectMaster();
        messagePost(formatI(imageString(FMT_EXITED), station), 1, 0x1554, 0x50);
        break;
      }
      if (messageIs(m, TAG_DE)) {
        replyUntilDelivered(station);
        removeMech(station);
        messagePost(imageString(FMT_MECH_DESTROYED), 1, 0x1554, 0x50);
        break;
      }
    }
    spent = (simStopwatchElapsed() - t0) | 0;
  }
  if (clock.simTick >= n.netNextSendTick) {
    n.netNextSendTick = (clock.simTick + 0x12) | 0;
    for (let i = 0; i < 8; i++) {
      const e = mechs.mechTable[i];
      if (e) e.flags &= 0xfffe;
    }
    // both return net_queue_message's length; the second, the whole packet's, is the one kept
    netplayBuildState();
    const len = netplayBuildThingBitmap();
    let sendSpent = 0;
    let idle = 0;
    const t1 = simStopwatchElapsed();
    while (sendSpent < 9 && delivered !== n.netActiveStations) {
      cursor = cmod(cursor + 1, n.netStationCount);
      if (cursor === n.netMyStation) continue;
      if ((flagsOf(cursor) & 2) === 0) {
        if (i16(netSend(i16(len), cursor)) === 0) {
          delivered++;
          orFlags(cursor, 2);
          idle = 0;
        } else {
          divergence('a send the driver did not deliver: the port spends a tick on it, as the original spent real time retrying', 'netplay_frame_exchange');
          netSpin();
        }
      } else if (++idle > n.netStationCount) {
        // nobody left to deliver to but the count says otherwise: the original spins out its 9 ticks
        divergence('a send round with no station left to deliver to: the port spends a tick on it', 'netplay_frame_exchange');
        netSpin();
        idle = 0;
      }
      sendSpent = (simStopwatchElapsed() - t1) | 0;
    }
  }
  if ((flagsOf(n.netMasterStation) & 6) === 0 && n.netMyStation !== n.netMasterStation && n.netRole === 2) {
    clock.simTick = (clock.simTick + netStopwatchElapsed()) | 0;
  }
  if (n.netRole === 2) netStopwatchReset();
  return 1;
}

/** @portOnly SS and DE's reply: SS to the sender, "until delivered" */
function replyUntilDelivered(station: number): void {
  const len = netQueueMessage(tagBytes(TAG_SS), 2);
  for (let tries = 0; i16(netSend(i16(len), station)) !== 0; tries++) {
    if (tries >= 0xb6) {
      divergence('the SS reply was never delivered: the original retries forever; the port gives up', 'netplay_frame_exchange');
      break;
    }
    netSpin();
  }
}

/** @portOnly SS and DE's removal of the sender's mech: status 4, entity flags 6 */
function removeMech(station: number): void {
  const e = mechs.mechTable[station];
  if (!e?.loadout) {
    unestablished(`station ${station} has no mech: the original writes through a null pointer`, 'netplay_frame_exchange');
    return;
  }
  e.loadout.status = 4;
  e.flags |= 6;
}

/**
 * Mission end (and system_error): signs off, then - if a session was ever
 * started - frees the packet buffers and the transfer buffers.
 *
 * @mw2 netplay_shutdown 0x00044a90
 * @fidelity exact
 */
export function netplayShutdown(): number {
  const r = netplaySignOff();
  if (net.netSessionState === 0) return r;
  if (net.netStatePacket) net.netStatePacket = null;
  if (net.netThingPacket) net.netThingPacket = null;
  netDosFreeSend();
  return netDosFreeRecv();
}

/**
 * Writes this machine's DA packet from the player's mech and queues it:
 * +0 'DA'; +2 the mech's index; +3 a word - status in bits 0-3, the weapons
 * fired since the last packet in bits 5-14 (netplayWeaponFiredLocal, which
 * this clears), reverseDirection in bit 15; +5..+7 rear armour of sections
 * 4, 3, 2; +8..+0xf front armour and +0x10..+0x17 internal structure of
 * sections 1..8 (negative sent as 0) - each as ONE BYTE of whole points;
 * +0x18 simTick on the master, 0 on a client; +0x1c.. position, pitch,
 * heading, roll; +0x34.. ramps 2, 4, 3, 0, 1 (speed, throttle, turn rate,
 * torso pan, torso tilt). Returns net_queue_message's length.
 *
 * @mw2 netplay_build_state 0x00044b70
 * @fidelity exact
 */
export function netplayBuildState(): number {
  const n = net;
  const p = n.netStatePacket!;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  p.set(tagBytes(TAG_DA), 0);
  const e = mechs.mechTable[mechs.playerMechIndex]!;
  const l = e.loadout!;
  p[2] = e.index & 0xff;
  dv.setInt32(0x1c, e.posX, true);
  dv.setInt32(0x20, e.posY, true);
  dv.setInt32(0x24, e.posZ, true);
  dv.setInt32(0x28, e.pitch, true);
  dv.setInt32(0x2c, e.heading, true);
  dv.setInt32(0x30, e.roll, true);
  dv.setInt32(0x34, l.ramps[2]!.current, true);
  dv.setInt32(0x38, l.ramps[4]!.current, true);
  dv.setInt32(0x3c, l.ramps[3]!.current, true);
  dv.setInt32(0x40, l.ramps[0]!.current, true);
  dv.setUint16(3, 0, true);
  dv.setInt32(0x44, l.ramps[1]!.current, true);
  dv.setUint16(3, dv.getUint16(3, true) | (l.status & 0xf), true);
  if (l.entity!.control!.reverseDirection !== 0) p[4]! |= 0x80;
  else p[4]! &= 0x7f;
  const local = weaponGlobals.netplayWeaponFiredLocal;
  for (let i = 0; i < 10; i++) {
    if (local[i] === 0) continue;
    dv.setUint16(3, (dv.getUint16(3, true) | (1 << (i + 5))) & 0xffff, true);
    local[i] = 0;
  }
  dv.setInt32(0x18, n.netRole === 1 ? clock.simTick : 0, true);
  const sections = loadoutSections(l);
  for (let i = 0; i < 8; i++) {
    const s = sections[i]!;
    const loc = i + 1;
    if (loc === 2) p[7] = s.armorRear >> 16;
    else if (loc === 3) p[6] = s.armorRear >> 16;
    else if (loc === 4) p[5] = s.armorRear >> 16;
    p[8 + i] = s.armorFront >> 16;
    p[0x10 + i] = s.internal < 0 ? 0 : s.internal >> 16;
  }
  return netQueueMessage(p, n.netStatePacketSize);
}

/**
 * Applies one DA message to mechTable[station] - the SOURCE station, not the
 * packet's index byte - unless that byte is this machine's own mech. A
 * client first adopts the packet's simTick. Sets the pose and moves the node,
 * the five ramps (current and target), status, reverseDirection, the fired
 * weapons (netplay_weapons_start_burst), and each section's armour and
 * internal structure from whole points, raising its damage level and
 * destroying a section at 0 internal; posts 'Opponent mech %i destroyed.'
 * the first time the status is 4 or 5.
 *
 * @mw2 netplay_apply_state 0x00044d40
 * @fidelity exact
 */
export function netplayApplyState(msg: number, station: number): void {
  const n = net;
  const p = n.netStatePacket!;
  p.set(netDriver.recvBuffer.subarray(msg, msg + 0x48));
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let rearLevel = 0;
  let frontLevel: number | null = null;
  if (n.netRole === 2) {
    // no test of whose packet it is: a client takes simTick from every DA, and only the master's carries one
    quirk('a client adopts simTick from every DA packet, including another client\'s (which carries 0)', 'netplay_apply_state');
    clock.simTick = dv.getInt32(0x18, true);
  }
  if (p[2] === mechs.playerMechIndex) return;
  const e = mechs.mechTable[station];
  if (!e?.loadout || !e.node) {
    unestablished(`DA from station ${station}, which has no mech: the original writes through a null pointer`, 'netplay_apply_state');
    return;
  }
  e.flags |= 1;
  e.posX = dv.getInt32(0x1c, true);
  e.posY = dv.getInt32(0x20, true);
  e.posZ = dv.getInt32(0x24, true);
  e.pitch = dv.getInt32(0x28, true);
  e.heading = dv.getInt32(0x2c, true);
  e.roll = dv.getInt32(0x30, true);
  const l = e.loadout;
  sceneNodeSetOrigin(e.node, e.posX, e.posY, e.posZ);
  sceneNodeSetEuler(e.node, e.pitch, e.heading, e.roll, 0);
  sceneNodeWalk(e.node);
  const ramp = (r: number, at: number) => {
    const v = dv.getInt32(at, true);
    l.ramps[r]!.current = v;
    l.ramps[r]!.target = v;
  };
  ramp(2, 0x34);
  ramp(4, 0x38);
  ramp(3, 0x3c);
  ramp(0, 0x40);
  ramp(1, 0x44);
  e.flags &= 0xfffe;
  l.status = dv.getUint16(3, true) & 0xf;
  const control = l.entity?.control;
  if (!control) unestablished('a remote mech with no ControlState: reverseDirection is written through a null pointer', 'netplay_apply_state');
  else control.reverseDirection = (dv.getUint16(3, true) & 0x8000) !== 0 ? 1 : 0;
  for (let i = 0, bit = 0x20; i < 10; i++, bit <<= 1) if ((bit & dv.getUint16(3, true)) !== 0) netWeapons.netplayWeaponFired[i] = 1;
  netplayWeaponsStartBurst(l);
  const scale = mechConfig.playerArmorScale;
  const sections = loadoutSections(l);
  for (let i = 0; i < 8; i++) {
    const s = sections[i]!;
    const loc = i + 1;
    s.armorFront = p[8 + i]! << 16;
    s.internal = p[0x10 + i]! << 16;
    const rear = loc === 2 ? p[7] : loc === 3 ? p[6] : loc === 4 ? p[5] : undefined;
    if (rear !== undefined) {
      s.armorRear = rear << 16;
      const max = (s.flags & 0xf0) >> 4;
      if (max !== 0) rearLevel = 0xf - cdiv(Math.imul(cdiv(s.armorRear, scale) + s.internal, 3), max << 16);
    }
    const max = s.flags & 0xf;
    if (max !== 0) frontLevel = 0xf - cdiv(Math.imul(cdiv(s.armorFront, scale) + s.internal, 3), max << 16);
    if (frontLevel === null) {
      unestablished('netplay_apply_state: the front damage level is read before any section set it (an uninitialised local); taken as the rear level', 'netplay_apply_state');
    }
    if (rearLevel !== 0 && rear === undefined) quirk('the rear damage level carries over from the side torsos to the sections after them', 'netplay_apply_state');
    const level = frontLevel !== null && frontLevel > rearLevel ? frontLevel : rearLevel;
    sceneSubtreeRaiseDamageLevel(l.entity!.node!, level, loc);
    if (s.internal <= 0 && ((s.flags >> 8) & 0x20) === 0) mechDestroySection(l, loc);
  }
  if ((l.status === 4 || l.status === 5) && (n.netOpponentAnnounced[e.index] ?? 1) === 0) {
    n.netOpponentAnnounced[e.index] = 1;
    e.flags |= 6;
    messagePost(formatI(imageString(FMT_OPPONENT_DESTROYED), e.index), 1, 0x1554, 0x50);
  }
}

/**
 * Writes the SN message - 'SN' and one bit per gamething, set when it is
 * destroyed (flags 4), most significant first - and queues it.
 *
 * @mw2 netplay_build_thing_bitmap 0x00045090
 * @fidelity exact
 */
export function netplayBuildThingBitmap(): number {
  const n = net;
  const p = n.netThingPacket!;
  p.set(tagBytes(TAG_SN), 0);
  let at = 2;
  let bits = 0;
  let k = 0;
  for (let i = 0; i < 0xfe; i++) {
    bits = (bits << 1) & 0xff;
    if ((things.gameThings[i]!.flags & 4) !== 0) bits |= 1;
    if (++k === 8) {
      k = 0;
      p[at++] = bits;
      bits = 0;
    }
  }
  quirk('SN: a byte is stored only after every eighth gamething, so 248..253 are never sent', 'netplay_build_thing_bitmap');
  return netQueueMessage(p, n.netThingPacketSize);
}

/**
 * Applies an SN message: destroys every gamething whose bit is set and is
 * not already destroyed - reading one byte behind from the second byte on,
 * so gamething i (i >= 8) takes the bit sent for gamething i - 8.
 *
 * @mw2 netplay_apply_thing_bitmap 0x00045120
 * @fidelity exact
 */
export function netplayApplyThingBitmap(msg: number): void {
  const n = net;
  const p = n.netThingPacket!;
  p.set(netDriver.recvBuffer.subarray(msg, msg + n.netThingPacketSize));
  let at = 2;
  let bits = p[at]!;
  let k = 0;
  for (let i = 0; i < 0xfe; i++) {
    if ((bits & 0x80) !== 0 && (things.gameThings[i]!.flags & 4) === 0) gamethingDestroy(i);
    k++;
    bits = (bits << 1) & 0xff;
    if (k === 8) {
      at++;
      k = 0;
      // inc eax, then mov bl, [eax - 1]: the byte just used, again
      bits = p[at - 1]!;
    }
  }
  quirk('SN is read one byte behind: gamething i >= 8 takes the bit sent for i - 8', 'netplay_apply_thing_bitmap');
}

/**
 * Leaving: clears the round bits; if a session is running, ends it
 * (state 2, netRole 0, simClockMode 0) and for up to a second sends SS to
 * every live station not yet delivered to, counting the SI / SS / DE replies
 * until every station has answered. Returns 1.
 *
 * @mw2 netplay_sign_off 0x00045470
 * @fidelity exact
 * @divergence each pass spends a tick through netSpin: the original's second passes in real time while it spins, the port's loop would not otherwise end
 */
export function netplaySignOff(): number {
  const n = net;
  let answered = 1;
  for (let s = 0; s < 8; s++) if ((flagsOf(s) & 0xf0) === 0) n.netStationFlags[s] = 0;
  if (n.netSessionState !== 1) return 1;
  n.netSessionState = 2;
  n.netRole = 0;
  clock.simClockMode = 0;
  const deadline = (simStopwatchElapsed() + 0xb6) | 0;
  let now = 0;
  const ss = tagBytes(TAG_SS);
  while (n.netActiveStations !== answered && now < deadline) {
    const len = netQueueMessage(ss, 2);
    for (let s = 0; s < 8; s++) {
      const f = flagsOf(s);
      if ((f & 2) === 0 && s !== n.netMyStation && (f & 0xf0) === 0) {
        if (i16(netSend(i16(len), s)) === 0) orFlags(s, 2);
      }
    }
    let got = 0;
    let station = 0;
    if ((netPoll() & 1) !== 0) {
      const r = netReceive();
      got = r.length;
      station = r.station;
    }
    if (i16(got) !== 0 && (flagsOf(station) & 4) === 0) {
      for (;;) {
        const m = netNextMessage(got);
        if (m === null) break;
        if (messageIs(m, TAG_SI)) {
          answered++;
          orFlags(station, 4);
          break;
        }
        if (messageIs(m, TAG_SS) || messageIs(m, TAG_DE)) {
          answered++;
          orFlags(station, 4);
        }
      }
    }
    divergence('netplay_sign_off: each pass spends one timer tick (the original waits out its second in real time)', 'netplay_sign_off');
    netSpin();
    now = simStopwatchElapsed();
  }
  return 1;
}

/**
 * The master is the lowest station not marked gone; a client that finds
 * itself the master takes the clock (netRole 1, simClockMode 0), and with
 * one station left the session ends (state 2, netRole 0, simClockMode 0).
 *
 * @mw2 netplay_elect_master 0x00045670
 * @fidelity exact
 */
export function netplayElectMaster(): void {
  const n = net;
  let role = n.netRole;
  for (let s = 0; s < 8; s++) {
    if ((flagsOf(s) & 0xf0) === 0) {
      n.netMasterStation = s;
      break;
    }
  }
  if (role === 2 && n.netMasterStation === n.netMyStation) {
    role = 1;
    clock.simClockMode = 0;
  }
  if (n.netActiveStations === 1) {
    n.netSessionState = 2;
    role = 0;
    clock.simClockMode = 0;
  }
  n.netRole = role;
}
