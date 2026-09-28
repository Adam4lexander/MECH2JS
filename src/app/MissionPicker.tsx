/**
 * The dev route's mission picker: every *SCN1 stream in MW2.PRJ, in three
 * groups by the loose files it includes. Launching one runs the shell's
 * handoff code (shell/devLaunch.ts) - its stars from the mission's BRF2, the
 * command line - into a scratch overlay of the disk:
 *
 *   ready      the mission fixes the player's 'Mech itself: launch
 *   star       it includes USERSTAR.BWD: pick a pilot name, a 'Mech and up
 *              to four starmates, from which the port builds that file
 *   opponents  it also includes the opponent stars (EN01..05STAR) and, for
 *              the Trials of Grievance, INSTMAP1: launch, with the BRF2 stars
 *
 * @portOnly
 */
import { useMemo, useState } from 'react';
import { mechCatalog, type MechChoice } from '../data/catalog/mechs.ts';
import { STARMATE_LIMIT, type StarSetup } from '../data/config/userStar.ts';
import type { GameData, MissionEntry } from './gameData.ts';
import { missionCatalog } from './gameData.ts';
import type { NetTransport } from '../sim/net/transport.ts';
import { NetLobby } from './net/NetLobby.tsx';

const NAME_MAX = 21;
const STORE = 'mw2.starSetup';

/** the setup as the browser remembers it: names and config keys */
interface Remembered {
  pilot: { name: string; config: string };
  starmates: { name: string; config: string }[];
}

function recall(): Remembered | null {
  try {
    const s = localStorage.getItem(STORE);
    return s ? (JSON.parse(s) as Remembered) : null;
  } catch {
    return null;
  }
}

function remember(r: Remembered): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(r));
  } catch {
    /* private window: nothing kept */
  }
}

const mechLabel = (m: MechChoice) => `${m.stream.name} ${m.config} · ${m.tons} t`;

function MechSelect({ mechs, value, onChange }: { mechs: MechChoice[]; value: string; onChange: (config: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {mechs.map((m) => (
        <option key={m.config} value={m.config}>
          {mechLabel(m)}
        </option>
      ))}
    </select>
  );
}

function StarSetupPanel({ mission, mechs, onLaunch, onCancel }: { mission: MissionEntry; mechs: MechChoice[]; onLaunch: (s: StarSetup) => void; onCancel: () => void }) {
  const fallback = mechs.find((m) => m.config === 'mdg00std')?.config ?? mechs[0]?.config ?? '';
  const known = (c: string | undefined) => (c && mechs.some((m) => m.config === c) ? c : fallback);
  const start = recall();
  const [pilot, setPilot] = useState({ name: start?.pilot.name ?? 'Pilot', config: known(start?.pilot.config) });
  const [mates, setMates] = useState((start?.starmates ?? []).slice(0, STARMATE_LIMIT).map((m) => ({ name: m.name, config: known(m.config) })));
  const byConfig = (c: string) => mechs.find((m) => m.config === c)!;
  const launch = () => {
    const r: Remembered = { pilot, starmates: mates };
    remember(r);
    onLaunch({
      pilot: { name: pilot.name.slice(0, NAME_MAX), mech: byConfig(pilot.config) },
      starmates: mates.map((m) => ({ name: m.name.slice(0, NAME_MAX), mech: byConfig(m.config) })),
    });
  };
  return (
    <div className="setup">
      <h2>{mission.stream}</h2>
      <div className="hint">The mission takes the player's star from USERSTAR.BWD, which the shell writes; the port builds it from this.</div>
      <div className="setup-row">
        <span className="setup-label">Pilot</span>
        <input autoFocus maxLength={NAME_MAX} value={pilot.name} onChange={(e) => setPilot({ ...pilot, name: e.target.value })} />
        <MechSelect mechs={mechs} value={pilot.config} onChange={(config) => setPilot({ ...pilot, config })} />
      </div>
      {mates.map((m, i) => (
        <div className="setup-row" key={i}>
          <span className="setup-label">Starmate {i + 1}</span>
          <input maxLength={NAME_MAX} value={m.name} onChange={(e) => setMates(mates.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <MechSelect mechs={mechs} value={m.config} onChange={(config) => setMates(mates.map((x, k) => (k === i ? { ...x, config } : x)))} />
          <button onClick={() => setMates(mates.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <div className="setup-row">
        {mates.length < STARMATE_LIMIT && <button onClick={() => setMates([...mates, { name: `Starmate ${mates.length + 1}`, config: pilot.config }])}>Add starmate</button>}
        <span className="setup-spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!pilot.config} onClick={launch}>
          Launch
        </button>
      </div>
    </div>
  );
}

export function MissionPicker({
  data,
  onPick,
  onNet,
}: {
  data: GameData;
  onPick: (stream: string, setup: StarSetup | null) => void;
  /** NetMech: launch `stream` as a network game on `transport` */
  onNet?: (stream: string, setup: StarSetup, transport: NetTransport) => void;
}) {
  const missions = useMemo(() => missionCatalog(data.prj), [data]);
  const mechs = useMemo(() => mechCatalog(data.prj), [data]);
  const [filter, setFilter] = useState('');
  const [setting, setSetting] = useState<MissionEntry | null>(null);
  const [netting, setNetting] = useState(false);
  const shown = missions.filter((m) => m.stream.toLowerCase().includes(filter.toLowerCase()));
  const item = (m: MissionEntry) => (
    <button
      key={m.stream}
      className="picker-item"
      title={m.needs === 'opponents' ? `the shell writes ${m.loose.join(', ')} from the mission's BRF2 stars` : undefined}
      onClick={() => (m.needs === 'star' ? setSetting(m) : onPick(m.stream, null))}
    >
      <span className="picker-name">{m.stream}</span>
      <span className="hint">
        BWD {m.id}
        {m.hasBriefing ? ' · briefing' : ''}
      </span>
    </button>
  );
  const section = (needs: MissionEntry['needs'], title: string, note: string) => {
    const list = shown.filter((m) => m.needs === needs);
    if (list.length === 0) return null;
    return (
      <section className="picker-section">
        <h2>
          {title} <span className="hint">({list.length})</span>
        </h2>
        <div className="hint">{note}</div>
        <div className="picker-list">{list.map(item)}</div>
      </section>
    );
  };
  if (netting && onNet)
    return (
      <div className="picker">
        <NetLobby data={data} onLaunch={onNet} onCancel={() => setNetting(false)} />
      </div>
    );
  if (setting)
    return (
      <div className="picker">
        <StarSetupPanel
          mission={setting}
          mechs={mechs}
          onCancel={() => setSetting(null)}
          onLaunch={(s) => {
            setSetting(null);
            onPick(setting.stream, s);
          }}
        />
      </div>
    );
  return (
    <div className="picker">
      <h1>MechWarrior 2 — choose a mission</h1>
      {onNet && (
        <div className="setup-row">
          <button onClick={() => setNetting(true)}>NetMech…</button>
          <span className="hint">a two-player network game over a WebRTC link</span>
        </div>
      )}
      <input autoFocus placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {section('ready', 'Ready', "The mission sets the player's 'Mech itself.")}
      {section('star', 'Choose pilot and ’Mech', 'The mission takes the player’s star (USERSTAR.BWD): you name the pilot and pick the ’Mech and any starmates.')}
      {section(
        'opponents',
        'Opponents',
        'These take opponent stars (EN01..EN05STAR.BWD, and for the Trials of Grievance INSTMAP1.BWD): the shell’s own code writes both stars as the mission’s briefing (BRF2) sets them, and Wolf against Jade Falcon insignia.',
      )}
    </div>
  );
}
