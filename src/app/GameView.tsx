/**
 * The mission as MW2.EXE shows it (gameScreen.ts), drawn with the settings
 * last chosen on the editor's bar - Modern, with the enhancements and the
 * hand-built cockpits, at first - with nothing over it that the game didn't
 * draw: the game's side of GameShell. With the game's headset (app/xrHost.ts)
 * it draws there, through the host's renderer.
 *
 * @portOnly
 */
import { useEffect, useRef } from 'react';
import type { Game } from './Game.ts';
import { GameScreen, recallScreenSettings } from './gameScreen.ts';
import { engineStore, useRevision } from '../editor/store/store.ts';
import type { XrHost } from './xrHost.ts';

export function GameView({ game, host }: { game: Game; host?: XrHost | null }) {
  useRevision(engineStore);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const settings = recallScreenSettings();
    const screen = new GameScreen(el.current!, game, { settings: () => settings, host: host ?? undefined });
    // debug handle: window.mw2.view.gameCamera / .renderer / .views
    const dbg = (window as unknown as { mw2?: Record<string, unknown> }).mw2;
    if (dbg) dbg.view = { gameCamera: screen.gameCamera, renderer: screen.sr, views: screen.views };
    return () => screen.dispose();
  }, [game, game.mission, host]);
  return <div className="game-view" ref={el} />;
}
