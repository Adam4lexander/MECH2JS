/**
 * Mode and time controls. Edit is the original's pause (timer_set_paused):
 * simTick stands still. Play and Step run the frame loop, which Phase 2
 * ports; until then they are disabled and say so.
 *
 * @portOnly
 */
import type { Game } from '../../app/Game.ts';
import { clock } from '../../engine/clock.ts';
import { mechs } from '../../sim/mech/mechGlobals.ts';
import { world } from '../../sim/world/worldRecords.ts';
import { engineStore, useRevision } from '../store/store.ts';

export function Toolbar({ game, onBack }: { game: Game; onBack: () => void }) {
  useRevision(engineStore);
  const loopReady = false; // Phase 2: engine frame loop
  return (
    <div className="toolbar">
      <button onClick={onBack}>◂ Missions</button>
      <span className="tb-mission">{game.mission}</span>
      <span className="tb-sep" />
      <button className={game.mode === 'edit' ? 'active' : ''} onClick={() => game.setMode('edit')} title="Edit: the game's own pause - time stands still">
        ❚❚ Edit
      </button>
      <button disabled={!loopReady} className={game.mode === 'play' ? 'active' : ''} title="Play: runs the original frame loop (Phase 2)" onClick={() => game.setMode('play')}>
        ▶ Play
      </button>
      <button disabled={!loopReady} title="Step: one frame of the original loop (Phase 2)">
        ▷| Step
      </button>
      <span className="tb-sep" />
      <span className="tb-stat">simTick {clock.simTick}</span>
      <span className="tb-stat">mechs {mechs.mechCount}</span>
      <span className="tb-stat">world records {world.worldObjectCount}</span>
      {game.loadError ? <span className="tb-error" title={game.loadError}>load error - see console</span> : null}
    </div>
  );
}
