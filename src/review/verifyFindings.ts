// Checking a finding against the diff it claims to be about.
//
// A finding that asserts a search cannot be verified by asking the model
// whether it searched — that is the same "look and see" oracle this project
// has already learned not to trust (C1). What CAN be checked mechanically is
// narrower and cheaper: whether the evidence a finding names is actually
// there. The diff a lens reviewed is bytes this process already holds, so a
// quote that is not a substring of it, or an ABSENT claim about text the
// diff plainly contains, is not a judgement call — it is arithmetic.
//
// This does not prove a finding is RIGHT. A finding whose evidence checks out
// can still be a bad reading of good evidence, and that is not this file's
// business. What it rules out is narrower and is the one C2 named: a finding
// that cites a search it did not run, because what it cites is not in the
// material it was given. That is the failure this project has already paid
// for once — a reviewer asserted "grep across the whole source tree finds no
// test file referencing X"; the tests existed, in a file it never opened —
// and C3 records that the layer catching a manufactured finding is
// load-bearing and must be kept. This file is that layer for this panel.
//
// FAILS LOUD, NOT SILENT. A finding that cannot be verified is not dropped —
// dropping it would let the rest of a rejection stand as if nothing in it
// needed a second look, which is a quieter version of the exact defect C2
// describes. Instead the whole lens result is downgraded to `could_not_run`,
// the same channel an unreadable reply already uses (see `parseReply.ts`),
// carrying a reason that names every finding that failed and what about it
// did not check out. That is deliberately harsh: it also withholds any OTHER
// finding the same reply made, sound or not, because a reply that
// manufactured one claim has shown it will assert a search it did not run,
// and there is no mechanical way to tell that the rest of the same reply was
// any more careful. A manufactured finding costs more than a missed one — a
// missed finding leaves the code as it was; a manufactured one causes a
// change that was not needed and a reviewer who trusted it — so the
// asymmetry here is deliberate: one bad finding is enough to withhold the
// lens's whole say for this run, and `could_not_run` outranking `rejected`
// in `aggregate` (verdict.ts) is what makes that withholding visible at the
// level a reader actually looks at.
//
// Wired into `runPanel` (panel.ts), the only place that holds both a parsed
// `LensResult` and the `Subject.diff` it was parsed against.

import type { Finding, LensResult } from './verdict.js';

const QUOTE_PREVIEW = 80;

function preview(text: string): string {
  return text.length > QUOTE_PREVIEW ? `${text.slice(0, QUOTE_PREVIEW)}…` : text;
}

/**
 * Whether one finding's evidence actually holds up against the diff.
 *
 * A finding with no evidence at all is unverifiable, not innocent until
 * proven guilty — the whole point is that a bare claim gets no benefit of
 * the doubt. Evidence present but blank is treated the same way: every
 * string `includes('')`, so an empty quote would otherwise "verify" against
 * any diff at all, which is not a check.
 */
export function findingIsVerified(finding: Finding, diff: string): boolean {
  const evidence = finding.evidence;
  if (evidence === undefined || evidence.text.trim() === '') {
    return false;
  }
  return evidence.kind === 'quote' ? diff.includes(evidence.text) : !diff.includes(evidence.text);
}

function describeFailure(finding: Finding): string {
  const evidence = finding.evidence;
  if (evidence === undefined) {
    return `${JSON.stringify(finding.summary)} — carried no evidence`;
  }
  return evidence.kind === 'quote'
    ? `${JSON.stringify(finding.summary)} — quoted evidence not found in the diff: ${JSON.stringify(preview(evidence.text))}`
    : `${JSON.stringify(finding.summary)} — claimed absence of ${JSON.stringify(preview(evidence.text))}, which the diff contains`;
}

/**
 * Verify a lens's findings against the diff it reviewed.
 *
 * A no-op for `approved` and `could_not_run` — neither carries a claim to
 * check, and this function's only concern is claims. For `rejected`, every
 * finding is checked; if all hold up, the result is returned exactly as it
 * arrived — a sound rejection is not this file's business, and this is the
 * guarantee that a finding whose evidence is genuinely in the diff behaves
 * no differently than it did before this file existed.
 *
 * If any finding fails, the WHOLE result becomes `could_not_run` — see the
 * file header for why that is deliberate rather than a per-finding filter.
 */
export function verifyLensResult(result: LensResult, diff: string): LensResult {
  if (result.outcome !== 'rejected') {
    return result;
  }
  const failed = result.findings.filter((finding) => !findingIsVerified(finding, diff));
  if (failed.length === 0) {
    return result;
  }
  const reason = [
    `${String(failed.length)} of ${String(result.findings.length)} finding(s) did not verify ` +
      'against the diff, so the whole rejection is withheld:',
    ...failed.map((finding) => `  - ${describeFailure(finding)}`),
  ].join('\n');
  return { lens: result.lens, outcome: 'could_not_run', findings: [], reason };
}
