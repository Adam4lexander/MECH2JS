/**
 * Collects everything the engine reports - log lines, system_error warnings,
 * and the provenance markers (unestablished / quirk / divergence) - for the
 * editor's console panel.
 *
 * @portOnly
 */
import { setLogSink } from '../../core/log.ts';
import { setProvenanceSink } from '../../core/provenance.ts';
import { Store } from './store.ts';

export type Channel = 'log' | 'warn' | 'error' | 'system_error' | 'unestablished' | 'quirk' | 'divergence';

export interface ConsoleLine {
  seq: number;
  channel: Channel;
  source: string;
  text: string;
}

const MAX = 2000;
export const consoleLines: ConsoleLine[] = [];
export const consoleStore = new Store();
let seq = 0;

export function consolePush(channel: Channel, source: string, text: string): void {
  consoleLines.push({ seq: seq++, channel, source, text });
  if (consoleLines.length > MAX) consoleLines.splice(0, consoleLines.length - MAX);
  consoleStore.bump();
}

export function consoleClear(): void {
  consoleLines.length = 0;
  consoleStore.bump();
}

export function installConsoleSinks(): void {
  setLogSink((level, channel, text) => {
    consolePush(channel === 'system_error' ? 'system_error' : level, channel, text);
    // keep the browser console useful too
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${channel}] ${text}`);
  });
  setProvenanceSink((e) => consolePush(e.kind, e.where ?? '', e.message));
}
