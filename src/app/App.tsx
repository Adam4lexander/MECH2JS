import { useCallback, useEffect, useState } from 'react';
import { installConsoleSinks } from '../editor/store/consoleLog.ts';
import { globalGroups } from '../engine/globals.ts';
import { EditorRoot } from '../editor/EditorRoot.tsx';
import { Game } from './Game.ts';
import { type GameData, loadGameData } from './gameData.ts';
import { MissionPicker } from './MissionPicker.tsx';
import { attachDiskStore } from './diskStore.ts';
import { setDosFiles } from '../engine/dosFiles.ts';
import { seedControlFiles } from '../shell/controls/seed.ts';
import { simOptionsFileEnsure } from '../sim/mech/simOptions.ts';
import { soundConfigFileEnsure } from '../sim/sound/soundConfigFile.ts';
import { GameShell } from './GameShell.tsx';
import { serverInstall } from './fetchSource.ts';
import { DroppedInstall } from './droppedInstall.ts';
import { InstallDrop } from './InstallDrop.tsx';
import type { InstallSource } from '../data/source/FileSource.ts';

/** The developer's route: the mission picker and the editor (?dev in the address). */
const DEV = new URLSearchParams(window.location.search).has('dev');

/**
 * The port's own files on a first run. MW2DIF.CFG (the rule options) and
 * MW2SND.CFG (sound and detail) start as the shell's own defaults - the
 * simOptions and soundConfig its image holds, which its options panel would
 * write (sim/mech/simOptions.ts, sim/sound/soundConfigFile.ts) - so neither
 * program meets a missing file. The
 * controls files (INPUT.MAP, GAMEKEY.MAP, giddi\*.cpc) are the ported
 * controls screen's output and the port's own defaults (shell/controls/seed.ts),
 * which need the GIDDI drivers on the disk.
 */
function seedOwnFiles(d: GameData): void {
  simOptionsFileEnsure();
  soundConfigFileEnsure();
  setDosFiles(d.loose);
  seedControlFiles(d.shellExe);
}

installConsoleSinks();

// Debug handle for the browser console: every registered global group by name.
(window as unknown as { mw2: unknown }).mw2 = {
  get viewer() {
    return Object.fromEntries(globalGroups('mw2').map((g) => [g.name, g.state])).camera;
  },
  get globals() {
    return Object.fromEntries(globalGroups('mw2').map((g) => [g.name, g.state]));
  },
};

export function App() {
  // where the install comes from: the dev server's (MW2_ROOT), or - with none - a folder the player drops
  const [install, setInstall] = useState<InstallSource | null>(null);
  const [asking, setAsking] = useState(false);
  const [dropFailed, setDropFailed] = useState<string | null>(null);
  const [data, setData] = useState<GameData | null>(null);
  const [status, setStatus] = useState('starting');
  const [failed, setFailed] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [inMission, setInMission] = useState(false);

  useEffect(() => {
    let live = true;
    void serverInstall().then((s) => {
      if (!live) return;
      if (s) setInstall(s);
      else setAsking(true);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!install) return;
    loadGameData(install, (m) => setStatus(`loading ${m}`))
      .then(async (d) => {
        setStatus('restoring your files');
        await attachDiskStore();
        seedOwnFiles(d);
        setData(d);
        setGame(new Game(d));
      })
      .catch((e: unknown) => {
        if (!(install instanceof DroppedInstall)) return setFailed(String(e));
        // a dropped folder that would not load: back to the drop, saying why
        setDropFailed(`${install.name} could not be loaded: ${String(e)}`);
        setInstall(null);
      });
  }, [install]);

  const onDropped = useCallback((i: DroppedInstall) => {
    setDropFailed(null);
    setInstall(i);
  }, []);

  if (failed)
    return (
      <div className="boot error">
        Could not load the game data: {failed}
        <div className="hint">The dev server serves the game from MW2_ROOT (.env.local): check it is your install, the directory holding MW2.PRJ, and restart the dev server.</div>
      </div>
    );
  if (!install && asking) return <InstallDrop key={dropFailed ?? ''} onInstall={onDropped} error={dropFailed} />;
  if (!data || !game) return <div className="boot">{status}…</div>;
  // The game, as MECH2 runs it; ?dev opens the mission picker and the editor instead.
  if (!DEV) return <GameShell data={data} game={game} />;
  if (!inMission)
    return (
      <MissionPicker
        data={data}
        onPick={(stream, setup) => {
          game.loadMission(stream, setup);
          setInMission(true);
        }}
        onNet={(stream, setup, transport) => {
          game.loadNetMission(stream, setup, transport);
          setInMission(true);
        }}
      />
    );
  return <EditorRoot game={game} onBack={() => setInMission(false)} />;
}
