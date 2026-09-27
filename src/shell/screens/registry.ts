/**
 * main's screens by state, registered by their modules (so main does not
 * import every screen, nor they main). A state with no screen yet shows the
 * port's placeholder, which returns to the title.
 *
 * @portOnly main's switch, as a table
 */
import type { MPackDb } from '../../data/formats/mpack.ts';
import type { Blocking } from '../host/blocking.ts';

/** What main passes a screen: the archive, and its own locals the screen reads and writes by pointer. */
export interface MainLocals {
  db: MPackDb;
  /** the career variable (0 Wolf, 1 Jade Falcon, 2 Trial of Grievance) */
  career: { value: number };
  /** the pilot-accepted byte */
  accepted: { value: number };
  /** the command line (the mission's scenario name) prm_save puts first */
  commandLine: { value: string };
  /** the state before this one */
  previous: number;
}

export type Screen = (l: MainLocals) => Blocking<number>;

const screens = new Map<number, Screen>();

export const shellScreens = {
  register(state: number, screen: Screen): void {
    screens.set(state, screen);
  },
  get(state: number): Screen | undefined {
    return screens.get(state);
  },
};
