/**
 * The debriefing. In the original the shell program shows it from the
 * mw2msn.cfg record MW2.EXE leaves behind; the port shows the same record
 * (mission/end.ts) over the editor when main's loop has ended.
 *
 * @portOnly
 */
import type { Game } from './Game.ts';
import { engineStore, useRevision } from '../editor/store/store.ts';

const RESULT: Record<number, string> = { 0: 'Undecided', 2: 'Mission successful', 3: 'Mission failed', 4: 'Mission time exceeded' };
/** the category names listing/objectives.txt prints (dump_objectives) */
const CATEGORY: Record<number, string> = { 0: 'Tertiary', 1: 'Primary', 2: 'Secondary', 8: 'Return' };
/** missionEndCode (0xa564d): how the player's part ended */
const END: Record<number, string> = { 0: '', 1: 'mission ended', 2: 'ejected', 4: 'killed (ejection refused)' };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function Debrief({ game, onBack }: { game: Game; onBack: () => void }) {
  useRevision(engineStore);
  const r = game.results;
  if (!r) return null;
  const elapsed = r.decidedAt > 0 ? r.decidedAt - r.startTime : null;
  return (
    <div className="debrief">
      <div className="debrief-card">
        <h2 className={`result-${r.result}`}>{RESULT[r.result] ?? `Result ${r.result}`}</h2>
        <div className="hint">
          {game.mission}
          {elapsed !== null ? ` · decided after ${clock(elapsed)}` : ''}
          {END[r.missionEndCode] ? ` · ${END[r.missionEndCode]}` : ''}
        </div>
        <table>
          <tbody>
            {r.objectives.map((o, i) => (
              <tr key={i}>
                <td className={o.succeeded ? 'ok' : 'no'}>{o.succeeded ? 'done' : 'not done'}</td>
                <td>{CATEGORY[o.category] ?? `category ${o.category}`}</td>
                <td>{o.required ? 'required' : ''}</td>
                <td>{o.text || '(no text)'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <button onClick={() => game.loadMission(game.mission!)}>Replay</button>
          <button onClick={onBack}>Missions</button>
        </div>
      </div>
    </div>
  );
}
