/**
 * The dev route's NetMech lobby: two browsers (or two tabs) link by pasting
 * an offer and an answer between them, each names a pilot and picks a 'Mech,
 * the host picks the mission, and both launch MW2.EXE as NETDEMO.EXE did -
 * `MW2 -n -g=NETWAIT <mission>` - the host as station 0 (mechTable[0], the
 * star's pilot) and the joiner as station 1 (mechTable[1], its starmate).
 * NETDEMO's own screens and its mission list are out of scope; the three
 * missions it offered for network play are listed first.
 *
 * @portOnly
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { mechCatalog, type MechChoice } from '../../data/catalog/mechs.ts';
import type { StarSetup } from '../../data/config/userStar.ts';
import type { NetTransport } from '../../sim/net/transport.ts';
import type { GameData } from '../gameData.ts';
import { missionCatalog } from '../gameData.ts';
import { WebRtcLink, type LobbyMessage } from './webrtcLink.ts';

/** NETDEMO.EXE's network missions (its table at 0x555e8, with the names it shows). */
const NET_MISSIONS: ReadonlyArray<{ stream: string; title: string }> = [
  { stream: 'BRO2SCN1', title: 'Desert Engagement' },
  { stream: 'FUC2SCN1', title: 'Fire and Ice' },
  { stream: 'CIN2SCN1', title: 'Arena Assault' },
];

const NAME_MAX = 21;

type Stage = { kind: 'choose' } | { kind: 'hosting'; offer: string } | { kind: 'joining'; answer: string | null } | { kind: 'linked' };

