/**
 * A two-station NetMech link over a WebRTC data channel (reliable, ordered),
 * signalled by hand: the host's offer and the joiner's answer are pasted
 * between the two browsers as text - no server. ICE gathering is completed
 * before the text is shown, so each text carries every candidate. With no
 * STUN server only host candidates exist: two tabs on one machine, or two
 * machines on one LAN.
 *
 * The channel carries two kinds of frame, told apart by their first byte:
 * 0 the lobby's own messages (JSON), 1 a packet of the game's (INT 0x65
 * AX 5 on one side, AX 6 on the other).
 *
 * @portOnly the port's network driver (the original's were NETB2, COMIO and MODEM)
 */
import type { NetPacket, NetTransport } from '../../sim/net/transport.ts';

const FRAME_LOBBY = 0;
const FRAME_GAME = 1;

/** What the lobby says to the other side. */
export type LobbyMessage =
  | { kind: 'hello'; name: string; config: string }
  | { kind: 'launch'; stream: string; pilot: { name: string; config: string }; starmate: { name: string; config: string } };

function encodeSignal(d: RTCSessionDescriptionInit): string {
  return btoa(JSON.stringify({ type: d.type, sdp: d.sdp }));
}

function decodeSignal(text: string): RTCSessionDescriptionInit {
  const d = JSON.parse(atob(text.trim())) as RTCSessionDescriptionInit;
  if ((d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string') throw new Error('not an offer or answer');
  return d;
}

/** Resolves once ICE gathering has finished (or after 5 s with what there is). */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 5000);
  });
}

export class WebRtcLink {
  private channel: RTCDataChannel | null = null;
  private readonly inbox: Uint8Array[] = [];
  /** the lobby's messages from the other side */
  onLobby: ((m: LobbyMessage) => void) | null = null;
  /** the channel's state changes: 'open', 'closed' */
  onState: ((state: string) => void) | null = null;

  private constructor(private readonly pc: RTCPeerConnection) {
    pc.addEventListener('connectionstatechange', () => this.onState?.(pc.connectionState));
  }

  /** Station 0: makes the offer text to hand the other side. */
  static async host(): Promise<{ link: WebRtcLink; offer: string }> {
    const link = new WebRtcLink(new RTCPeerConnection({ iceServers: [] }));
    link.attach(link.pc.createDataChannel('netmech', { ordered: true }));
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await gathered(link.pc);
    return { link, offer: encodeSignal(link.pc.localDescription!) };
  }

  /** Station 1: takes the host's offer text and makes the answer text to hand back. */
  static async join(offer: string): Promise<{ link: WebRtcLink; answer: string }> {
    const link = new WebRtcLink(new RTCPeerConnection({ iceServers: [] }));
    link.pc.addEventListener('datachannel', (e) => link.attach(e.channel));
    await link.pc.setRemoteDescription(decodeSignal(offer));
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    await gathered(link.pc);
    return { link, answer: encodeSignal(link.pc.localDescription!) };
  }

  /** The host takes the joiner's answer text. */
  async accept(answer: string): Promise<void> {
    await this.pc.setRemoteDescription(decodeSignal(answer));
  }

  get open(): boolean {
    return this.channel?.readyState === 'open';
  }

  private attach(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.binaryType = 'arraybuffer';
    ch.addEventListener('open', () => this.onState?.('open'));
    ch.addEventListener('close', () => this.onState?.('closed'));
    ch.addEventListener('message', (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === 'string') return;
      const b = new Uint8Array(e.data);
      if (b[0] === FRAME_GAME) this.inbox.push(b.slice(1));
      else if (b[0] === FRAME_LOBBY) this.onLobby?.(JSON.parse(new TextDecoder().decode(b.subarray(1))) as LobbyMessage);
    });
  }

  sendLobby(m: LobbyMessage): void {
    const text = new TextEncoder().encode(JSON.stringify(m));
    const f = new Uint8Array(text.length + 1);
    f[0] = FRAME_LOBBY;
    f.set(text, 1);
    this.channel?.send(f);
  }

  /** The INT 0x65 driver for this side: station 0 (host) or 1 (joiner) of two. */
  transport(station: number): NetTransport {
    const peer = 1 - station;
    return {
      station,
      stationCount: 2,
      poll: () => this.inbox.length > 0,
      send: (to: number, bytes: Uint8Array): boolean => {
        if (to !== peer || !this.channel || this.channel.readyState !== 'open') return false;
        const f = new Uint8Array(bytes.length + 1);
        f[0] = FRAME_GAME;
        f.set(bytes, 1);
        this.channel.send(f);
        return true;
      },
      receive: (): NetPacket | null => {
        const b = this.inbox.shift();
        return b ? { from: peer, bytes: b } : null;
      },
    };
  }

  close(): void {
    this.channel?.close();
    this.pc.close();
  }
}
