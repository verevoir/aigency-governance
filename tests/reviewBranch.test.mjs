// review-branch.mjs, driven the way check-staleness-guard.mjs drives
// check-cli.mjs: spawn the real script against constructed fixtures — here,
// real temporary git repositories, since this script's whole job is to
// compute `git diff main...HEAD` and act on what it finds.
//
// Three scenarios are exercised for real: too-large, empty, and reaching
// the reviewer at all. The two remaining outcomes — a branch that is under
// the cap and gets a genuine approved or rejected verdict — are NOT
// exercised here, and cannot be without a real model call: the difference
// between "the reviewer ran" (proven below, cheaply, by an unreachable lens
// set) and "the reviewer ran and approved" is exactly the one thing this
// suite cannot force without spending money. scripts/check-cli.mjs makes
// the identical trade, for the identical reason, in its own header.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

const REVIEW_BRANCH = resolvePath('scripts/review-branch.mjs');

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
    const child = spawn(process.execPath, [REVIEW_BRANCH], {
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
// the empty-diff case and the has-a-diff cases.
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
    // No git repo needed here — an invalid cap is a configuration mistake,
    // and the script is expected to fail before it ever runs `git`.
    const dir = await mkdtemp(join(tmpdir(), 'aigency-review-branch-test-'));
    dirsToClean.push(dir);

    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_MAX_CHARS: 'not-a-number' });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain('AIGENCY_REVIEW_BRANCH_MAX_CHARS must be a positive whole number');
  });

  it('exits 0 and reports nothing to review when the branch has no diff against main', async () => {
    const dir = await makeRepo({ withChange: false });
    dirsToClean.push(dir);

    const result = await run(dir);

    expect(result.code).toBe(0);
    expect(result.out).toContain('nothing to review');
    // Nothing was reviewed, so nothing should have been written.
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });

  it('refuses a too-large diff, naming both numbers and the gap, distinct from a rejection', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    // The cap is set absurdly low so any real diff — header included — is
    // over it, without needing to construct a genuinely huge file.
    const result = await run(dir, { AIGENCY_REVIEW_BRANCH_MAX_CHARS: '1' });

    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/is \d+ characters, \d+ over the 1-character cap/);
    expect(result.out).toContain('This is a refusal to review, not a review that found a problem');
    // The discriminating check: nothing here should read like the
    // reviewer's own output — a reader must not be able to mistake "too big
    // to review" for "reviewed and rejected".
    expect(result.out).not.toContain('## Review:');
    expect(result.out).not.toContain('Judged by');
    // Refused before anything was spawned, so nothing was written.
    expect(await exists(join(dir, '.review-report'))).toBe(false);
  });

  // Proves the reviewable path actually reaches the compiled reviewer
  // binary — spawns it, feeds it the diff, and lets it write its own report
  // — without spending a model call: AIGENCY_REVIEW_LENSES is left at its
  // hardcoded relative default, which does not exist inside this fixture
  // repository, so the lens set fails to load before any reviewer is ever
  // constructed. That failure is itself the proof: only a run that reached
  // the real binary and attempted to resolve a lens set could produce it.
  it('reaches the real reviewer for a diff under the cap, and lets it write its own report', async () => {
    const dir = await makeRepo({ withChange: true });
    dirsToClean.push(dir);

    const result = await run(dir, {
      ANTHROPIC_API_KEY: 'not-a-real-key-and-must-never-need-to-be',
    });

    expect(result.code).not.toBe(0);
    // This is the reviewer binary's own output, not review-branch.mjs's —
    // proof the diff-cap refusal path was NOT taken.
    expect(result.out).toContain('## Review: Could not run');
    expect(result.out).toContain('lens set');
    expect(result.out).toContain('Nothing was reviewed');

    // AIGENCY_REVIEW_REPORT was set to a branch-specific path, and the
    // reviewer wrote to it even though it could not run a panel — the same
    // no-panel shape reportFile.ts writes for review-head.mjs.
    const markdown = await readFile(join(dir, '.review-report', 'branch.md'), 'utf8');
    expect(markdown.length).toBeGreaterThan(0);
    const parsedJson = JSON.parse(
      await readFile(join(dir, '.review-report', 'branch.json'), 'utf8'),
    );
    expect(parsedJson.ran).toBe(false);
    expect(typeof parsedJson.report).toBe('string');

    // review-branch.mjs prints where it wrote, same as review-head.mjs.
    expect(result.out).toContain('branch.md');
    expect(result.out).toContain('branch.json');
  });
});
