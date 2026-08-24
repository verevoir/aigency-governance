import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { score } from '../eval/score.mjs';

// ONE HONEST END-TO-END RUN: a real, committed eval/corpus/<case>/truth.json
// on disk, fed to score() alongside a finding shaped exactly like what a
// real panel run returns (src/review/verdict.ts's Finding: { lens, summary,
// detail? } — no id, no target, no evidence; see eval/score.mjs's own
// header comment on why that shape is what forces target-matching to exist
// at all). This is not a synthetic fixture: the truth.json read here is the
// actual file committed to the corpus, and the finding text below is the
// same summary/detail this corpus already records as real captured panel
// output for this case (see eval/corpus/oauth-missing-beta-header/truth.json
// and subject.md).
//
// WHY THIS TEST EXISTS. eval/README.md's own 2026-08-20 measurement entry
// found that score()'s matcher requires `target` (and score()'s own
// perEntry/Map keying requires `id`) on every truth entry, and every corpus
// truth.json committed at that time carried neither — calling score() with
// a non-empty findings array against any of them threw `Cannot read
// properties of undefined (reading 'toLowerCase')`. That entry left the
// question of which side should change unresolved: "a defect in the corpus
// data / score.mjs's contract, both owned by a sibling track." Resolved by
// reading, in the commit that added id/target to every eval/corpus/*/
// truth.json alongside this test: score.mjs's target-matching is
// architecturally load-bearing (a Finding carries no location, so the
// truth entry's own target is the only signal available), documented in
// its own header, and already assumed by tests/eval-score.test.mjs's own
// fixtures (`truthEntry(id, target, verdict)`). The corpus was missing
// fields it should always have carried. This test is the proof that
// fixing the corpus side actually closes the gap, against the real
// committed file — not a re-assertion that the fix should work in theory.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = join(__dirname, '..', 'eval', 'corpus', 'oauth-missing-beta-header');

function loadTruth() {
  return JSON.parse(readFileSync(join(CASE_DIR, 'truth.json'), 'utf8'));
}

describe('score() against a real, committed corpus case (oauth-missing-beta-header)', () => {
  const truth = loadTruth();

  it('the committed truth.json carries id and target on every entry — the fix this test exists to prove', () => {
    expect(truth.length).toBeGreaterThan(0);
    for (const entry of truth) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.target).toBe('string');
      expect(entry.target.length).toBeGreaterThan(0);
    }
  });

  it('scores a real, panel-shaped finding against the real truth.json without throwing, and recalls the known defect', () => {
    // Shaped exactly like a real Finding: lens + summary + detail, the same
    // text this entry's own truth.json already records as the real
    // correctness-lens finding — reduced to what a Finding actually carries
    // (no evidence, no verdict, no provenance: those are truth-only fields
    // the reply contract never asks a reviewer for).
    const findings = [
      {
        lens: 'correctness',
        summary: truth[0].summary,
        detail: truth[0].detail,
      },
    ];

    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();

    expect(result.recall).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.unclassified).toBe(0);
    const entry = result.perEntry.find((e) => e.id === truth[0].id);
    expect(entry).toBeDefined();
    expect(entry.found).toBe(true);
    expect(entry.matchedBy).toEqual(['correctness']);
  });

  it('an unrelated finding against the same real truth.json scores as unclassified, not a throw and not a false match', () => {
    const findings = [{ lens: 'honesty', summary: 'README overstates what the cli gate covers' }];

    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();

    expect(result.matched).toBe(0);
    expect(result.unclassified).toBe(1);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.recall).toBe(0);
  });
});

function loadTruthFor(caseId) {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'eval', 'corpus', caseId, 'truth.json'), 'utf8'),
  );
}

// EVERY OTHER DIFF-BEARING CORPUS CASE, same discipline as above: real
// committed truth.json off disk, a Finding built from that entry's own real
// captured summary/detail text, score() called unmodified. score.mjs is not
// touched anywhere in this file — no catch, no default, no skip. Where a
// case's real text does not literally name its own target, the assertions
// below say so and record what score() actually returns (unclassified,
// recall 0) — that is the true, discovered behaviour, not a target tuned
// until it passes.

