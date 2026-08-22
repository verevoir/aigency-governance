import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Closes the gate gap that let eval/sweep.mjs ship importing a module
// (eval/criterion.mjs) that did not exist: run_gates never executes any
// eval/*.mjs release script directly - they are release steps, not gates -
// so a broken static import at the top of one is invisible to `verify` and
// to CI until something actually invokes the step. This is a load-only
// smoke test: it costs nothing and calls no model, and it would have
// failed the moment that import landed.
//
// eval/sweep.mjs is included: it carries a main-guard (`isMainModule`,
// comparing import.meta.url to pathToFileURL(process.argv[1]).href) that
// makes loading it side-effect-free, so a bare `import('../eval/sweep.mjs')`
// no longer runs its CLI. This is the module that actually broke.
//
// THE LIST IS ENUMERATED, NOT MAINTAINED BY HAND. A hardcoded list of entry
// points is exactly the shape this project's own S37 story names as
// unacceptable for a different subject ("checked by a test that enumerates
// the emitted kinds rather than by a list someone maintains by hand") - a
// new eval/*.mjs file added later would simply not be covered, silently,
// and nothing would say so. So the entry points below are read from the
// eval/ directory at test time.
//
// THE ENUMERATION RULE, STATED EXPLICITLY RATHER THAN LEFT IMPLICIT: only
// the FILES DIRECTLY INSIDE eval/ whose name ends in `.mjs` — not a
// recursive walk, and not a filename blocklist. This rule was first added
// because eval/corpus/make-diffs.mjs (checked directly, by reading it) ran
// real side effects — it spawned `git` and wrote diff.txt files — at the
// TOP LEVEL of the module, with no main-guard gating any of it, so a
// recursive enumeration would have `import()`ed it during every `verify`
// run and shelled out as a side effect of loading it. THAT MODULE IS NOW
// GUARDED (isMainModule, same idiom as eval/sweep.mjs below) — its own
// side effects no longer run on import, from this test or from anything
// else. The rule stays anyway: it is about the class of thing (a script
// living in a subdirectory of eval/, not audited by this enumeration),
// not about that one file, and a future subdirectory script could just as
// easily be added without a guard. Non-recursive enumeration excludes the
// whole class by construction, which is what makes the exclusion load-
// bearing rather than incidental. eval/practices/ and eval/results/ hold
// no .mjs files at all as of this writing, so nothing else is presently
// excluded by this rule — the rule is what matters, not today's directory
// contents.
//
// SIDE-EFFECT CHECK, PER FILE THE ENUMERATION ACTUALLY PICKS UP (re-done
// against the enumeration, not just against the formerly-hardcoded five):
// eval/criterion.mjs, eval/partition.mjs and eval/score.mjs export pure
// functions and constants only — no top-level I/O, no top-level await.
// eval/staleness.mjs's own header states it plainly ("PURE AND TESTABLE,
// DELIBERATELY ... This module does no I/O and reaches no network") and
// the module body matches that claim. eval/sweep.mjs is guarded by
// `isMainModule` as described above. All five are safe to bare-import.
const EVAL_DIR = fileURLToPath(new URL('../eval/', import.meta.url));

// Read once, at module load — a plain top-level await, standard ESM, not a
// helper called separately by every test. Every block below works from this
// same array, so there is exactly one directory read to reason about, not
// one per test.
const entries = await readdir(EVAL_DIR, { withFileTypes: true });
const ENTRY_POINTS = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .map((entry) => entry.name)
  .sort();

describe('eval/*.mjs entry points load without throwing', () => {
  it('finds at least one entry point (a directory read that silently found nothing must not read as a clean run)', () => {
    expect(ENTRY_POINTS.length).toBeGreaterThan(0);
  });

  it("eval/ still holds exactly the entry points this file's side-effect check covers", () => {
    // Not a re-hardcoding of the list under test: this guards the
    // side-effect audit above staying honest. If a new eval/*.mjs file
    // ever appears, THIS assertion fails first, with a clear message, so
    // the audit gets extended before the load-only test below silently
    // starts covering it too.
    expect(ENTRY_POINTS).toEqual([
      'criterion.mjs',
      'partition.mjs',
      'score.mjs',
      'staleness.mjs',
      'sweep.mjs',
    ]);
  });

  it.each(ENTRY_POINTS)('%s', async (name) => {
    await expect(import(`../eval/${name}`)).resolves.toBeDefined();
  });
});
