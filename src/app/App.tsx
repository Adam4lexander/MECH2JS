import { useEffect, useState } from 'react';
import { installConsoleSinks } from '../editor/store/consoleLog.ts';
import { globalGroups } from '../engine/globals.ts';
import { EditorRoot } from '../editor/EditorRoot.tsx';
import { Game } from './Game.ts';
import { type GameData, loadGameData } from './gameData.ts';
import { MissionPicker } from './MissionPicker.tsx';

installConsoleSinks();

// Debug handle for the browser console: every registered global group by name.
(window as unknown as { mw2: unknown }).mw2 = {
  get viewer() {
    return Object.fromEntries(globalGroups().map((g) => [g.name, g.state])).camera;
  },
  get globals() {
    return Object.fromEntries(globalGroups().map((g) => [g.name, g.state]));
  },
};

export function App() {
  const [data, setData] = useState<GameData | null>(null);
  const [status, setStatus] = useState('starting');
  const [failed, setFailed] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [inMission, setInMission] = useState(false);

  useEffect(() => {
    loadGameData((m) => setStatus(`loading ${m}`))
      .then((d) => {
        setData(d);
        setGame(new Game(d));
      })
      .catch((e: unknown) => setFailed(String(e)));
  }, []);

  if (failed)
    return (
      <div className="boot error">
        Could not load the game data: {failed}
        <div className="hint">The dev server serves MW2.PRJ and MW2.EXE from MW2_ROOT (default: the directory above port/).</div>
      </div>
    );
  if (!data || !game) return <div className="boot">{status}…</div>;
  if (!inMission)
    return (
      <MissionPicker
        data={data}
        onPick={(stream, setup) => {
          game.loadMission(stream, setup);
          setInMission(true);
        }}
      />
    );
  return <EditorRoot game={game} onBack={() => setInMission(false)} />;
}
