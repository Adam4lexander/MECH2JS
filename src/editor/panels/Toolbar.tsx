/**
 * Mode and time controls. Edit: no frame runs and the timer is not fed, so
 * simTick stands still. Play: main's loop, one pass per display frame, fed
 * real time. Step: one pass in the clock's own fixed-step mode (+12 ticks).
 *
 * @portOnly
 */
import { LOOP_RATES, type Game } from '../../app/Game.ts';
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
      <select
        title="Loop rate: passes of main's loop a second in Play. The original ran as fast as its PC allowed (about 15-25); several movement terms act once per pass, so the display rate (one pass a frame) moves differently"
        value={game.loopRate ?? 'display'}
        onChange={(e) => game.setLoopRate(e.target.value === 'display' ? null : Number(e.target.value))}
      >
        {LOOP_RATES.map((r) => (
          <option key={r ?? 'display'} value={r ?? 'display'}>
            {r === null ? 'display rate' : `${r} fps`}
          </option>
        ))}
      </select>
      <button
        className={game.audio.enabled ? 'active' : ''}
        title="Sound: the game's mixer, voice and engine note, and the CD music from the install's CD image"
        onClick={() => {
          game.audio.toggle();
          engineStore.bump();
        }}
      >
        {game.audio.enabled ? '🔊 Sound' : '🔈 Sound off'}
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
