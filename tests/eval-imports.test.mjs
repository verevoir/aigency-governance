import { describe, expect, it } from 'vitest';

// Closes the gate gap that let eval/sweep.mjs ship importing a module
// (eval/criterion.mjs) that did not exist: run_gates never executes any
// eval/*.mjs release script directly - they are release steps, not gates -
// so a broken static import at the top of one is invisible to `verify` and
// to CI until something actually invokes the step. This is a load-only
// smoke test: it costs nothing and calls no model, and it would have
// failed the moment that import landed.
//
// eval/sweep.mjs is now included: it carries a main-guard (`isMainModule`,
// comparing import.meta.url to pathToFileURL(process.argv[1]).href) that
// makes loading it side-effect-free, so a bare `import('../eval/sweep.mjs')`
// no longer runs its CLI. This is the module that actually broke.
const SAFE_ENTRY_POINTS = [
  '../eval/criterion.mjs',
  '../eval/partition.mjs',
  '../eval/score.mjs',
  '../eval/staleness.mjs',
  '../eval/sweep.mjs',
];

describe('eval/*.mjs entry points load without throwing', () => {
  it.each(SAFE_ENTRY_POINTS)('%s', async (relPath) => {
    await expect(import(relPath)).resolves.toBeDefined();
  });
});
