// Where the review release step's own report lands.
//
// A separate module from review-head.mjs so the path arithmetic and the
// directory it requires can be driven by a test without spawning anything —
// review-head.mjs itself is process-boundary orchestration (git, spawn,
// print) in the same sense src/cli/review.ts is, and carries no unit tests
// of its own for the same reason (see its own header).
//
// writeReportFiles (src/cli/reportFile.ts) deliberately does not create
// directories — a write into a path nobody prepared is exactly the failure
// judgement 2 there exists to catch. Something upstream has to make the
// directory exist first, and this is where the release step does it.

import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Ignored by git (see .gitignore) and, deliberately, not under dist/: dist/
 * is wiped by every build, and the report should outlive one — a caller
 * asking "what did the last review say" after a rebuild should still find
 * it.
 */
export const REPORT_DIR = '.review-report';

export function reportTargetPaths(dir = REPORT_DIR) {
  return {
    dir,
    markdown: join(dir, 'head.md'),
    json: join(dir, 'head.json'),
  };
}

export async function ensureReportDir(dir = REPORT_DIR) {
  await mkdir(dir, { recursive: true });
}

/**
 * Whether one report file is there, told apart from whether looking for it
 * failed. `access()` throwing ENOENT means the file genuinely is not there;
 * anything else — a permission error, a path running through a file — means
 * the check itself did not complete, which is a different fact and must not
 * read as the first one. A bare `catch {}` in an earlier version of
 * review-head.mjs folded both into "no file was written there" — the
 * review panel's own failure-modes lens found this against the code that
 * calls this function.
 */
export async function probeReportFile(path) {
  try {
    await access(path);
    return { kind: 'present' };
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return {
      kind: 'unreadable',
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function describeOne(label, path, probe) {
  if (probe.kind === 'present') {
    return `${label}: ${path} — written.`;
  }
  if (probe.kind === 'absent') {
    return `${label}: ${path} — not written. See the failure above.`;
  }
  return `${label}: ${path} — could not confirm whether it was written: ${probe.reason}`;
}

/**
 * The two facts a caller actually has after a run: whether the markdown
 * landed, and whether the JSON landed. `writeReportFiles`
 * (src/cli/reportFile.ts) is two separate writes, so one succeeding is no
 * evidence about the other. A message built by checking only the markdown
 * and then asserting both existed is what the review panel's honesty lens
 * caught against an earlier version of review-head.mjs — this returns two
 * lines, one per file, so the claim matches what was actually observed.
 */
export function describeReportOutcome(paths, markdownProbe, jsonProbe) {
  return [
    describeOne('the report', paths.markdown, markdownProbe),
    describeOne('the structured findings', paths.json, jsonProbe),
  ].join('\n');
}
