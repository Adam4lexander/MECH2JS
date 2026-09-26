/**
 * The editor: toolbar on top; hierarchy | viewport | inspector; console and
 * asset browser below.
 *
 * @portOnly
 */
import { useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { Game } from '../app/Game.ts';
import { Hierarchy } from './panels/Hierarchy.tsx';
import { Inspector } from './panels/Inspector.tsx';
import { Console } from './panels/Console.tsx';
import { AssetBrowser } from './panels/AssetBrowser.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { Viewport } from './panels/Viewport.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { Debrief } from '../app/Debrief.tsx';

export function EditorRoot({ game, onBack }: { game: Game; onBack: () => void }) {
  const [bottom, setBottom] = useState<'console' | 'assets'>('console');
  return (
    <div className="editor">
      <Toolbar game={game} onBack={onBack} />
      <Debrief game={game} onBack={onBack} />
      <Group orientation="vertical" className="editor-main">
        <Panel defaultSize="68" minSize="20">
          <Group orientation="horizontal">
            <Panel defaultSize="20" minSize="10" className="panel">
              <div className="panel-title">Hierarchy</div>
              <ErrorBoundary name="Hierarchy"><Hierarchy /></ErrorBoundary>
            </Panel>
            <Separator className="sep-v" />
            <Panel defaultSize="55" minSize="20" className="panel">
              <ErrorBoundary name="Viewport"><Viewport game={game} /></ErrorBoundary>
            </Panel>
            <Separator className="sep-v" />
            <Panel defaultSize="25" minSize="10" className="panel">
              <div className="panel-title">Inspector</div>
              <ErrorBoundary name="Inspector"><Inspector /></ErrorBoundary>
            </Panel>
          </Group>
        </Panel>
        <Separator className="sep-h" />
        <Panel defaultSize="32" minSize="8" className="panel">
          <div className="panel-tabs">
            <button className={bottom === 'console' ? 'active' : ''} onClick={() => setBottom('console')}>
              Console
            </button>
            <button className={bottom === 'assets' ? 'active' : ''} onClick={() => setBottom('assets')}>
              Assets
            </button>
          </div>
          <ErrorBoundary name="Bottom panel">{bottom === 'console' ? <Console /> : <AssetBrowser prj={game.data.prj} />}</ErrorBoundary>
        </Panel>
      </Group>
    </div>
  );
}
