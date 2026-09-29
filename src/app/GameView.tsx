/**
 * The mission as MW2.EXE shows it (gameScreen.ts), drawn with the settings
 * last chosen on the editor's bar - Modern, with the enhancements and the
 * hand-built cockpits, at first - with nothing over it that the game didn't
 * draw: the game's side of GameShell.
 *
 * @portOnly
 */
import { useEffect, useRef } from 'react';
import type { Game } from './Game.ts';
import { GameScreen, recallScreenSettings } from './gameScreen.ts';
import { engineStore, useRevision } from '../editor/store/store.ts';

export function GameView({ game }: { game: Game }) {
  useRevision(engineStore);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const settings = recallScreenSettings();
    const screen = new GameScreen(host.current!, game, { settings: () => settings });
    // debug handle: window.mw2.view.gameCamera / .renderer / .views
    const dbg = (window as unknown as { mw2?: Record<string, unknown> }).mw2;
    if (dbg) dbg.view = { gameCamera: screen.gameCamera, renderer: screen.sr, views: screen.views };
    return () => screen.dispose();
  }, [game, game.mission]);
  return <div className="game-view" ref={host} />;
}