describe('score() against dead-decorators (defect, target src/decorate/retrying.ts)', () => {
  const truth = loadTruthFor('dead-decorators');

  it('matches: the real summary names the target file literally, so recall is 1', () => {
    const findings = [{ lens: truth[0].lens, summary: truth[0].summary }];
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.recall).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.unclassified).toBe(0);
    const entry = result.perEntry.find((e) => e.id === truth[0].id);
    expect(entry.found).toBe(true);
  });

  it('negative: an unrelated finding does not match this entry', () => {
    const findings = [{ lens: 'honesty', summary: 'README overstates what the cli gate covers' }];
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.matched).toBe(0);
    expect(result.unclassified).toBe(1);
    expect(result.recall).toBe(0);
  });
});

describe('score() against practices-not-dead-code (not-a-defect, target src/practices/provision.ts)', () => {
  const truth = loadTruthFor('practices-not-dead-code');

  it('matches, and is correctly counted as a confirmed false positive, never a hit', () => {
    const findings = [{ lens: truth[0].lens, summary: truth[0].summary, detail: truth[0].detail }];
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.confirmedFalsePositives).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.unclassified).toBe(0);
    // This truth.json holds zero `defect` entries — every entry here is
    // not-a-defect — so score.mjs's own rule applies: recall is null, not
    // 0, when defectEntries.length === 0. Asserted explicitly rather than
    // assumed, since 0 and null are different claims about this case.
    expect(result.recall).toBeNull();
  });

  it('negative: an unrelated finding does not match this entry', () => {
    const findings = [{ lens: 'honesty', summary: 'README overstates the fork PR sequence' }];
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.matched).toBe(0);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.unclassified).toBe(1);
  });
});

describe('score() against readme-drift (4 defect entries, targets README.md x3 / scripts/check-cli.mjs x1) — DISCOVERED GAP', () => {
  const truth = loadTruthFor('readme-drift');

  it('confirms all four entries carry id and target after the corpus fix', () => {
    expect(truth.length).toBe(4);
    for (const entry of truth) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.target).toBe('string');
    }
  });

  it('DOES NOT MATCH: none of the four real captured summaries literally name their own target — a genuine matcher limitation, not a corpus defect', () => {
    // Each Finding built from that entry's own real summary (none of the
    // four carries a `detail` field, confirmed by reading the committed
    // truth.json directly — only `evidence`, which Finding never carries).
    // The prose describes each defect by section title ("README's ...
    // section") or by what the header comment claims ("the file's own
    // header comment claims the gate proves..."), never by writing out
    // README.md or scripts/check-cli.mjs literally. mentionsTarget requires
    // exactly that literal substring, full path or basename. No target
    // value fixes this: the signal is not in the text.
    const findings = truth.map((entry) => ({ lens: entry.lens, summary: entry.summary }));
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.matched).toBe(0);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.unclassified).toBe(4);
    expect(result.recall).toBe(0);
    for (const entry of result.perEntry) {
      expect(entry.found).toBe(false);
    }
  });

  it('negative: an unrelated finding does not match any of the four entries either', () => {
    const findings = [
      { lens: 'blast-radius', summary: 'the sweep concurrency pool default cap is set to four' },
    ];
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.matched).toBe(0);
    expect(result.unclassified).toBe(1);
    expect(result.recall).toBe(0);
  });
});

describe('score() against truncation-mechanism-overclaim (defect, target src/review/verifyFindings.ts) — DISCOVERED GAP', () => {
  const truth = loadTruthFor('truncation-mechanism-overclaim');

  it('DOES NOT MATCH: the real captured summary names the function (checkQuote) and the mechanism, never the file — a genuine matcher limitation', () => {
    // No `detail` field on this entry either, confirmed by reading the
    // committed truth.json directly. The summary discusses checkQuote's
    // "truncated" branch and the whitespace/comment-marker normalisation it
    // uses, in depth — but never writes src/review/verifyFindings.ts, nor
    // its basename, anywhere in that text.
    const findings = [{ lens: truth[0].lens, summary: truth[0].summary }];
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.matched).toBe(0);
    expect(result.confirmedFalsePositives).toBe(0);
    expect(result.unclassified).toBe(1);
    expect(result.recall).toBe(0);
    const entry = result.perEntry.find((e) => e.id === truth[0].id);
    expect(entry.found).toBe(false);
  });

  it('negative: a finding naming a different, unrelated file does not match this entry', () => {
    const findings = [
      { lens: 'honesty', summary: 'src/review/parseReply.ts silently drops an unknown field' },
    ];
    let result;
    expect(() => {
      result = score(findings, truth);
    }).not.toThrow();
    expect(result.matched).toBe(0);
    expect(result.unclassified).toBe(1);
    expect(result.recall).toBe(0);
  });
});
