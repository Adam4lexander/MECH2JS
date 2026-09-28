/**
 * The game as MECH2.EXE runs it: the front end (MW2SHELL.EXE, on its
 * 640x480 screen) and the missions (MW2.EXE, in the game's view) in turn,
 * through the files they leave each other (launcher/mech2.ts). A click
 * first, so the browser lets the sound start.
 *
 * @portOnly the host of MECH2's loop
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Game } from './Game.ts';
import type { GameData } from './gameData.ts';
import { ShellView } from './shell/ShellView.tsx';
import { LaunchView } from './shell/LaunchView.tsx';
import { mountCd } from './shell/cdDrive.ts';
import { attachShellAudio } from './shell/shellAudio.ts';
import { GameView } from './GameView.tsx';
import { mech2Main } from '../launcher/mech2.ts';
import { splitCommandTail } from '../mission/commandLine.ts';
import { startShellProcess } from '../shell/boot.ts';
import { shellMain } from '../shell/main.ts';
import { ShellPump } from '../shell/host/pump.ts';
import { setOverlayFiles } from '../engine/dosFiles.ts';
import { hardware } from '../shell/host/hardware.ts';

// Debug handle for the browser console: the front end's PC.
(window as unknown as { mw2shell: unknown }).mw2shell = { hardware };

type Showing = { kind: 'start' } | { kind: 'launch'; done: () => void } | { kind: 'shell'; pump: ShellPump; done: (status: number) => void } | { kind: 'sim' } | { kind: 'quit' };

export function GameShell({ data, game }: { data: GameData; game: Game }) {
  const [showing, setShowing] = useState<Showing>({ kind: 'start' });
  const started = useRef(false);

  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setOverlayFiles(null);
    console.info('[shell] mounting the CD');
    await mountCd(data.cd);
    console.info('[shell] sound');
    await attachShellAudio(game);
    console.info('[shell] starting');
    await mech2Main(
      {
        shell: (arg) =>
          new Promise<number>((done) => {
            startShellProcess(data.shellExe, data.prj);
            const pump = new ShellPump(shellMain(['mw2shell.exe', arg]));
            (window as unknown as { mw2shell: { pump?: ShellPump } }).mw2shell.pump = pump;
            setShowing({ kind: 'shell', pump, done });
          }),
        sim: (argv) =>
          new Promise<number>((done) => {
            game.onMissionEnd = (r) => {
              game.onMissionEnd = null;
              done(r.exitStatus);
            };
            void game.launchStart(argv).then((finish) => {
              if (!finish) {
                game.onMissionEnd = null;
                done(0);
                return;
              }
              setShowing({
                kind: 'launch',
                done: () => {
                  setShowing({ kind: 'sim' });
                  if (!game.launchFinish(finish) && game.loadError) {
                    game.onMissionEnd = null;
                    done(0);
                  }
                },
              });
            });
          }),
      },
      splitCommandTail,
    );
    setShowing({ kind: 'quit' });
  }, [data, game]);

  const onShellExit = useCallback(
    (status: number) => {
      if (showing.kind === 'shell') showing.done(status);
    },
    [showing],
  );

  useEffect(() => {
    // leaving the page mid-game is a power cut: the files already on the disk are what survives
  }, []);

  if (showing.kind === 'start')
    return (
      <div
        className="shell-start"
        onClick={() =>
          start().catch((e: unknown) => {
            console.error('[shell] start-up failed', e);
            setShowing({ kind: 'quit' });
          })
        }
      >
        <div>MechWarrior 2</div>
        <div className="hint">Click to start</div>
      </div>
    );
  if (showing.kind === 'shell') return <div className="shell-frame"><ShellView pump={showing.pump} onExit={onShellExit} /></div>;
  if (showing.kind === 'launch') return <div className="shell-frame"><LaunchView onDone={showing.done} /></div>;
  if (showing.kind === 'sim') return <div className="play-frame"><GameView game={game} /></div>;
  return (
    <div className="shell-start">
      <div>MechWarrior 2: 31st Century Combat</div>
      <div className="hint">Copyright (C) 1995, Activision Studios, Inc., All Rights Reserved.</div>
      <div className="hint">
        <a href="./">Play again</a>
      </div>
    </div>
  );
}
