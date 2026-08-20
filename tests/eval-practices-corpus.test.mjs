import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Deliberately NOT `import { parseCorpus } from '../src/practices/provision.js'`
// and NOT anything from `../dist/...`. Two independent reasons, both real
// defects this project has already hit once:
//
//   1. parseCorpus (src/practices/provision.ts) reads only id/title/body off
//      each raw entry and returns a fresh object — appliesTo and
//      mechanicallyCheckable are silently dropped by anything that goes
//      through it (see eval/practices/README.md's own finding). A test that
//      loaded the corpus through parseCorpus could not see the fields it
//      exists to check.
//   2. eval/sweep.mjs imports from '../dist/review/*.js' — a compiled
//      artifact that can be stale, missing, or (per eval/README.md's own
//      "Measurements": the settings.credential defect) built against a
//      contract the source has since moved past. The committed
//      practices.json is the actual thing a fresh `git clone` of this
//      branch gets; reading it directly with readFileSync is reading
//      exactly that, with nothing resolved or rebuilt in between.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, '..', 'eval', 'practices', 'practices.json');

// The widest width the default sweep uses. Sourced from, and must be kept in
// step with, `DEFAULT_WIDTHS` in eval/sweep.mjs (`const DEFAULT_WIDTHS = [1,
// 2, 3, 5, 8, 13, 21, 34];`, also documented in eval/README.md's "Running
// it" section: "default `1,2,3,5,8,13,21,34`"). Not imported directly:
// eval/sweep.mjs imports from ../dist/review/*.js at module load, which this
// test must not depend on existing or being current (see the header above).
// A constant with no stated source is exactly the defect this project keeps
// writing records about (recon/constraints.md, design records on tuned
// constants) — so if eval/sweep.mjs's DEFAULT_WIDTHS ever changes, this
// constant must be updated to match by hand, and this comment is where the
// next person finds out that it must be.
const WIDEST_DEFAULT_SWEEP_WIDTH = 34; // eval/sweep.mjs:99, DEFAULT_WIDTHS

function loadCorpus() {
  const text = readFileSync(CORPUS_PATH, 'utf8');
  return JSON.parse(text);
}

describe('the committed practice corpus (eval/practices/practices.json)', () => {
  const corpus = loadCorpus();

  it('is a version-1 corpus with a non-empty practices array', () => {
    expect(corpus.version).toBe(1);
    expect(Array.isArray(corpus.practices)).toBe(true);
    expect(corpus.practices.length).toBeGreaterThan(0);
  });

  it('gives every practice a valid appliesTo and a boolean mechanicallyCheckable', () => {
    // This is the assertion that would have failed loudly at beed7d4,
    // instead of the failure passing silently until a fresh clone tried to
    // run the sweep and selected zero practices.
    const violations = corpus.practices.filter((p) => {
      const appliesToOk = p.appliesTo === 'diff' || p.appliesTo === 'process';
      const checkableOk = typeof p.mechanicallyCheckable === 'boolean';
      return !appliesToOk || !checkableOk;
    });
    expect(
      violations.map((p) => ({
        id: p.id,
        appliesTo: p.appliesTo,
        mechanicallyCheckable: p.mechanicallyCheckable,
      })),
    ).toEqual([]);
  });

  it('leaves the appliesTo:"diff" subset non-empty', () => {
    // Catches today's exact failure: eval/sweep.mjs's selectPractices
    // filters on appliesTo === 'diff' for practiceCount 'full'; if that
    // subset is empty, partition() correctly refuses to build any lens set
    // at all, and the sweep silently has nothing to run.
    const diffApplicable = corpus.practices.filter((p) => p.appliesTo === 'diff');
    expect(diffApplicable.length).toBeGreaterThan(0);
  });

  it('keeps the appliesTo:"diff" subset large enough to support the widest configured fan width', () => {
    const diffApplicable = corpus.practices.filter((p) => p.appliesTo === 'diff');
    // Non-emptiness alone is not enough: it would stay green even at, say,
    // two diff-applicable practices, which would silently reintroduce the
    // exact width ceiling the 90-practice expansion existed to remove (see
    // eval/README.md's "The practiceCount axis" section — partition.mjs
    // refuses a width greater than the practice count it is given, because
    // an empty lens approves everything it sees). That refusal is loud; a
    // corpus that quietly shrank the FEASIBLE width range without ever
    // hitting zero would not be — it is a capability loss, not a crash, and
    // would only show up as the widest sweep configurations silently
    // reporting lensSetError with zero calls costed, easy to miss in a long
    // run's output.
    expect(
      diffApplicable.length,
      `Only ${String(diffApplicable.length)} of ${String(corpus.practices.length)} committed ` +
        `practices carry appliesTo: "diff", but the default sweep's widest configured fan is ` +
        `${String(WIDEST_DEFAULT_SWEEP_WIDTH)} lenses (eval/sweep.mjs's DEFAULT_WIDTHS). ` +
        `partition.mjs refuses to build a lens set wider than the practice subset it is given ` +
        `(an empty lens would approve everything it sees), so the widest default sweep ` +
        `configuration on the "full" practiceCount arm would be infeasible and silently report ` +
        `lensSetError with zero calls costed for it — the exact scaling-question gap the ` +
        `90-practice expansion (see eval/practices/README.md) was done to remove. Either the ` +
        `diff-applicable subset of the corpus needs to grow back above ` +
        `${String(WIDEST_DEFAULT_SWEEP_WIDTH)}, or DEFAULT_WIDTHS needs to shrink to match what ` +
        `the corpus can actually support — but this must be a deliberate choice, not a silent one.`,
    ).toBeGreaterThanOrEqual(WIDEST_DEFAULT_SWEEP_WIDTH);
  });

  it('has no duplicate practice ids', () => {
    const ids = corpus.practices.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
