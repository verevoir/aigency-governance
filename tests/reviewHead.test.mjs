// review-head.mjs, driven the way review-branch.mjs and check-cli.mjs
// already are: spawn the real script against a constructed fixture
// repository, and read the actual files it writes off disk — not just its
// stdout.
//
// The gap this closes: a review found that review-head.mjs's report-writing
// wiring (constructing the report path, creating the directory, passing
// AIGENCY_REVIEW_REPORT into the spawned reviewer, then probing both files
// and printing the outcome) was exercised by no test — only the pure helper
// functions underneath it (reportTargetPaths, ensureReportDir,
// probeReportFile, describeReportOutcome — see tests/reportTarget.test.mjs)
// were unit-tested in isolation. The identical wiring in review-branch.mjs,
// added in the same diff, already had a real subprocess test proving it
// (tests/reviewBranch.test.mjs). This gives review-head.mjs the same proof
// its sibling already has: the discriminating claim is that the wiring
// runs and the files land, not that the helpers underneath it work.
//
// COST: NOTHING. review-head.mjs's own capture() always sets
// AIGENCY_REVIEW_LENSES to './review/lenses.json' — a path resolved
// relative to the spawned process's cwd, not to this repository's root.
// The fixture directory built below has no such file, so the compiled
// reviewer fails to load the lens set and reports "Could not run" before it
// ever builds a client or makes a request to the model — the identical
// mechanism tests/reviewBranch.test.mjs already relies on, for the same
// reason, in its own "reaches the real reviewer" test. ANTHROPIC_API_KEY is
// set to a fake value so the failure that surfaces is specifically the lens
// set, matching what that sibling test asserts on, rather than a missing
// key.
//
// THE FIXTURE NEEDS A REAL, NON-EMPTY DIFF AT HEAD — constructed, not
// simulated. review-head.mjs's empty-diff guard returns before
// ensureReportDir or the spawn ever run (see its own header), so exercising
// that branch would prove nothing about the report-writing wiring under
// test here; it is covered separately, below, precisely to keep the two
// apart.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

const REVIEW_HEAD = resolvePath('scripts/review-head.mjs');
const FAKE_KEY = 'not-a-real-key-and-must-never-need-to-be';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (err += String(chunk)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (${String(code)}): ${err}`));
        return;
      }
      resolve(out);
    });
  });
}

function run(cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REVIEW_HEAD], {
      cwd,
      env: { PATH: process.env.PATH, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

// One commit, with real content — a non-empty diff against the empty tree,
// which is what `git show --format= HEAD` reports for an initial commit
// that actually adds something. Matches makeRepo's shape in
// tests/reviewBranch.test.mjs.
async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'aigency-review-head-test-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'file.txt'), 'hello\n', 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const dirsToClean = [];

afterEach(async () => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('review-head.mjs', () => {
  it('reaches the real reviewer for HEAD, and lets it write its own report', async () => {
    const dir = await makeRepo();
    dirsToClean.push(dir);

    const result = await run(dir, { ANTHROPIC_API_KEY: FAKE_KEY });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('Reviewing HEAD: initial');
    expect(result.out).toContain('## Review: Could not run');
    expect(result.out).toContain('lens set');
    expect(result.out).toContain('Nothing was reviewed');

    // reportTargetPaths() with no arguments defaults to REPORT_DIR
    // ('.review-report') and base 'head' — see reportTarget.mjs — which is
    // exactly what review-head.mjs's own call, also with no arguments,
    // resolves to.
    // Not asserted equal to result.stdout: review-head.mjs prints its own
    // wrapper text (the "Reviewing HEAD: ..." line, the diff size, the
    // describeReportOutcome lines) around the reviewer's own output, so the
    // two are related but not identical — matching what
    // tests/reviewBranch.test.mjs already asserts (or rather does not) for
    // its sibling script's own report file, for the same reason.
    const markdown = await readFile(join(dir, '.review-report', 'head.md'), 'utf8');
    expect(markdown.length).toBeGreaterThan(0);
    expect(result.stdout).toContain(markdown.trim());

    const parsedJson = JSON.parse(await readFile(join(dir, '.review-report', 'head.json'), 'utf8'));
    expect(parsedJson.ran).toBe(false);
    expect(typeof parsedJson.report).toBe('string');

    // The two facts described separately, per describeReportOutcome — not
    // just written, but SAID to have been written.
    expect(result.out).toContain('head.md');
    expect(result.out).toContain('head.json');
    expect(result.out).toContain('written');
  });

  it('exits 1 and reports nothing to review when HEAD is an empty commit, writing no report files', async () => {
    const dir = await makeRepo();
    dirsToClean.push(dir);
    await git(dir, ['commit', '-q', '--allow-empty', '-m', 'empty']);

    const result = await run(dir, { ANTHROPIC_API_KEY: FAKE_KEY });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('HEAD has no diff to review');
    // The empty-diff guard returns before ensureReportDir ever runs — see
    // the file header — so nothing should exist on disk at all.
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });
});
