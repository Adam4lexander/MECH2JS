/**
 * Choosing a mission: every *SCN1 stream in MW2.PRJ.
 *
 * @portOnly
 */
import { useMemo, useState } from 'react';
import type { GameData } from './gameData.ts';
import { missionCatalog } from './gameData.ts';

export function MissionPicker({ data, onPick }: { data: GameData; onPick: (stream: string) => void }) {
  const missions = useMemo(() => missionCatalog(data.prj), [data]);
  const [filter, setFilter] = useState('');
  const shown = missions.filter((m) => m.stream.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="picker">
      <h1>MechWarrior 2 — choose a mission</h1>
      <div className="hint">
        {missions.length} mission streams (…SCN1) in MW2.PRJ. The player's star comes from USERSTAR.BWD as the shell left it.
      </div>
      <input autoFocus placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="picker-list">
        {shown.map((m) => (
          <button key={m.stream} className="picker-item" onClick={() => onPick(m.stream)}>
            <span className="picker-name">{m.stream}</span>
            <span className="hint">
              BWD {m.id}
              {m.hasBriefing ? ' · briefing' : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
