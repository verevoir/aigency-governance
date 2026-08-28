import { describe, expect, it } from 'vitest';

import { boundaryFailureReport, crashOutcome } from '../src/cli/crashGuard.js';

describe('crashOutcome', () => {
  it('before main() has settled, reports the crash as the verdict and exits 1', () => {
    const cause = new Error('boom');
    const outcome = crashOutcome(cause, false);
    expect(outcome.text).toBe(`${boundaryFailureReport(cause)}\n`);
    expect(outcome.exitCode).toBe(1);
  });

  // The case this guard exists for. Simulated rather than provoked: nothing
  // in review-artifact-persistence's own diff has a floating promise that
  // could cause a real unhandledRejection here — the realistic trigger named
  // in review.ts's own comment is Node's fetch/undici internals doing late
  // socket cleanup, which this test does not attempt to reproduce. It
  // simulates only the SHAPE of the event — a crash observed after main()
  // has already settled — so this proves the guard's behaviour regardless of
  // what, if anything, ever actually causes one in this codebase. Do not
  // read this test as evidence such a trigger exists here; it does not.
  it('after main() has settled, records a late failure WITHOUT overwriting the verdict or the exit code', () => {
    const cause = new Error('simulated late rejection, after main() resolved');
    const outcome = crashOutcome(cause, true);

    // The exit code main() already set must survive untouched — this is the
    // whole bug being fixed, so it is the one thing this test cannot skip.
    expect(outcome.exitCode).toBeUndefined();

    // Must not read as a second verdict — no second "## Review:" heading.
    expect(outcome.text).not.toContain('## Review:');

    // The fact must still be visible, though — appended, not silent.
    expect(outcome.text).toContain('did not change it');
    expect(outcome.text).toContain(cause.message);
  });

  it('the pre-settle and post-settle reports are never byte-identical', () => {
    // A regression that made both branches return the same text would still
    // pass every assertion above in isolation; this pins that they differ.
    const cause = new Error('x');
    expect(crashOutcome(cause, false).text).not.toBe(crashOutcome(cause, true).text);
  });
});
