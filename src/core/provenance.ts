/**
 * Runtime markers that keep the port honest about what it knows.
 *
 * Every ported function carries a doc tag naming the original it reproduces:
 *
 *   @mw2 <original_name> <address>     the function in MW2.EXE (names.csv)
 *   @fidelity exact|partial|stub       how completely the body is reproduced
 *   @divergence <why>                  a deliberate difference, and its reason
 *   @portOnly <why>                    a helper with no original counterpart
 *
 * The three calls below are the in-body counterparts. They exist so that a
 * gap is visible at runtime (in the editor's console) and in PORTING.md,
 * rather than being papered over with a plausible guess - the same rule the
 * decompilation follows: a blank field beats a plausible guess.
 */

export type ProvenanceKind = 'unestablished' | 'quirk' | 'divergence';

export interface ProvenanceEvent {
  kind: ProvenanceKind;
  message: string;
  where: string | undefined;
}

type Sink = (e: ProvenanceEvent) => void;

const seen = new Set<string>();
let sink: Sink = () => {};

/** Route provenance events somewhere visible (the editor console, a test). */
export function setProvenanceSink(s: Sink): void {
  sink = s;
}

/** Forget which events were already reported (e.g. on mission reload). */
export function resetProvenanceSeen(): void {
  seen.clear();
}

function report(kind: ProvenanceKind, message: string, where?: string): void {
  const key = `${kind}|${where ?? ''}|${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  sink({ kind, message, where });
}

/**
 * Behaviour the decompilation has not established. The caller must still
 * return something; it returns the most neutral value available and says so
 * here. Logged once per distinct message.
 */
export function unestablished(message: string, where?: string): void {
  report('unestablished', message, where);
}

/** Original behaviour reproduced on purpose even though it looks wrong. */
export function quirk(message: string, where?: string): void {
  report('quirk', message, where);
}

/** A deliberate runtime difference from the original. */
export function divergence(message: string, where?: string): void {
  report('divergence', message, where);
}
