/**
 * Code pointers.
 *
 * In the original, hooks, callbacks and method tables hold function
 * addresses. The port stores the TS function itself in live objects
 * (`CodeFn`) and keeps a registry from each ported function to its original
 * name and address, so the editor can show `destructible_register`'s
 * onRelease as `debris_teardown @ 0x36d30` rather than as a JS closure.
 * Tables read raw out of MW2.EXE (GamepieceClass) still hold `CodePtr`
 * addresses; resolveCode() turns an address into the ported function.
 */

/** An original code address as stored in a table; 0 is null. */
export type CodePtr = number;

// Any function; each call site knows its own protocol, as in C.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodeFn = (...args: any[]) => any;

interface CodeInfo {
  name: string;
  address: number;
}

const byFn = new Map<CodeFn, CodeInfo>();
const byAddress = new Map<number, CodeFn>();

/** Records that `fn` is the port of the original function `name` at `address`. Returns fn. */
export function registerCode<F extends CodeFn>(name: string, address: number, fn: F): F {
  byFn.set(fn, { name, address });
  byAddress.set(address, fn);
  return fn;
}

export function codeInfo(fn: CodeFn | null | undefined): CodeInfo | undefined {
  return fn ? byFn.get(fn) : undefined;
}

/** The ported function for an original address, or null when none is registered. */
export function resolveCode(address: CodePtr): CodeFn | null {
  return address === 0 ? null : (byAddress.get(address) ?? null);
}
