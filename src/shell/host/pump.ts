/**
 * Runs the shell "process": resumes its generator from the host's frames.
 * A pass of a screen loop ends at mouse_update's present; the pump runs
 * passes at a fixed rate (the original ran them as fast as the PC could -
 * some of its timings count passes: the title music's fade-in, a
 * briefing's typing), stops early when the shell spins on hardware or
 * waits for a file, and keeps the timer and Miles going.
 *
 * @portOnly the host's scheduler for the shell's blocking code
 */
import { divergence } from '../../core/provenance.ts';
import { ShellExit, type Blocking, type ShellYield } from './blocking.ts';
import { hwAdvanceTime } from './hardware.ts';
import { milesService } from '../sound/music.ts';

/**
 * Passes of a screen loop per second. The original ran them as fast as
 * the PC allowed - a pass presents only the dirty rectangle, and neither
 * the shell nor its VFX drivers wait for the vertical retrace - and three
 * of its designs count passes: the title music's fade-in (a unit every 500
 * passes, 30 units), training's idle animation (every 20 000 passes) and a
 * page typing one character a pass. At about a thousand a second those
 * come to 15 s, 20 s and a briefing in a second or two; at the 60 this
 * was until 2026-09-28 they took minutes, and the typing was plainly slow.
 * No measurement of the original's rate is behind the figure.
 */
export const DEFAULT_PASS_RATE = 1000;

export class ShellPump {
  private waiting: Promise<unknown> | null = null;
  private owed = 0;
  /** the program's exit status once it has ended, else null */
  status: number | null = null;
  error: unknown = null;

  constructor(
    private readonly program: Blocking<number>,
    readonly passRate = DEFAULT_PASS_RATE,
  ) {
    divergence(`the shell's loops run at ${passRate} passes a second (the original: as fast as the PC allowed)`, 'shell pump');
  }

  /** One host frame of `ms` milliseconds. Returns false once the program has ended. */
  frame(ms: number): boolean {
    if (this.status !== null) return false;
    hwAdvanceTime(ms);
    milesService(ms);
    if (this.waiting) return true;
    // never owe more than two display frames' worth (a hidden tab resumes without a burst)
    this.owed = Math.min(this.owed + (ms * this.passRate) / 1000, Math.max(4, this.passRate / 30));
    while (this.owed >= 1) {
      const y = this.resume();
      if (y === null) return false;
      if (y.kind === 'frame') this.owed -= 1;
      else {
        if (y.kind === 'await') {
          this.waiting = y.promise;
          const clear = () => {
            this.waiting = null;
          };
          y.promise.then(clear, clear);
        }
        break;
      }
    }
    return true;
  }

  /** Runs the program to its next yield; null once it has ended. */
  private resume(): ShellYield | null {
    try {
      const r = this.program.next();
      if (r.done) {
        this.status = r.value;
        return null;
      }
      return r.value;
    } catch (e) {
      if (e instanceof ShellExit) this.status = e.status;
      else {
        this.error = e;
        this.status = 1;
      }
      return null;
    }
  }
}
