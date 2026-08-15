import { describe, expect, it } from 'vitest';

import { observing, type Observation } from '../src/decorate/observing.js';
import { retrying, RetryPolicyError, type RetryPolicy } from '../src/decorate/retrying.js';

const NEVER_SLEEPS = (): Promise<void> => Promise.resolve();

function policy(over: Partial<RetryPolicy> = {}): RetryPolicy {
  return { attempts: 3, delayMs: () => 0, retryable: () => true, ...over };
}

/** Fails `times` times with `Error(message)`, then resolves with 'ok'. */
function failingTimes(times: number, message: string): () => Promise<string> {
  let called = 0;
  return () => {
    called += 1;
    return called <= times ? Promise.reject(new Error(message)) : Promise.resolve('ok');
  };
}

function recorderInto(seen: Observation[]): (observation: Observation) => void {
  return (observation) => {
    seen.push(observation);
  };
}

// A clock that advances 10ms per reading, so a duration is deterministic and
// non-zero. Real time would make every assertion about `ms` either flaky or
// vacuous.
function tickingClock(): () => number {
  let now = 0;
  return () => {
    now += 10;
    return now;
  };
}

describe('retrying — it may not change an outcome', () => {
  it('returns the value when the operation eventually succeeds', async () => {
    await expect(retrying(failingTimes(2, 'transient'), policy(), NEVER_SLEEPS)()).resolves.toBe(
      'ok',
    );
  });

  // The single worst thing this file could do. A retry that gave up and
  // returned something would be read by every caller as the operation having
  // worked.
  it('rethrows the last cause, by identity, when the attempts run out', async () => {
    const cause = new Error('still broken');
    const always = (): Promise<string> => Promise.reject(cause);
    await expect(retrying(always, policy(), NEVER_SLEEPS)()).rejects.toBe(cause);
  });

  it('does not retry a failure the policy says cannot be helped', async () => {
    let calls = 0;
    const always = (): Promise<string> => {
      calls += 1;
      return Promise.reject(new Error('HTTP 400'));
    };
    await expect(
      retrying(always, policy({ retryable: () => false }), NEVER_SLEEPS)(),
    ).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('makes exactly the number of attempts the policy allows', async () => {
    let calls = 0;
    const cause = new Error('transient');
    const always = (): Promise<string> => {
      calls += 1;
      return Promise.reject(cause);
    };
    await expect(retrying(always, policy({ attempts: 4 }), NEVER_SLEEPS)()).rejects.toBe(cause);
    expect(calls).toBe(4);
  });

  it('attempts of 1 means no retrying at all', async () => {
    let calls = 0;
    const cause = new Error('transient');
    const always = (): Promise<string> => {
      calls += 1;
      return Promise.reject(cause);
    };
    await expect(retrying(always, policy({ attempts: 1 }), NEVER_SLEEPS)()).rejects.toBe(cause);
    expect(calls).toBe(1);
  });

  it('passes its arguments through untouched', async () => {
    const seen: unknown[][] = [];
    const op = (...args: unknown[]): Promise<string> => {
      seen.push(args);
      return Promise.resolve('ok');
    };
    await retrying(op, policy(), NEVER_SLEEPS)('a', 2, { c: true });
    expect(seen).toEqual([['a', 2, { c: true }]]);
  });
});

describe('retrying — the delay is labelled by the attempt it precedes', () => {
  // The `+1` is load-bearing on delayMs's doc comment, and this is the test
  // that fails if someone "corrects" it. Passing the attempt that just failed
  // is the other convention; the comment says this one.
  it('asks for the delay before attempt 2, then before attempt 3, never before 1', async () => {
    const asked: number[] = [];
    await expect(
      retrying(
        failingTimes(3, 'transient'),
        policy({
          delayMs: (attempt) => {
            asked.push(attempt);
            return 0;
          },
        }),
        NEVER_SLEEPS,
      )(),
    ).rejects.toThrow();
    expect(asked).toEqual([2, 3]);
  });

  // The previous version used a never-failing operation, so the catch block
  // was never entered and it passed against an implementation with no retry
  // at all. Failing once means the sleep genuinely has a chance to happen in
  // the wrong place, and exactly one entry proves it happened in the right
  // one.
  it('does not sleep before the first attempt, and does before the second', async () => {
    const slept: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    };
    await expect(
      retrying(failingTimes(1, 'transient'), policy({ delayMs: () => 50 }), sleep)(),
    ).resolves.toBe('ok');
    expect(slept).toEqual([50]);
  });

  it('sleeps for what the policy returned, in order', async () => {
    const slept: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    };
    await retrying(failingTimes(2, 'transient'), policy({ delayMs: (n) => n * 100 }), sleep)();
    expect(slept).toEqual([200, 300]);
  });
});

