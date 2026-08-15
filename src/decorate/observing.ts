// Narration, as a decorator over any async operation.
//
// The one place a decorator is allowed to swallow, and it is named here so
// nobody has to guess: if the recorder throws, the operation still returns
// what it returned. Narration that can fail an operation is worse than no
// narration — a broken metrics sink would take the system down, and the
// system's job is not to produce metrics.
//
// Everything else follows the same rule as `retrying`: the outcome is
// untouched. A failure is recorded and rethrown, never converted.

export interface Observation {
  /** What was wrapped. Supplied at the wiring site, not derived. */
  readonly name: string;
  readonly ms: number;
  readonly outcome: 'ok' | 'threw';
  /**
   * Present only when it threw, and never empty. A throw carrying no message
   * is recorded as its kind, so "threw with nothing to say" and "did not
   * throw" stay two facts rather than one field being empty in a way a reader
   * has to know to check.
   */
  readonly cause?: string;
}

export type Recorder = (observation: Observation) => void;
export type Clock = () => number;

export function observing<A extends unknown[], R>(
  name: string,
  operation: (...args: A) => Promise<R>,
  record: Recorder,
  now: Clock,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const started = now();
    try {
      const result = await operation(...args);
      safely(record, { name, ms: now() - started, outcome: 'ok' });
      return result;
    } catch (cause) {
      safely(record, {
        name,
        ms: now() - started,
        outcome: 'threw',
        cause: describe(cause),
      });
      throw cause;
    }
  };
}

/**
 * What to record about a thrown value. Never returns the empty string: an
 * empty `cause` on a `threw` observation is the missing/empty/broken
 * distinction surviving on one field instead of two.
 */
function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message === '' ? `${cause.name} with no message` : cause.message;
  }
  const rendered = String(cause);
  return rendered === '' ? `${typeof cause} with no message` : rendered;
}

/**
 * The named swallow. A recorder that throws is a defect in the recorder, and
 * it must not become a defect in the thing being recorded.
 */
function safely(record: Recorder, observation: Observation): void {
  try {
    record(observation);
  } catch {
    // Deliberately nothing. There is nowhere to report this that is not
    // itself a recorder.
  }
}