export function NetLobby({
  data,
  onLaunch,
  onCancel,
}: {
  data: GameData;
  onLaunch: (stream: string, setup: StarSetup, transport: NetTransport) => void;
  onCancel: () => void;
}) {
  const mechs = useMemo(() => mechCatalog(data.prj), [data]);
  const streams = useMemo(() => {
    const all = missionCatalog(data.prj).map((m) => m.stream);
    const first = NET_MISSIONS.map((m) => m.stream).filter((s) => all.includes(s));
    return [...first, ...all.filter((s) => !first.includes(s))];
  }, [data]);
  const fallback = mechs.find((m) => m.config === 'mdg00std')?.config ?? mechs[0]?.config ?? '';
  const [name, setName] = useState('Player');
  const [config, setConfig] = useState(fallback);
  const [stream, setStream] = useState(streams[0] ?? '');
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [paste, setPaste] = useState('');
  const [status, setStatus] = useState('');
  const [peer, setPeer] = useState<{ name: string; config: string } | null>(null);
  const [station, setStation] = useState(0);
  const link = useRef<WebRtcLink | null>(null);
  const stationRef = useRef(0);
  const launched = useRef(false);
  const me = useRef({ name, config });
  useEffect(() => {
    me.current = { name: name.slice(0, NAME_MAX), config };
  }, [name, config]);

  const byConfig = (c: string): MechChoice => mechs.find((m) => m.config === c) ?? mechs.find((m) => m.config === fallback)!;

  const launch = (m: Extract<LobbyMessage, { kind: 'launch' }>) => {
    const setup: StarSetup = {
      pilot: { name: m.pilot.name, mech: byConfig(m.pilot.config) },
      starmates: [{ name: m.starmate.name, mech: byConfig(m.starmate.config) }],
    };
    launched.current = true;
    onLaunch(m.stream, setup, link.current!.transport(stationRef.current));
  };

  const wire = (l: WebRtcLink) => {
    link.current = l;
    l.onState = (s) => {
      setStatus(s);
      if (s === 'open') {
        setStage({ kind: 'linked' });
        if (stationRef.current === 1) l.sendLobby({ kind: 'hello', ...me.current });
      }
    };
    l.onLobby = (m) => {
      if (m.kind === 'hello') setPeer({ name: m.name, config: m.config });
      else if (m.kind === 'launch') launch(m);
    };
  };

  useEffect(
    () => () => {
      // leaving the lobby without launching drops the link; a launched game keeps it
      if (link.current && !launched.current) link.current.close();
    },
    [],
  );

  const host = async () => {
    stationRef.current = 0;
    setStation(0);
    setStatus('gathering candidates');
    const { link: l, offer } = await WebRtcLink.host();
    wire(l);
    setStage({ kind: 'hosting', offer });
    setStatus('copy the offer to the other side, then paste its answer');
  };

  const join = async () => {
    stationRef.current = 1;
    setStation(1);
    setStatus('gathering candidates');
    try {
      const { link: l, answer } = await WebRtcLink.join(paste);
      wire(l);
      setStage({ kind: 'joining', answer });
      setPaste('');
      setStatus('copy the answer back to the host');
    } catch (e) {
      setStatus(`not an offer: ${String(e)}`);
    }
  };

  const accept = async () => {
    try {
      await link.current!.accept(paste);
      setStatus('connecting');
    } catch (e) {
      setStatus(`not an answer: ${String(e)}`);
    }
  };

  const hostLaunch = () => {
    if (!peer) return;
    const m: Extract<LobbyMessage, { kind: 'launch' }> = { kind: 'launch', stream, pilot: me.current, starmate: peer };
    link.current!.sendLobby(m);
    launch(m);
  };

  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  return (
    <div className="setup">
      <h2>NetMech</h2>
      <div className="hint">
        Two browsers link by exchanging an offer and an answer (copy and paste; no server). The host is station 0 and drives the star's pilot, the joiner station 1 and its starmate. Use two windows side by side, not two tabs of one window: a hidden tab stops its game.
      </div>
      <div className="setup-row">
        <span className="setup-label">Pilot</span>
        <input maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} disabled={stage.kind === 'linked'} />
        <select value={config} onChange={(e) => setConfig(e.target.value)} disabled={stage.kind === 'linked'}>
          {mechs.map((m) => (
            <option key={m.config} value={m.config}>
              {m.stream.name} {m.config} · {m.tons} t
            </option>
          ))}
        </select>
      </div>
      {stage.kind === 'choose' && (
        <>
          <div className="setup-row">
            <button className="primary" onClick={() => void host()}>
              Host
            </button>
            <span className="setup-spacer" />
          </div>
          <div className="setup-row">
            <textarea rows={3} style={{ flex: 1 }} placeholder="or paste the host's offer here" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button disabled={paste.trim() === ''} onClick={() => void join()}>
              Join
            </button>
          </div>
        </>
      )}
      {stage.kind === 'hosting' && (
        <>
          <div className="setup-row">
            <textarea rows={3} style={{ flex: 1 }} readOnly value={stage.offer} onFocus={(e) => e.target.select()} />
            <button onClick={() => copy(stage.offer)}>Copy offer</button>
          </div>
          <div className="setup-row">
            <textarea rows={3} style={{ flex: 1 }} placeholder="paste the joiner's answer here" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button disabled={paste.trim() === ''} onClick={() => void accept()}>
              Connect
            </button>
          </div>
        </>
      )}
      {stage.kind === 'joining' && stage.answer && (
        <div className="setup-row">
          <textarea rows={3} style={{ flex: 1 }} readOnly value={stage.answer} onFocus={(e) => e.target.select()} />
          <button onClick={() => copy(stage.answer!)}>Copy answer</button>
        </div>
      )}
      {stage.kind === 'linked' && station === 0 && (
        <div className="setup-row">
          <span className="setup-label">Mission</span>
          <select value={stream} onChange={(e) => setStream(e.target.value)}>
            {streams.map((s) => (
              <option key={s} value={s}>
                {s}
                {NET_MISSIONS.find((m) => m.stream === s) ? ` - ${NET_MISSIONS.find((m) => m.stream === s)!.title}` : ''}
              </option>
            ))}
          </select>
          <span className="hint">{peer ? `opponent: ${peer.name} (${peer.config})` : 'waiting for the joiner'}</span>
          <span className="setup-spacer" />
          <button className="primary" disabled={!peer} onClick={hostLaunch}>
            Launch
          </button>
        </div>
      )}
      {stage.kind === 'linked' && station === 1 && <div className="hint">Linked: the host picks the mission and launches both.</div>}
      <div className="setup-row">
        <span className="hint">{status}</span>
        <span className="setup-spacer" />
        <button onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}