describe('retrying — a policy that cannot work is refused at wiring time', () => {
  // Not at the first failure. A port that never runs is a thing to find out
  // when it is wired, not on the day something breaks.
  it('refuses zero attempts', () => {
    expect(() => retrying(failingTimes(0, 'x'), policy({ attempts: 0 }), NEVER_SLEEPS)).toThrow(
      RetryPolicyError,
    );
  });

  it('refuses a bad attempt count and names the value it was given', () => {
    for (const [attempts, shown] of [
      [-1, 'got -1'],
      [1.5, 'got 1.5'],
      [Number.NaN, 'got NaN'],
      [Number.POSITIVE_INFINITY, 'got Infinity'],
    ] as const) {
      const wire = (): unknown =>
        retrying(failingTimes(0, 'x'), policy({ attempts }), NEVER_SLEEPS);
      expect(wire).toThrow(RetryPolicyError);
      expect(wire).toThrow(shown);
    }
  });
});

describe('observing — it may not change an outcome either', () => {
  it('returns what the operation returned', async () => {
    const seen: Observation[] = [];
    await expect(
      observing('port', () => Promise.resolve('ok'), recorderInto(seen), tickingClock())(),
    ).resolves.toBe('ok');
    expect(seen[0]?.outcome).toBe('ok');
  });

  it('rethrows by identity and records the failure', async () => {
    const seen: Observation[] = [];
    const cause = new Error('broke');
    await expect(
      observing('port', () => Promise.reject(cause), recorderInto(seen), tickingClock())(),
    ).rejects.toBe(cause);
    expect(seen[0]?.outcome).toBe('threw');
    expect(seen[0]?.cause).toBe('broke');
  });

  // The one named swallow in the system. A broken metrics sink must not take
  // down the thing it is measuring — the system's job is not to produce
  // metrics.
  it('a recorder that throws does not fail a successful operation', async () => {
    const explode = (): void => {
      throw new Error('the sink is down');
    };
    await expect(
      observing('port', () => Promise.resolve('ok'), explode, tickingClock())(),
    ).resolves.toBe('ok');
  });

  it('a recorder that throws does not replace the operation’s own failure', async () => {
    const explode = (): void => {
      throw new Error('the sink is down');
    };
    const cause = new Error('the real problem');
    await expect(
      observing('port', () => Promise.reject(cause), explode, tickingClock())(),
    ).rejects.toBe(cause);
  });

  it('records the name it was given and a duration from the injected clock', async () => {
    const seen: Observation[] = [];
    await observing(
      'the-lens-set',
      () => Promise.resolve('ok'),
      recorderInto(seen),
      tickingClock(),
    )();
    expect(seen[0]?.name).toBe('the-lens-set');
    expect(seen[0]?.ms).toBe(10);
  });

  it('never records an empty cause, whatever was thrown', async () => {
    const thrown: unknown[] = [new Error(''), '', 0, null, undefined];
    for (const cause of thrown) {
      const seen: Observation[] = [];
      // toBe(cause) rather than toBeDefined(): the first version applied
      // toBeDefined to the REJECTION REASON, and the last fixture value is
      // `undefined`, so it failed on the thing being thrown rather than the
      // thing being recorded. Identity is what this file is actually about.
      await expect(
        observing('port', () => Promise.reject(cause), recorderInto(seen), tickingClock())(),
      ).rejects.toBe(cause);
      expect(seen[0]?.outcome).toBe('threw');
      expect(seen[0]?.cause).not.toBe('');
      expect(seen[0]?.cause).toBeDefined();
    }
  });

  it('records no cause at all when nothing was thrown', async () => {
    const seen: Observation[] = [];
    await observing('port', () => Promise.resolve('ok'), recorderInto(seen), tickingClock())();
    expect(seen[0]?.cause).toBeUndefined();
  });
});

// THE acceptance criterion for this story. Both compositions type-check, both
// run, and they produce different records. The difference is invisible at the
// call site and decides what a chart shows six months later, which is why the
// wiring site has to state its order with a reason rather than just pick one.
describe('the order the decorators are applied in', () => {
  it('observing(retrying(op)) records once, covering every attempt', async () => {
    const seen: Observation[] = [];
    const wrapped = observing(
      'port',
      retrying(failingTimes(2, 'transient'), policy(), NEVER_SLEEPS),
      recorderInto(seen),
      tickingClock(),
    );
    await expect(wrapped()).resolves.toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.outcome).toBe('ok');
  });

  it('retrying(observing(op)) records once per attempt, failures included', async () => {
    const seen: Observation[] = [];
    const wrapped = retrying(
      observing('port', failingTimes(2, 'transient'), recorderInto(seen), tickingClock()),
      policy(),
      NEVER_SLEEPS,
    );
    await expect(wrapped()).resolves.toBe('ok');
    expect(seen).toHaveLength(3);
    expect(seen.map((observation) => observation.outcome)).toEqual(['threw', 'threw', 'ok']);
  });
});
