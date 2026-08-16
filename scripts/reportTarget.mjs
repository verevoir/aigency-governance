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

import { mkdir } from 'node:fs/promises';
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
