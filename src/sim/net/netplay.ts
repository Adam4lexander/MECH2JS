/**
 * NetMech: MW2.EXE's network game (decompiled/mw2/src/netplay/netplay.c).
 *
 * THE MODEL. Every machine runs the whole mission; station n drives
 * mechTable[n] (netplay_init makes playerMechIndex the station number) and
 * replays every other mech from the DA packets its owner sends ten times a
 * second - pose, ramps, status, armour and internal structure set outright,
 * weapon fire restarted locally. Damage and heat land only on a machine's
 * own mech (projectile_update and friends test netRole), so armour travels
 * in its owner's packets. Destroyed gamethings travel as a bitmap (SN), and
 * a station leaving says so (SS). The lowest live station is the MASTER: its
 * simTick rides in its DA packets and a client (netRole 2, simClockMode 2)
 * adopts it; between master packets a client's clock runs on the net
 * stopwatch.
 *
 * THE WIRE. A packet is up to 256 bytes of messages, each a two-letter tag
 * and a body followed by 'EOP\xff' (net_queue_message / net_next_message in
 * transport.ts). Messages: SI join, DA state (0x48 bytes), SN destroyed
 * gamethings (0x23), SS sign-off (and its reply), DE opponent destroyed -
 * which nothing in MW2.EXE sends.
 *
 * THE PORT. This module holds the session's globals, which the sim reads
 * (netRole above all), and nothing else, so that it imports nothing of the
 * sim; the netplay_* functions are in netSession.ts. The join and the rest
 * of main's start-up block on the network,
 * so netplay_start and netplay_join are generators (NetBlocking) that give
 * the host its frame at the loop's input_poll_controls; everything else is
 * synchronous, as in the original. Loops that in the original wait out real
 * time on a driver that is not answering (a failed send, the sign-off's one
 * second) advance the timer through netSpin, so they end in a headless run.
 */
import { i16 } from '../../core/int/cint.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageI32, imageI32s } from '../../engine/image.ts';

/** What a blocking netplay loop hands the host: a pass of the loop ended at its input_poll_controls. @portOnly */
export type NetWait = 'pass';
/** A netplay routine that blocks on the network: a generator returning T. @portOnly */
export type NetBlocking<T> = Generator<NetWait, T, void>;

export const net = registerGlobals(
  'net',
  {
    /** 0x982d8: 0 none, 1 while a network session runs, 2 once it has ended (signed off, or last station left) */
    netSessionState: 0,
    /** 0x982dc: 0 single player; 1 the master (owns the clock), 2 a client */
    netRole: 0,
    /** 0x982cc (short): stations still in the game, this one included */
    netActiveStations: 0,
    /** 0x982ce (short): the number of stations, net_station_info's low byte */
    netStationCount: 0,
    /** 0x982d0: the DA packet buffer, built for sending and overwritten by each received DA */
    netStatePacket: null as Uint8Array | null,
    /** 0x982d4: the SN packet buffer, likewise shared by both directions */
    netThingPacket: null as Uint8Array | null,
    /** 0x982e0: simTick of the next state packet */
    netNextSendTick: 0,
    /** 0x152910: int[8], per mech index: 'Opponent mech %i destroyed.' has been posted */
    netOpponentAnnounced: new Int32Array(8),
    /**
     * 0x152930: int[8] that netplay_init fills with 0x1f, next to
     * netOpponentAnnounced and netStationFlags. Nothing else in MW2.EXE is
     * known to reference it; what it is for is not established.
     */
    dat00152930: new Int32Array(8),
    /** 0x152950: int[8] per station - bit 2 our packet delivered this round, bit 4 heard from it, 0x1f gone */
    netStationFlags: new Int32Array(8),
    /** 0x152970 */
    netThingPacketSize: 0,
    /** 0x152974 */
    netStatePacketSize: 0,
    /** 0x152978: the receive buffer's linear address (the port keeps a token; the buffer is netDriver.recvBuffer) */
    netRecvBufferLinear: 0,
    /** 0x15297c: the send buffer's linear address (a token; netDriver.sendBuffer) */
    netSendBufferLinear: 0,
    /** 0x152980 (short): this machine's station */
    netMyStation: 0,
    /** 0x152982 (short): the lowest station not gone - the clock's owner */
    netMasterStation: 0,
  },
  () => {
    const n = net;
    n.netSessionState = imageI32(LABEL.netSessionState, 0);
    n.netRole = imageI32(LABEL.netRole, 0);
    n.netActiveStations = i16(imageI32(LABEL.netActiveStations, 0));
    n.netStationCount = i16(imageI32(LABEL.netStationCount, 0));
    n.netStatePacket = null;
    n.netThingPacket = null;
    n.netNextSendTick = imageI32(LABEL.netNextSendTick, 0);
    n.netOpponentAnnounced = Int32Array.from(imageI32s(LABEL.netOpponentAnnounced, 8, new Array<number>(8).fill(0)));
    n.dat00152930 = Int32Array.from(imageI32s(0x152930, 8, new Array<number>(8).fill(0)));
    n.netStationFlags = Int32Array.from(imageI32s(LABEL.netStationFlags, 8, new Array<number>(8).fill(0)));
    n.netThingPacketSize = imageI32(LABEL.netThingPacketSize, 0);
    n.netStatePacketSize = imageI32(LABEL.netStatePacketSize, 0);
    n.netRecvBufferLinear = imageI32(LABEL.netRecvBufferLinear, 0);
    n.netSendBufferLinear = imageI32(LABEL.netSendBufferLinear, 0);
    n.netMyStation = i16(imageI32(LABEL.netMyStation, 0));
    n.netMasterStation = i16(imageI32(LABEL.netMasterStation, 0));
  },
);
