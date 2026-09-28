// The INT 0x65 glue's message framing (net_queue_message / net_next_message)
// over the in-memory driver: what the original puts on the wire, byte for
// byte, and how its reader walks a packet.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAllGlobals } from '../../src/engine/globals.ts';
import { MemoryNetHub } from '../../src/sim/net/memoryTransport.ts';
import { netDriver, netNextMessage, netPoll, netQueueMessage, netReceive, netSend, netStationInfo, setNetTransport } from '../../src/sim/net/transport.ts';

const EOP = [0x45, 0x4f, 0x50, 0xff];
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('net driver glue', () => {
  let hub: MemoryNetHub;
  beforeEach(() => {
    resetAllGlobals();
    hub = new MemoryNetHub(3);
  });
  afterEach(() => setNetTransport(null));

  it('net_station_info: station in the high byte, count in the low', () => {
    setNetTransport(hub.stations[2]!);
    expect(netStationInfo()).toBe(0x0203);
  });

  it('queues messages each with its terminator, and sends them as one packet', () => {
    setNetTransport(hub.stations[0]!);
    expect(netQueueMessage(bytes('SI'), 2)).toBe(6);
    expect(netQueueMessage(bytes('SNxyz'), 5)).toBe(15);
    expect(netSend(15, 1)).toBe(0);
    expect(hub.stations[1]!.waiting).toBe(1);
    // a send restarts the queue for the next message
    expect(netQueueMessage(bytes('SS'), 2)).toBe(6);
    setNetTransport(hub.stations[1]!);
    expect(netPoll() & 1).toBe(1);
    const r = netReceive();
    expect(r).toEqual({ length: 15, station: 0 });
    expect(Array.from(netDriver.recvBuffer.subarray(0, 15))).toEqual([...bytes('SI'), ...EOP, ...bytes('SNxyz'), ...EOP]);
    expect(netPoll() & 1).toBe(0);
  });

  it('net_next_message: each message in turn, its terminator zeroed, then none', () => {
    setNetTransport(hub.stations[0]!);
    netQueueMessage(bytes('DAab'), 4);
    const len = netQueueMessage(bytes('SS'), 2);
    netSend(len, 2);
    setNetTransport(hub.stations[2]!);
    const r = netReceive();
    expect(netNextMessage(r.length)).toBe(0);
    expect(Array.from(netDriver.recvBuffer.subarray(4, 8))).toEqual([0, 0, 0, 0]);
    expect(netNextMessage(r.length)).toBe(8);
    expect(netNextMessage(r.length)).toBeNull();
  });

  it('a message with no terminator after it is not returned', () => {
    setNetTransport(hub.stations[1]!);
    hub.stations[1]!.deliver(0, Uint8Array.from([...bytes('SI'), ...EOP, ...bytes('DAxx')]));
    const r = netReceive();
    expect(netNextMessage(r.length)).toBe(0);
    expect(netNextMessage(r.length)).toBeNull();
  });

  it('a queue that would reach 256 bytes refuses the message (-1) and keeps what it had', () => {
    setNetTransport(hub.stations[0]!);
    const big = new Uint8Array(0x48);
    expect(netQueueMessage(big, 0x48)).toBe(0x4c);
    expect(netQueueMessage(big, 0x48)).toBe(0x98);
    expect(netQueueMessage(big, 0x48)).toBe(0xe4);
    expect(netQueueMessage(big, 0x48)).toBe(-1);
    expect(netDriver.dat00098314).toBe(0xe4);
  });

  it('with no driver loaded a -N run is a lone station', () => {
    expect(netStationInfo()).toBe(0x0001);
    expect(netPoll()).toBe(0);
    expect(netSend(6, 1)).not.toBe(0);
  });
});
