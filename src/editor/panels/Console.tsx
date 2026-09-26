/**
 * The console: engine log, system_error reports and the provenance markers,
 * filterable by channel.
 *
 * @portOnly
 */
import { useEffect, useRef, useState } from 'react';
import { consoleClear, consoleLines, consoleStore, type Channel } from '../store/consoleLog.ts';
import { useRevision } from '../store/store.ts';

const CHANNELS: Channel[] = ['log', 'warn', 'error', 'system_error', 'unestablished', 'quirk', 'divergence'];

export function Console() {
  useRevision(consoleStore);
  const [off, setOff] = useState<Set<Channel>>(new Set());
  const end = useRef<HTMLDivElement>(null);
  const shown = consoleLines.filter((l) => !off.has(l.channel));
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);
  return (
    <div className="console">
      <div className="console-bar">
        {CHANNELS.map((c) => (
          <label key={c} className={`chan chan-${c}`}>
            <input
              type="checkbox"
              checked={!off.has(c)}
              onChange={() => {
                const n = new Set(off);
                if (n.has(c)) n.delete(c);
                else n.add(c);
                setOff(n);
              }}
            />
            {c} ({consoleLines.filter((l) => l.channel === c).length})
          </label>
        ))}
        <button onClick={consoleClear}>clear</button>
      </div>
      <div className="console-lines">
        {shown.map((l) => (
          <div key={l.seq} className={`line chan-${l.channel}`}>
            <span className="line-chan">{l.channel}</span>
            {l.source ? <span className="line-src">{l.source}</span> : null}
            <span className="line-text">{l.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
