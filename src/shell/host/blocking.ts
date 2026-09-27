/**
 * How the shell's blocking loops run in a browser. Every screen and every
 * modal helper of MW2SHELL.EXE is a loop that owns the machine until it
 * returns; the port writes each as a generator with the original's control
 * flow, and composes them with yield*. A generator gives control back at the
 * original's frame boundary - mouse_update presents the frame, then the host
 * gets the chance to deliver input - and at the waits that spin on hardware
 * (a Smacker frame being due, a sample finishing). The pump
 * (host/pump.ts) resumes it.
 *
 * @portOnly the execution model of the shell's blocking code
 */

/** What a blocking loop hands back to the pump. */
export type ShellYield =
  /** the frame was presented (mouse_update): a pass of the loop ended */
  | { kind: 'frame' }
  /** spinning on the hardware (a movie frame not yet due): give the host its frame */
  | { kind: 'wait' }
  /** waiting on the host for data (a file off the CD): resume when it settles */
  | { kind: 'await'; promise: Promise<unknown> };

/** A blocking shell routine: a generator returning T. */
export type Blocking<T> = Generator<ShellYield, T, unknown>;

export const FRAME: ShellYield = { kind: 'frame' };
export const WAIT: ShellYield = { kind: 'wait' };

/** Waits for a promise, as a blocking read would. @portOnly */
export function* awaitHost<T>(promise: Promise<T>): Blocking<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown = null;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e: unknown) => {
      settled = true;
      error = e ?? new Error('rejected');
    },
  );
  while (!settled) yield { kind: 'await', promise };
  if (error !== null) throw error;
  return value as T;
}

/** exit(status): thrown out of the shell's code to the pump, as the process would end. @portOnly */
export class ShellExit extends Error {
  constructor(readonly status: number) {
    super(`exit(${status})`);
  }
}
