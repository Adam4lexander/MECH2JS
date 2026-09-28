/**
 * The network driver glue: MW2.EXE's side of the TSR on software interrupt
 * 0x65 (NETB2, COMIO or MODEM in the install - which one is loaded is the
 * player's business, and the port does not reproduce any of them). The
 * routines sit at 0x46874..0x46a10, filed by address under the cheats module
 * of the decompilation (decompiled/mw2/src/ui/cheats.c).
 *
 * The driver's services, by AX:
 *   3  net_station_info  AH = this station, AL = the number of stations
 *   4  net_poll          bit 0 of AX set while a packet is waiting
 *   5  net_send          one packet (CX bytes at DX:0) to station AH; AX 0 = delivered
 *   6  net_receive       one packet into DX:0; AX its length, DX its source station
 *
 * The port's driver is a NetTransport the host installs (setNetTransport):
 * an in-memory hub for tests (memoryTransport.ts) or a WebRTC data channel
 * (app/net). The two real-mode transfer buffers DPMI allocated are byte
 * arrays here, and the message framing on top of them - net_queue_message
 * and net_next_message - is the original's, byte for byte.
 */
import { divergence, unestablished } from '../../core/provenance.ts';
import { i16 } from '../../core/int/cint.ts';
import { LABEL } from '../../generated/labels.gen.ts';
import { registerGlobals } from '../../engine/globals.ts';
import { imageU8 } from '../../engine/image.ts';

/** One received packet: its bytes and the station it came from. */
export interface NetPacket {
  from: number;
  bytes: Uint8Array;
}

/**
 * The INT 0x65 driver, as the port's hosts supply it. Packets are delivered
 * whole, in order, to one station at a time - the contract the original's
 * drivers gave MW2.EXE.
 *
 * @portOnly the TSR's interface; the drivers themselves are out of scope
 */
export interface NetTransport {
  /** AX 3, high byte: this machine's station number */
  readonly station: number;
  /** AX 3, low byte: how many stations the session has */
  readonly stationCount: number;
  /** AX 4: whether a packet is waiting */
  poll(): boolean;
  /** AX 5: sends one packet to one station; true when it was delivered (the driver's AX 0) */
  send(to: number, bytes: Uint8Array): boolean;
  /** AX 6: takes the next waiting packet, or null when there is none */
  receive(): NetPacket | null;
}

let transport: NetTransport | null = null;

/** Installs the network driver MW2.EXE will find on INT 0x65 (null: none). @portOnly the TSR is loaded before MW2.EXE starts */
export function setNetTransport(t: NetTransport | null): void {
  transport = t;
}

/** The installed driver, or null. @portOnly */
export function netTransport(): NetTransport | null {
  return transport;
}

/** DPMI allocates 0x100 paragraphs for each transfer buffer. */
export const NET_BUFFER_SIZE = 0x1000;

/** The four bytes at 0x98310, 'EOP\xff', read from the image. @portOnly */
export function netMessageTerminator(): Uint8Array {
  const t = new Uint8Array(4);
  const fallback = [0x45, 0x4f, 0x50, 0xff];
  for (let i = 0; i < 4; i++) t[i] = imageU8(LABEL.netMessageTerminator + i, fallback[i]!);
  return t;
}

export const netDriver = registerGlobals(
  'netDriver',
  {
    /** 0x98304: the send buffer's real-mode segment (0xffff when the allocation failed) */
    dat00098304: 0,
    /** 0x98308: the receive buffer's real-mode segment */
    dat00098308: 0,
    /** 0x9830c: set by net_send - the next net_queue_message starts a new packet */
    dat0009830c: 0,
    /** 0x9830e: set by net_receive - the next net_next_message starts at the packet's head */
    dat0009830e: 0,
    /** 0x98314: the length of the packet being queued (a short) */
    dat00098314: 0,
    /** 0x98318: net_next_message's cursor into the received packet */
    dat00098318: 0,
    /** netSendBufferLinear (0x15297c) points here: the real-mode send buffer */
    sendBuffer: new Uint8Array(NET_BUFFER_SIZE),
    /** netRecvBufferLinear (0x152978) points here: the real-mode receive buffer */
    recvBuffer: new Uint8Array(NET_BUFFER_SIZE),
  },
  () => {
    const d = netDriver;
    d.dat00098304 = 0;
    d.dat00098308 = 0;
    d.dat0009830c = 0;
    d.dat0009830e = 0;
    d.dat00098314 = 0;
    d.dat00098318 = 0;
    d.sendBuffer = new Uint8Array(NET_BUFFER_SIZE);
    d.recvBuffer = new Uint8Array(NET_BUFFER_SIZE);
  },
);

/**
 * DPMI 0x100: the real-mode send buffer, 0x100 paragraphs. Returns the
 * segment, which netplay_init turns into a linear address.
 *
 * @mw2 net_dos_alloc_send 0x00046874
 * @fidelity partial
 * @divergence there is no real-mode memory: the buffer is a byte array and the "segment" is a token, never 0xffff
 */
export function netDosAllocSend(): number {
  netDriver.sendBuffer = new Uint8Array(NET_BUFFER_SIZE);
  netDriver.dat00098304 = 1;
  return netDriver.dat00098304;
}

/**
 * DPMI 0x100: the real-mode receive buffer.
 *
 * @mw2 net_dos_alloc_recv 0x0004689c
 * @fidelity partial
 * @divergence as net_dos_alloc_send
 */
