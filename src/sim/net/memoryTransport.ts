/**
 * Network drivers that live in memory: a queue per station, for tests and
 * for relays (a worker or child process per station, the parent carrying
 * packets between them).
 */
import type { NetPacket, NetTransport } from './transport.ts';

/**
 * One station's driver: packets it sends go to `onSend`; packets for it are
 * handed in with deliver() and taken, in order, by receive().
 *
 * @portOnly a NetTransport for tests and relays
 */
export class QueueTransport implements NetTransport {
  private readonly inbox: NetPacket[] = [];

  constructor(
    readonly station: number,
    readonly stationCount: number,
    private readonly onSend: (to: number, bytes: Uint8Array) => boolean,
  ) {}

  poll(): boolean {
    return this.inbox.length > 0;
  }

  send(to: number, bytes: Uint8Array): boolean {
    if (to < 0 || to >= this.stationCount || to === this.station) return false;
    return this.onSend(to, bytes.slice());
  }

  receive(): NetPacket | null {
    return this.inbox.shift() ?? null;
  }

  /** A packet arrives from station `from`. */
  deliver(from: number, bytes: Uint8Array): void {
    this.inbox.push({ from, bytes: bytes.slice() });
  }

  /** Packets waiting. */
  get waiting(): number {
    return this.inbox.length;
  }
}

/**
 * `stationCount` stations joined in one process: every packet sent is at
 * once waiting at its destination. (One process holds one MW2.EXE's globals,
 * so a hub serves tests of the driver glue, not two running games.)
 *
 * @portOnly a NetTransport for tests
 */
export class MemoryNetHub {
  readonly stations: QueueTransport[];

  constructor(readonly stationCount: number) {
    this.stations = Array.from(
      { length: stationCount },
      (_, s) =>
        new QueueTransport(s, stationCount, (to, bytes) => {
          this.stations[to]!.deliver(s, bytes);
          return true;
        }),
    );
  }
}
