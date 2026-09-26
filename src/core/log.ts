/**
 * Logging for the DOM-free layers. The engine tsconfig has no DOM or node
 * lib, so `console` is reached through globalThis; the editor installs a sink
 * to show these lines in its console panel.
 *
 * @portOnly
 */

type Level = 'log' | 'warn' | 'error';
type Sink = (level: Level, channel: string, text: string) => void;

interface MinimalConsole {
  log(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

const hostConsole = (globalThis as unknown as { console?: MinimalConsole }).console;

let sink: Sink = (level, channel, text) => hostConsole?.[level](`[${channel}] ${text}`);

export function setLogSink(s: Sink): void {
  sink = s;
}

export const log = (channel: string, text: string): void => sink('log', channel, text);
export const warn = (channel: string, text: string): void => sink('warn', channel, text);
export const error = (channel: string, text: string): void => sink('error', channel, text);
