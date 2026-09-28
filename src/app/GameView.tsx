/**
 * The mission as MW2.EXE shows it (gameScreen.ts), Faithful, with nothing
 * over it that the game didn't draw - the game's side of GameShell.
 *
 * @portOnly
 */
import { useEffect, useRef } from 'react';
import type { Game } from './Game.ts';
import { GameScreen } from './gameScreen.ts';
import { engineStore, useRevision } from '../editor/store/store.ts';

export function GameView({ game }: { game: Game }) {
  useRevision(engineStore);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const screen = new GameScreen(host.current!, game);
    // debug handle: window.mw2.view.gameCamera / .renderer / .views
    const dbg = (window as unknown as { mw2?: Record<string, unknown> }).mw2;
    if (dbg) dbg.view = { gameCamera: screen.gameCamera, renderer: screen.sr, views: screen.views };
    return () => screen.dispose();
  }, [game, game.mission]);
  return <div className="game-view" ref={host} />;
}
