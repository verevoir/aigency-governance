// eval/criterion.mjs
//
// Classifies one swept configuration's result as good, bad or
// indistinguishable. The rule is stated once, in eval/README.md's "The
// bracket, not a leaderboard" section; CRITERION_RULE below carries that
// text verbatim so a reader of a results file never has to leave it to
// know what "good" meant that run.
//
// THE INPUT CONTRACT. This module did not exist on this branch (nor on
// main) even though eval/sweep.mjs has imported from it since the
// bracket-verdict feature landed - every eval-sweep* release step crashed
// at import time as a result. The shape below is discovered by reading
// eval/sweep.mjs's scoreOneConfiguration (where configResult is built),
// not guessed:
//
//   configResult = {
//     practiceCount: string,
//     width: number,
//     practiceSubsetSize: number,
//     lensSet: LensSet,
//     cases: [
//       {
//         caseId: string,
//         repeats: [
//           {
//             repeatIndex: number,
//             results: LensResult[],     // raw per-lens results; unused here
//             couldNotRunCount: number,  // verdict.unran.length - NOT a
//                                         // usability signal, see below
//             verdictOutcome: 'approved' | 'rejected' | 'could_not_run',
//             score:
//               | { error: string }      // truth.json missing/unparseable
//                                         // for this case, or score() itself
//                                         // threw - UNUSABLE
//               | {                      // eval/score.mjs's return shape
//                   matched: number,
//                   recall: number | null,
//                   confirmedFalsePositives: number,
//                   unclassified: number,
//                   perEntry: {
//                     id: string,
//                     target: string,
//                     verdict: 'defect' | 'not-a-defect',
//                     found: boolean,
//                     matchedBy: string[],
//                   }[],
//                   agreement: number,
//                 },
//           },
//         ],
//       },
//     ],
//   }
//
// USABILITY, resolved rather than invented: a repeat is usable, for every
// truth entry in its case, exactly when its `score` is the full
// eval/score.mjs shape (no `.error`). That is the one signal
// scoreOneConfiguration ever records for "can this repeat's score be
// trusted", and it is per (case, repeat) - not per entry - because
// score() runs once per repeat over that case's whole truth file.
// `couldNotRunCount` is deliberately not treated as a usability signal:
// eval/README.md states plainly that a could_not_run lens "is a real
// property of that configuration ... and is counted per configuration,
// never silently excluded from the total" - a repeat whose truth loaded
// and whose score() succeeded still carries a usable score even if some
// lenses inside it never ran.
//
// CORRECT_REJECTION_CASE_ID names the corpus's sharpest not-a-defect case
// for eval/README.md's prose ("the corpus's sharpest such case") and for
// the results file's `criterion` metadata (sweep.mjs:1542,
// `correctRejectionCaseId: CORRECT_REJECTION_CASE_ID` — reporting only,
// alongside CRITERION_RULE and the thresholds). classifyWidth below never
// reads it: every not-a-defect entry in `configResult` is scored by the
// same loop, against the same REJECT_THRESHOLD_OF_3, with no per-entry
// exemption. Value confirmed against eval/corpus/ on disk (not the
// README, which has already named one module that never existed): the
// directory is literally named practices-not-dead-code.

export const CATCH_THRESHOLD_OF_3 = 2;
export const REJECT_THRESHOLD_OF_3 = 2;
export const MIN_USABLE_REPEATS_OF_3 = 2;
export const CORRECT_REJECTION_CASE_ID = 'practices-not-dead-code';

export const CRITERION_RULE =
  'A width is **good** if, across the repeats, every `defect` corpus entry is caught ' +
  '(named by a finding) in at least `CATCH_THRESHOLD_OF_3` (2) of 3 repeats, **and** ' +
  'every `not-a-defect` entry is correctly rejected (never named by any finding) in at ' +
  'least `REJECT_THRESHOLD_OF_3` (2) of 3 repeats. It is **bad** if any entry fails its ' +
  'own threshold with enough usable data to judge. It is **indistinguishable** if fewer ' +
  'than `MIN_USABLE_REPEATS_OF_3` (2) of 3 repeats produced a usable score for some entry ' +
  'and nothing failed outright — too few usable calls to judge, not a verdict about quality.';

/**
 * Classify one swept configuration's result per CRITERION_RULE.
 *
 * Every not-a-defect entry in the corpus is held to the same bar, not only
 * a named one - a configuration that catches every real defect by flagging
 * everything is bad, exactly as the corresponding not-a-defect entry fails
 * its own reject threshold.
 *
 * @param {object} configResult - see the input-contract comment above.
 * @returns {{ verdict: 'good' | 'bad' | 'indistinguishable' }}
 */
export function classifyWidth(configResult) {
  const entryStats = new Map();

  for (const caseEntry of configResult.cases ?? []) {
    for (const repeat of caseEntry.repeats ?? []) {
      const score = repeat.score;
      if (!score || typeof score.error === 'string') {
        continue; // unusable: truth missing/unparseable, or score() threw
      }
      for (const entry of score.perEntry ?? []) {
        let stats = entryStats.get(entry.id);
        if (!stats) {
          stats = { verdict: entry.verdict, usableCount: 0, successCount: 0 };
          entryStats.set(entry.id, stats);
        }
        stats.usableCount += 1;
        const correct = entry.verdict === 'defect' ? entry.found : !entry.found;
        if (correct) {
          stats.successCount += 1;
        }
      }
    }
  }

  let failedOutright = false;
  let insufficientData = entryStats.size === 0;

  for (const stats of entryStats.values()) {
    if (stats.usableCount < MIN_USABLE_REPEATS_OF_3) {
      insufficientData = true;
      continue;
    }
    const threshold = stats.verdict === 'defect' ? CATCH_THRESHOLD_OF_3 : REJECT_THRESHOLD_OF_3;
    if (stats.successCount < threshold) {
      failedOutright = true;
    }
  }

  const verdict = failedOutright ? 'bad' : insufficientData ? 'indistinguishable' : 'good';
  return { verdict };
}
