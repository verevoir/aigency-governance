// Retry, as a decorator over any async operation.
//
// The rule that shapes this whole file: a decorator MAY NOT change an
// outcome. It observes, maps or retries; it never turns a failure into a
// success or an absence into a value. So when the attempts run out this
// rethrows the last error unchanged — a retry that gave up and returned
// something would be the single worst thing in this repository, because every
// caller would read it as the operation having worked.
//
// It also refuses to retry what cannot benefit. A 400 does not become a 200
// by asking again; retrying it spends money and time to reach the same answer
// three times. Deciding which failures are worth repeating is the caller's,
// because only the caller knows what its port's errors mean.

export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retrying at all. */
  readonly attempts: number;
  /** How long to wait before attempt n (1-based, so never called with 1). */
  readonly delayMs: (attempt: number) => number;
  /** Whether this failure could plausibly succeed if repeated. */
  readonly retryable: (cause: unknown) => boolean;
}

/** Injected so tests do not wait and so a composition can choose its timer. */
export type Sleep = (ms: number) => Promise<void>;

export class RetryPolicyError extends Error {
  override readonly name = 'RetryPolicyError';
}

/**
 * Wrap an operation so that retryable failures are repeated.
 *
 * The signature is deliberately generic over arguments and return: this knows
 * nothing about ports, and a port that has to be modified to be retryable has
 * had the concern leak into it, which is the thing ADR 007 exists to prevent.
 */
export function retrying<A extends unknown[], R>(
  operation: (...args: A) => Promise<R>,
  policy: RetryPolicy,
  sleep: Sleep,
): (...args: A) => Promise<R> {
  // Refused at wiring time rather than at the first failure. A policy of zero
  // attempts is a port that never runs, and finding that out on the day
  // something breaks is finding it out at the worst moment.
  if (!Number.isSafeInteger(policy.attempts) || policy.attempts < 1) {
    // String() rather than JSON.stringify, because JSON.stringify(NaN) and
    // JSON.stringify(Infinity) are both "null" — so a message promising to
    // name the value would have named the wrong one for precisely the inputs
    // a bad computation produces. A message that is confidently wrong about
    // what it was given is worse than one that says nothing.
    throw new RetryPolicyError(
      `attempts must be a positive whole number, got ${String(policy.attempts)}`,
    );
  }

  return async (...args: A): Promise<R> => {
    let lastCause: unknown;
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      try {
        return await operation(...args);
      } catch (cause) {
        lastCause = cause;
        // Two reasons to stop, kept apart because they mean different things
        // to whoever reads the logs: this failure cannot be helped by
        // repeating, or we have run out of attempts.
        if (!policy.retryable(cause) || attempt === policy.attempts) {
          throw cause;
        }
        await sleep(policy.delayMs(attempt + 1));
      }
    }
    // Unreachable: the loop either returns or throws. Kept because the
    // compiler cannot see that, and because throwing the last cause is the
    // only correct thing to do if it ever becomes reachable — returning
    // anything here would be the outcome change this file forbids.
    throw lastCause;
  };
}