export function netDosAllocRecv(): number {
  netDriver.recvBuffer = new Uint8Array(NET_BUFFER_SIZE);
  netDriver.dat00098308 = 2;
  return netDriver.dat00098308;
}

/**
 * DPMI 0x101: frees the send buffer. Returns 0 (0xffff on a DPMI error).
 *
 * @mw2 net_dos_free_send 0x000468c4
 * @fidelity partial
 * @divergence nothing to free; always succeeds
 */
export function netDosFreeSend(): number {
  return 0;
}

/**
 * DPMI 0x101: frees the receive buffer.
 *
 * @mw2 net_dos_free_recv 0x000468e1
 * @fidelity partial
 * @divergence nothing to free; always succeeds
 */
export function netDosFreeRecv(): number {
  return 0;
}

/**
 * INT 0x65 AX 3: this station in the high byte, the station count in the low.
 *
 * @mw2 net_station_info 0x00046966
 * @fidelity exact
 */
export function netStationInfo(): number {
  if (!transport) {
    unestablished('INT 0x65 with no network driver loaded: taken as a lone station 0 of 1', 'net_station_info');
    return 0x0001;
  }
  return ((transport.station & 0xff) << 8) | (transport.stationCount & 0xff);
}

/**
 * INT 0x65 AX 4: bit 0 set while a packet is waiting.
 *
 * @mw2 net_poll 0x0004695f
 * @fidelity exact
 */
export function netPoll(): number {
  return transport?.poll() ? 1 : 0;
}

/**
 * (length, station): sends `length` bytes of the send buffer to one
 * station, and marks the queue to restart on the next net_queue_message.
 * Returns the driver's AX - 0 when the packet was delivered.
 *
 * @mw2 net_send 0x000468fe
 * @fidelity exact
 */
export function netSend(length: number, station: number): number {
  netDriver.dat0009830c = 1;
  const n = length & 0xffff;
  if (!transport) return 1;
  if (n > NET_BUFFER_SIZE) {
    // net_queue_message's -1 (a full queue) arrives as CX 0xffff: what the driver does with it is its own
    unestablished('net_send of a length past the transfer buffer (a full queue\'s -1): taken as not delivered', 'net_send');
    return 1;
  }
  return transport.send(station & 0xff, netDriver.sendBuffer.slice(0, n)) ? 0 : 1;
}

/**
 * Takes one packet into the receive buffer: returns its length (AX) and
 * source station (DX), and marks the reader to restart.
 *
 * @mw2 net_receive 0x00046930
 * @fidelity exact
 */
export function netReceive(): { length: number; station: number } {
  netDriver.dat0009830e = 1;
  const p = transport?.receive() ?? null;
  if (!p) {
    unestablished('net_receive with nothing waiting: the driver\'s AX and DX are not established; taken as an empty packet from station 0', 'net_receive');
    return { length: 0, station: 0 };
  }
  let n = p.bytes.length;
  if (n > NET_BUFFER_SIZE) {
    divergence('a packet longer than the receive buffer is cut to it', 'net_receive');
    n = NET_BUFFER_SIZE;
  }
  netDriver.recvBuffer.set(p.bytes.subarray(0, n));
  return { length: i16(n), station: i16(p.from) };
}

/**
 * (msg, length): appends a message and the 'EOP\xff' terminator to the
 * packet being built, first starting a new packet if one was sent since.
 * Returns the packet's new length, or -1 when it would reach 256 bytes (the
 * message is then dropped).
 *
 * @mw2 net_queue_message 0x00046980
 * @fidelity exact
 * @divergence the high half of the return is the caller's ESI in the original; every caller truncates it to a short
 */
export function netQueueMessage(msg: Uint8Array, length: number): number {
  const d = netDriver;
  if (d.dat0009830c !== 0) {
    d.dat0009830c = 0;
    d.dat00098314 = 0;
  }
  const next = i16(d.dat00098314 + length + 4);
  if (next >= 0x100) return -1;
  const at = i16(d.dat00098314);
  d.sendBuffer.set(msg.subarray(0, length), at);
  d.sendBuffer.set(netMessageTerminator(), at + length);
  d.dat00098314 = next;
  return next;
}

/**
 * (packetLength): the next message of the received packet. Scans from the
 * cursor for the 'EOP\xff' terminator, zeroes it, and returns the offset in
 * the receive buffer of the message before it - or null once the packet is
 * used up (or holds no further terminator).
 *
 * @mw2 net_next_message 0x00046a10
 * @fidelity exact
 * @divergence returns an offset into the receive buffer where the original returns a linear address (0 for none)
 */
export function netNextMessage(packetLength: number): number | null {
  const d = netDriver;
  if (d.dat0009830e !== 0) {
    d.dat0009830e = 0;
    d.dat00098318 = 0;
  }
  const len = i16(packetLength);
  const start = d.dat00098318;
  if (len > 0x100 || len === 0 || len <= start || len < 4) return null;
  const term = netMessageTerminator();
  const b = d.recvBuffer;
  for (;;) {
    d.dat00098318 = (d.dat00098318 + 1) | 0;
    const c = d.dat00098318;
    if (len < c) break;
    if (c < 4) continue;
    if (b[c - 4] === term[0] && b[c - 3] === term[1] && b[c - 2] === term[2] && b[c - 1] === term[3]) {
      b.fill(0, c - 4, c);
      break;
    }
  }
  if (len + 1 === d.dat00098318) return null;
  return start;
}
