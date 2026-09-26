/**
 * A minimal external store for React: a revision counter bumped when engine
 * state changes (a frame ran, an edit was made, a mission loaded). Components
 * read engine objects directly during render and subscribe to the revision,
 * so the inspector stays live without copying the game state into React.
 *
 * @portOnly
 */
import { useSyncExternalStore } from 'react';

export class Store {
  private revision = 0;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): number => this.revision;

  bump(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }
}

/** Engine state: bumped per frame (throttled by the host in Play) and per edit. */
export const engineStore = new Store();
/** Editor state: selection, panels. */
export const editorStore = new Store();

export function useRevision(store: Store): number {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
