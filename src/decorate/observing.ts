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
  /** Present only when it threw, so the two cases are never confused. */
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
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
  };
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
