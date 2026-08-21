import { describe, expect, it } from 'vitest';

// Closes the gate gap that let eval/sweep.mjs ship importing a module
// (eval/criterion.mjs) that did not exist: run_gates never executes any
// eval/*.mjs release script directly - they are release steps, not gates -
// so a broken static import at the top of one is invisible to `verify` and
// to CI until something actually invokes the step. This is a load-only
// smoke test: it costs nothing and calls no model, and it would have
// failed the moment that import landed.
//
// eval/sweep.mjs is deliberately NOT included here. It ends with an
// unconditional `main().catch((cause) => { ... })` at module top level,
// with no `import.meta.url === process.argv[1]`-style guard anywhere in
// the file - so a bare `import('../eval/sweep.mjs')` would run its whole
// CLI (argument parsing against the TEST RUNNER's own argv, filesystem and
// possibly network activity, and writes to process.exitCode) as a side
// effect of merely loading it, inside this test process. That is unsafe,
// and stubbing argv or otherwise working around it here would hide the
// real problem rather than name it. This is reported as its own finding:
// eval/sweep.mjs's own entry point remains uncovered by any load check,
// and needs a real main-guard (or a subprocess-based smoke test) before it
// can be safely imported in a test.
const SAFE_ENTRY_POINTS = [
  '../eval/criterion.mjs',
  '../eval/partition.mjs',
  '../eval/score.mjs',
  '../eval/staleness.mjs',
];

describe('eval/*.mjs entry points load without throwing', () => {
  it.each(SAFE_ENTRY_POINTS)('%s', async (relPath) => {
    await expect(import(relPath)).resolves.toBeDefined();
  });
});
