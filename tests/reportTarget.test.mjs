// reportTargetPaths and ensureReportDir, driven directly — review-head.mjs
// itself carries no unit tests, for the same reason src/cli/review.ts does
// not (see its own header): it is process-boundary orchestration, git and a
// spawn and two console calls. This is the decision underneath it: where the
// report goes, and that the directory exists before anything tries to write
// into it.
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureReportDir, REPORT_DIR, reportTargetPaths } from '../scripts/reportTarget.mjs';

describe('reportTargetPaths', () => {
  it('names a markdown file and a JSON sibling under the given directory', () => {
    expect(reportTargetPaths('some-dir')).toEqual({
      dir: 'some-dir',
      markdown: join('some-dir', 'head.md'),
      json: join('some-dir', 'head.json'),
    });
  });

  it('defaults to REPORT_DIR when no directory is given', () => {
    expect(reportTargetPaths().dir).toBe(REPORT_DIR);
  });
});

describe('ensureReportDir', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aigency-report-target-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a directory that does not exist yet, including missing parents', async () => {
    const nested = join(root, 'a', 'b', 'c');

    await ensureReportDir(nested);

    const stats = await stat(nested);
    expect(stats.isDirectory()).toBe(true);
  });

  it('is idempotent against a directory that already exists', async () => {
    const dir = join(root, 'already-there');

    await ensureReportDir(dir);
    await ensureReportDir(dir);

    const entries = await readdir(root);
    expect(entries).toEqual(['already-there']);
  });
});
