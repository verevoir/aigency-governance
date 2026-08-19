// eval/score.mjs
//
// Pure scoring: given a panel's findings and a labelled corpus, reports how
// many known defects were recalled and how many findings are confirmed
// false positives. Deliberately does not report agreement as a headline
// number — design/tuned-constants-and-eval-harness.md found, empirically,
// that agreement is a diagnostic for why a configuration is bad, not
// evidence that it is good: five identical runs agreed perfectly on a wrong
// answer the same session a dissenting run of eight found a real, verified
// defect. `agreement` is returned here for exactly that diagnostic purpose
// and nothing else — see its own doc comment below.
//
// THE MATCHING PROBLEM, NAMED RATHER THAN HIDDEN. A Finding
// (src/review/verdict.ts) carries only `lens` and a one-sentence `summary`
// (`detail` sometimes) — no file, no line, no quote — because the reply
// contract (src/review/replyContract.ts) never asks a reviewer for one. So a
// finding cannot be matched to a truth entry by location; the only signal
// available is whether the finding's own prose happens to name the file the
// truth entry is about. `mentionsTarget`, below, matches a normalised
// (lower-cased) form of `summary` + `detail` against the truth entry's
// `target` path, tried both in full and as a basename. This is a WEAK
// matcher: a finding that names the right file for the wrong reason counts
// as a match, and a finding that is correct but never names the file is
// missed. It is forced by the reply contract carrying no structured
// location, not a design choice made freely — a future change giving
// findings a real location should replace this function outright, not
// tighten its heuristics.

function normalise(text) {
  return text.toLowerCase();
}

function basename(path) {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * Whether a finding's text plausibly refers to a truth entry's target.
 * Exported and named on its own so the weak-match heuristic lives in one
 * place a caller can point at, or override via `opts.match`, or replace.
 *
 * @param {{ summary: string, detail?: string }} finding
 * @param {string} target
 * @returns {boolean}
 */
export function mentionsTarget(finding, target) {
  const haystack = normalise([finding.summary, finding.detail ?? ''].join(' '));
  const full = normalise(target);
  const base = normalise(basename(target));
  return haystack.includes(full) || haystack.includes(base);
}

/**
 * DIAGNOSTIC ONLY — NEVER OPTIMISED AGAINST. How many distinct lenses
 * independently matched the same truth entry, averaged over the entries at
 * least one lens found. A configuration whose lenses all converge on the
 * same skim scores high here while finding nothing real; read `recall` and
 * `confirmedFalsePositives` for anything that should ever drive a decision.
 */
function agreementMean(perEntry) {
  const foundCounts = perEntry.map((entry) => entry.matchedBy.length).filter((count) => count > 0);
  if (foundCounts.length === 0) {
    return 0;
  }
  return foundCounts.reduce((sum, count) => sum + count, 0) / foundCounts.length;
}

/**
 * Score a panel's findings against a labelled corpus.
 *
 * Every finding is classified into exactly one bucket: `matched` (it names
 * at least one `defect` entry — a true positive, and what drives `recall`),
 * `confirmedFalsePositives` (it names at least one `not-a-defect` entry and
 * no `defect` entry), or `unclassified` (it names nothing in the corpus at
 * all). `unclassified` is NOT a false positive — it may be a real defect the
 * corpus does not know about, and counting it as one would make every
 * configuration look worse the more real work it did. A finding that names
 * both a defect entry and a not-a-defect entry is counted as `matched`: a
 * real finding does not stop being one because its text also happens to
 * mention an unrelated, already-cleared file.
 *
 * @param {readonly { lens: string, summary: string, detail?: string }[]} findings
 * @param {readonly { id: string, target: string, verdict: 'defect' | 'not-a-defect' }[]} truth
 * @param {{ match?: (finding: object, target: string) => boolean }} [opts]
 */
export function score(findings, truth, opts = {}) {
  if (!Array.isArray(findings)) {
    throw new TypeError('findings must be an array');
  }
  if (!Array.isArray(truth)) {
    throw new TypeError('truth must be an array');
  }

  // A truth entry with a verdict this module does not recognise is a corpus
  // mistake, not a silent `unclassified` — refused rather than dropped, the
  // same discipline parseLensSet applies to its own input.
  for (const entry of truth) {
    if (entry.verdict !== 'defect' && entry.verdict !== 'not-a-defect') {
      throw new RangeError(
        `truth entry ${JSON.stringify(entry.id)} has an unrecognised verdict ` +
          `${JSON.stringify(entry.verdict)}`,
      );
    }
  }

  const match = opts.match ?? mentionsTarget;
  const defectEntries = truth.filter((entry) => entry.verdict === 'defect');
  const notDefectEntries = truth.filter((entry) => entry.verdict === 'not-a-defect');
  const matchedLensesByEntry = new Map(truth.map((entry) => [entry.id, new Set()]));

  let matched = 0;
  let confirmedFalsePositives = 0;
  let unclassified = 0;

  for (const finding of findings) {
    const matchedDefects = defectEntries.filter((entry) => match(finding, entry.target));
    if (matchedDefects.length > 0) {
      matched += 1;
      for (const entry of matchedDefects) {
        matchedLensesByEntry.get(entry.id)?.add(finding.lens);
      }
      continue;
    }

    const matchedNotDefects = notDefectEntries.filter((entry) => match(finding, entry.target));
    if (matchedNotDefects.length > 0) {
      confirmedFalsePositives += 1;
      for (const entry of matchedNotDefects) {
        matchedLensesByEntry.get(entry.id)?.add(finding.lens);
      }
      continue;
    }

    unclassified += 1;
  }

  const perEntry = truth.map((entry) => {
    const matchedBy = [...(matchedLensesByEntry.get(entry.id) ?? [])].sort();
    return {
      id: entry.id,
      target: entry.target,
      verdict: entry.verdict,
      found: matchedBy.length > 0,
      matchedBy,
    };
  });

  const recalledDefects = perEntry.filter(
    (entry) => entry.verdict === 'defect' && entry.found,
  ).length;
  const recall = defectEntries.length === 0 ? null : recalledDefects / defectEntries.length;

  return {
    matched,
    recall,
    confirmedFalsePositives,
    unclassified,
    perEntry,
    agreement: agreementMean(perEntry),
  };
}
