// reportTargetPaths and ensureReportDir, driven directly — review-head.mjs
// itself carries no unit tests, for the same reason src/cli/review.ts does
// not (see its own header): it is process-boundary orchestration, git and a
// spawn and two console calls. This is the decision underneath it: where the
// report goes, and that the directory exists before anything tries to write
// into it.
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeReportOutcome,
  ensureReportDir,
  probeReportFile,
  REPORT_DIR,
  reportTargetPaths,
} from '../scripts/reportTarget.mjs';

const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const NOT_THERE = fileURLToPath(new URL('../no-such-report-file.md', import.meta.url));
const THROUGH_A_FILE = fileURLToPath(new URL('../package.json/report.md', import.meta.url));

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

  it("defaults the base to 'head', so review-head.mjs's own call is unchanged", () => {
    expect(reportTargetPaths('some-dir')).toEqual({
      dir: 'some-dir',
      markdown: join('some-dir', 'head.md'),
      json: join('some-dir', 'head.json'),
    });
  });

  // The discriminating case: two subjects reviewed into the same directory
  // must not collide on the same filename, or a branch review would
  // silently overwrite a commit review's report and neither could be told
  // apart afterward.
  it('accepts a different base, so a branch report and a commit report cannot collide on the same filename', () => {
    const head = reportTargetPaths('some-dir', 'head');
    const branch = reportTargetPaths('some-dir', 'branch');
    expect(branch).toEqual({
      dir: 'some-dir',
      markdown: join('some-dir', 'branch.md'),
      json: join('some-dir', 'branch.json'),
    });
    expect(branch.markdown).not.toBe(head.markdown);
    expect(branch.json).not.toBe(head.json);
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

describe('probeReportFile', () => {
  it('reports present for a file that is there', async () => {
    expect(await probeReportFile(PACKAGE_JSON)).toEqual({ kind: 'present' });
  });

  it('reports absent for a path that does not exist, distinct from a lookup failure', async () => {
    expect(await probeReportFile(NOT_THERE)).toEqual({ kind: 'absent' });
  });

  // A path that runs through a file is not ENOENT — it is a genuine lookup
  // failure (ENOTDIR), and must not be reported the same way as "not
  // there". This is exactly the case the bare `catch {}` this replaces could
  // not tell apart.
  it('reports unreadable, not absent, when the lookup itself fails', async () => {
    const result = await probeReportFile(THROUGH_A_FILE);
    expect(result.kind).toBe('unreadable');
    if (result.kind !== 'unreadable') throw new Error('unreachable');
    expect(result.reason).toContain('ENOTDIR');
  });
});

describe('describeReportOutcome', () => {
  const paths = reportTargetPaths('some-dir');

  it('reports both files written, as two separate facts, when both are present', () => {
    const text = describeReportOutcome(paths, { kind: 'present' }, { kind: 'present' });
    expect(text).toContain(`${paths.markdown} — written.`);
    expect(text).toContain(`${paths.json} — written.`);
  });

  // The exact case the honesty lens found: a message that asserted both
  // files existed after checking only one. This pins that the two are told
  // apart — the markdown written and the JSON absent must read as different
  // facts, not be folded into one claim built from a single check.
  it('says which file is missing when only one of the two was written', () => {
    const text = describeReportOutcome(paths, { kind: 'present' }, { kind: 'absent' });
    expect(text).toContain(`${paths.markdown} — written.`);
    expect(text).toContain(`${paths.json} — not written.`);
  });

  it('says which file is missing the other way round', () => {
    const text = describeReportOutcome(paths, { kind: 'absent' }, { kind: 'present' });
    expect(text).toContain(`${paths.markdown} — not written.`);
    expect(text).toContain(`${paths.json} — written.`);
  });

  it('reports neither as written when both are absent', () => {
    const text = describeReportOutcome(paths, { kind: 'absent' }, { kind: 'absent' });
    expect(text).toContain(`${paths.markdown} — not written.`);
    expect(text).toContain(`${paths.json} — not written.`);
  });

  it('reports a lookup failure distinctly from absence, naming the reason', () => {
    const text = describeReportOutcome(
      paths,
      { kind: 'unreadable', reason: 'EACCES: permission denied' },
      { kind: 'present' },
    );
    expect(text).toContain(
      `the report: ${paths.markdown} — could not confirm whether it was written: EACCES: permission denied`,
    );
    expect(text).not.toContain(`${paths.markdown} — not written.`);
  });
});
