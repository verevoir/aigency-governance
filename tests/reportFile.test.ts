// Where AIGENCY_REVIEW_REPORT sends the report, tested directly rather than
// through a subprocess: reportPaths, reportJson and withReportFile are all
// decision logic in the sense run.ts's own header means it — none of it
// needs a real model call, and the one thing that must stay real is the
// filesystem, so these use a real temporary directory rather than a fake fs.
// Whether wiring this into review.ts leaves stdout untouched is proven
// separately, end to end, in scripts/check-cli.mjs — that property cannot be
// checked in-process, for the same reason review.ts itself carries no unit
// tests of its own (see its header).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  reportJson,
  reportPaths,
  withReportFile,
  writeReportFiles,
} from '../src/cli/reportFile.js';
import type { ReviewOutcome } from '../src/cli/run.js';
import type { Verdict } from '../src/review/verdict.js';

const FAKE_VERDICT: Verdict = {
  outcome: 'approved',
  results: [{ lens: 'correctness', outcome: 'approved', findings: [] }],
  findings: [],
  unran: [],
};

const APPROVED: ReviewOutcome = {
  report: '## Review: Approved\n\nEvery lens reviewed and none had a finding.',
  exitCode: 0,
  verdict: FAKE_VERDICT,
};

// A no-panel outcome, exactly the shape runReview returns when the
// empty-diff guard fires: a report, and no `verdict` key at all.
const NO_PANEL: ReviewOutcome = {
  report: '## Review: Could not run\n\nThe diff was empty, so there was nothing to review.',
  exitCode: 1,
};

describe('reportPaths', () => {
  it('replaces a real extension with .json', () => {
    expect(reportPaths('report.md')).toEqual({ markdown: 'report.md', json: 'report.json' });
  });

  it('replaces only the final extension, in a nested directory', () => {
    expect(reportPaths('out/nested/report.md')).toEqual({
      markdown: 'out/nested/report.md',
      json: 'out/nested/report.json',
    });
  });

  it('appends .json when there is no extension', () => {
    expect(reportPaths('report')).toEqual({ markdown: 'report', json: 'report.json' });
  });

  it('appends .json for a dotfile, rather than treating the leading dot as one', () => {
    expect(reportPaths('.review')).toEqual({ markdown: '.review', json: '.review.json' });
  });

  it('treats a dot in an earlier path segment as unrelated to the extension', () => {
    expect(reportPaths('out.dir/report')).toEqual({
      markdown: 'out.dir/report',
      json: 'out.dir/report.json',
    });
  });
});

describe('reportJson', () => {
  it('is the Verdict, as-is, when a panel ran', () => {
    expect(reportJson(APPROVED)).toBe(FAKE_VERDICT);
  });

  it('is a distinct, explicit shape when no panel ran — not an empty Verdict', () => {
    expect(reportJson(NO_PANEL)).toEqual({ ran: false, report: NO_PANEL.report });
  });
});

describe('writeReportFiles and withReportFile, against a real temporary directory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aigency-report-file-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes nothing when the path is undefined', async () => {
    const result = await withReportFile(undefined, APPROVED);
    expect(result).toEqual({ exitCode: 0 });
  });

  it('writes nothing when the path is blank, matching how every other setting treats blank as absent', async () => {
    const result = await withReportFile('   ', APPROVED);
    expect(result).toEqual({ exitCode: 0 });
  });

  it('writes both files, and the markdown is the report verbatim', async () => {
    const markdownPath = join(dir, 'report.md');

    await writeReportFiles(markdownPath, APPROVED);

    const markdown = await readFile(markdownPath, 'utf8');
    expect(markdown).toBe(`${APPROVED.report}\n`);
  });

  it('the JSON round-trips to the same Verdict the panel produced', async () => {
    const markdownPath = join(dir, 'report.md');

    await writeReportFiles(markdownPath, APPROVED);

    const parsed: unknown = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    expect(parsed).toEqual(FAKE_VERDICT);
  });

  it('writes the no-panel shape, not a fabricated empty Verdict, when none ran', async () => {
    const markdownPath = join(dir, 'report.md');

    await writeReportFiles(markdownPath, NO_PANEL);

    const parsed: unknown = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    expect(parsed).toEqual({ ran: false, report: NO_PANEL.report });
  });

  it('preserves the outcome exit code on a successful write', async () => {
    const markdownPath = join(dir, 'report.md');

    const result = await withReportFile(markdownPath, APPROVED);

    expect(result).toEqual({ exitCode: 0 });
  });

  // Judgement 2: a write failure fails the run loudly, even overriding a
  // genuine approval's 0 — a green build for a review nobody can read is
  // worse than a red one that says why. Proven here with a real ENOENT
  // against a directory that was never created, rather than a fake, because
  // the failure only needs to be deterministic, and this is.
  it('fails the run, overriding even an approval, when the path cannot be written', async () => {
    const markdownPath = join(dir, 'does-not-exist', 'report.md');

    const result = await withReportFile(markdownPath, APPROVED);

    expect(result.exitCode).toBe(1);
    expect(result.failureMessage).toContain('defect in the runner');
    expect(result.failureMessage).toContain('not a verdict about the change');
  });
});
