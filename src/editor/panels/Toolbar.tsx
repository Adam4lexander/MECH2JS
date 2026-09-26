/**
 * Mode and time controls. Edit: no frame runs and the timer is not fed, so
 * simTick stands still. Play: main's loop, one pass per display frame, fed
 * real time. Step: one pass in the clock's own fixed-step mode (+12 ticks).
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
  return (
    <div className="toolbar">
      <button onClick={onBack}>◂ Missions</button>
      <span className="tb-mission">{game.mission}</span>
      <span className="tb-sep" />
      <button className={game.mode === 'edit' ? 'active' : ''} onClick={() => game.setMode('edit')} title="Edit: the game's own pause - time stands still">
        ❚❚ Edit
      </button>
      <button className={game.mode === 'play' ? 'active' : ''} title="Play: runs main's frame loop in real time; the keyboard and mouse go to the game" onClick={() => game.setMode('play')}>
        ▶ Play
      </button>
      <button title="Step: one pass of main's loop in the clock's fixed-step mode (12 ticks)" onClick={() => game.step()}>
        ▷| Step
      </button>
      <span className="tb-sep" />
      <span className="tb-stat">simTick {clock.simTick}</span>
      <span className="tb-stat">tickDelta {clock.tickDelta}</span>
      <span className="tb-stat">mechs {mechs.mechCount}</span>
      <span className="tb-stat">world records {world.worldObjectCount}</span>
      {game.loadError ? <span className="tb-error" title={game.loadError}>load error - see console</span> : null}
    </div>
  );
}
