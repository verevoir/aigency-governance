// review-branch.mjs, driven the way check-staleness-guard.mjs drives
// check-cli.mjs: spawn the real script against constructed fixtures — here,
// real temporary git repositories, since this script's whole job is to
// compute a diff between two refs and act on what it finds.
//
// Proven for real, with no model call: an invalid cap is refused before git
// is touched; an empty diff against the base exits 0; a too-large diff is
// refused and reads as a refusal rather than a rejection; a ref that does
// not exist is refused by name — both refs, if both are wrong — before
// anything is spawned or measured; and a branch other than the one checked
// out can be reviewed at all, without the tree ever moving off the branch it
// started on, which is the entire point of making both ends nameable.
//
// Two remaining outcomes — a diff under the cap that gets a genuine approved
// or rejected verdict — are NOT exercised here, and cannot be without a real
// model call: the difference between "the reviewer ran" (proven below,
// cheaply, by an unreachable lens set) and "the reviewer ran and approved"
// is exactly the one thing this suite cannot force without spending money.
// scripts/check-cli.mjs makes the identical trade, for the identical reason,
// in its own header.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

const REVIEW_BRANCH = resolvePath('scripts/review-branch.mjs');
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

function run(cwd, extraEnv = {}, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REVIEW_BRANCH, ...args], {
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

// main, with one commit, and a `feature` branch cut from it — with or
// without a further commit on `feature`, so the same builder covers both
// the empty-diff case and the has-a-diff cases. Ends checked out on
// `feature`.
async function makeRepo({ withChange }) {
  const dir = await mkdtemp(join(tmpdir(), 'aigency-review-branch-test-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'file.txt'), 'hello\n', 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'initial']);
  await git(dir, ['checkout', '-q', '-b', 'feature']);
  if (withChange) {
    await writeFile(join(dir, 'file.txt'), `hello\n${'x'.repeat(80)}\n`, 'utf8');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', 'change']);
  }
  return dir;
}

// main, plus two further branches cut from it, `topic-a` and `topic-b`,
// each with their own change — and ends checked out back on `main`, parked
// on neither. This is the fixture the no-checkout tests need: proof that a
// review of `topic-a` or `topic-b` never required moving off `main`.
async function makeMultiBranchRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'aigency-review-branch-test-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'file.txt'), 'hello\n', 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'initial']);

  await git(dir, ['checkout', '-q', '-b', 'topic-a']);
  await writeFile(join(dir, 'file.txt'), `hello\n${'a'.repeat(60)}\n`, 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'topic-a change']);

  await git(dir, ['checkout', '-q', 'main']);
  await git(dir, ['checkout', '-q', '-b', 'topic-b']);
  await writeFile(join(dir, 'file.txt'), `hello\n${'b'.repeat(60)}\n`, 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'topic-b change']);

  await git(dir, ['checkout', '-q', 'main']);
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

describe('review-branch.mjs', () => {
  it('refuses an invalid AIGENCY_REVIEW_BRANCH_MAX_CHARS before touching git at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aigency-review-branch-test-'));
    dirsToClean.push(dir);

    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_MAX_CHARS: 'not-a-number' });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('AIGENCY_REVIEW_BRANCH_MAX_CHARS must be a positive whole number');
  });

  it('exits 0 and reports nothing to review when the head has no diff against the base', async () => {
    const dir = await makeRepo({ withChange: false });
    dirsToClean.push(dir);

    const result = await run(dir);

    expect(result.code).toBe(0);
    expect(result.out).toContain('nothing to review');
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });

  it('refuses a too-large diff, naming both numbers and the gap, distinct from a rejection', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_MAX_CHARS: '1' });

    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/is \d+ characters, \d+ over the 1-character cap/);
    expect(result.out).toContain('This is a refusal to review, not a review that found a problem');
    expect(result.out).not.toContain('## Review:');
    expect(result.out).not.toContain('Judged by');
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });

  it('reaches the real reviewer for a diff under the cap, and lets it write its own report', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, { ANTHROPIC_API_KEY: FAKE_KEY });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('## Review: Could not run');
    expect(result.out).toContain('lens set');
    expect(result.out).toContain('Nothing was reviewed');

    // Defaults: base main, head HEAD resolved to the checked-out branch,
    // 'feature' — the filename this run should have produced.
    const markdown = await readFile(
      join(dir, '.review-report', 'branch__main__feature.md'),
      'utf8',
    );
    expect(markdown.length).toBeGreaterThan(0);
    const parsedJson = JSON.parse(
      await readFile(join(dir, '.review-report', 'branch__main__feature.json'), 'utf8'),
    );
    expect(parsedJson.ran).toBe(false);
    expect(typeof parsedJson.report).toBe('string');

    expect(result.out).toContain('branch__main__feature.md');
    expect(result.out).toContain('branch__main__feature.json');
  });

  it('refuses when the base ref does not exist, naming it before touching the diff', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_BASE: 'no-such-base' });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('the base ref, "no-such-base", does not exist in this repository');
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });

  it('refuses when the head ref does not exist, naming it before touching the diff', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_HEAD: 'no-such-head' });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('the head ref, "no-such-head", does not exist in this repository');
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });

  it('names both refs when both are invalid, rather than stopping at the first', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, {
      AIGENCY_REVIEW_BRANCH_BASE: 'no-such-base',
      AIGENCY_REVIEW_BRANCH_HEAD: 'no-such-head',
    });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('"no-such-base"');
    expect(result.out).toContain('"no-such-head"');
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });

  // The whole point of this turn: a diff between two refs needs no
  // checkout, so a tree parked on `main` can review `topic-a` and `topic-b`
  // without ever moving off `main` — and two different pairs reviewed from
  // the same tree land in two different files, neither overwriting the
  // other.
  it('reviews a branch other than the one checked out, moving the tree off it for neither', async () => {
    const dir = await makeMultiBranchRepo();
    dirsToClean.push(dir);

    const before = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    expect(before).toBe('main');

    const topicA = await run(dir, {
      ANTHROPIC_API_KEY: FAKE_KEY,
      AIGENCY_REVIEW_BRANCH_HEAD: 'topic-a',
    });
    expect(topicA.code).not.toBe(0);
    expect(topicA.out).toContain('## Review: Could not run');
    expect(topicA.out).toContain('topic-a vs main');

    const topicB = await run(dir, {
      ANTHROPIC_API_KEY: FAKE_KEY,
      AIGENCY_REVIEW_BRANCH_HEAD: 'topic-b',
    });
    expect(topicB.code).not.toBe(0);
    expect(topicB.out).toContain('topic-b vs main');

    // Neither review moved the tree off main.
    const after = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    expect(after).toBe('main');

    // Two different subjects, two different files — neither collided.
    const aMd = await readFile(join(dir, '.review-report', 'branch__main__topic-a.md'), 'utf8');
    const bMd = await readFile(join(dir, '.review-report', 'branch__main__topic-b.md'), 'utf8');
    expect(aMd).not.toBe(bMd);
    expect(aMd).toContain('topic-a vs main');
    expect(bMd).toContain('topic-b vs main');
  });

  // Precedence: positional, then environment, then default — see the file
  // header. This first case is the discriminating one: an implementation
  // that reads the environment first and ignores argv would pass every
  // other precedence test here and fail only this.
  it('a positional base argument overrides an environment variable naming a different base', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    // Env says the base is main, which genuinely differs from feature — if
    // that were honoured the diff would be non-empty. The positional
    // argument says the base is feature itself, which is also what is
    // checked out as HEAD — a self-diff, empty by construction, and
    // detectable only if the positional argument actually won.
    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_BASE: 'main' }, ['feature']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('feature vs feature');
    expect(result.out).toContain('nothing to review');
  });

  it('an environment variable sets the base when no positional argument is given', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_BASE: 'feature' });

    expect(result.code).toBe(0);
    expect(result.out).toContain('feature vs feature');
    expect(result.out).toContain('nothing to review');
  });

  it('falls back to the default base and head when neither positional nor environment name them', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir);

    expect(result.out).toContain('Reviewing feature vs main.');
  });

  it('treats an empty-string positional argument as absent, falling through to environment', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_BASE: 'feature' }, ['']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('feature vs feature');
    expect(result.out).toContain('nothing to review');
  });

  it('refuses more than two positional arguments, naming the count', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, {}, ['main', 'feature', 'extra']);

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('at most two positional arguments are accepted');
    expect(result.out).toContain('3');
  });
});
