// The local composition, driven end to end with fakes: no subprocess, no
// network, no filesystem. Everything `runLocalReview` touches arrives as an
// argument — same discipline `tests/run.test.ts` holds `runReview` to, and
// for the same reason: the real thing spawns `claude` once per lens, and the
// tests below assert exactly when it must not.
import { describe, expect, it } from 'vitest';

import { runLocalReview, type LocalReviewDeps } from '../src/cli/runLocal.js';
import type { ReadResult, SourceReader } from '../src/review/load.js';
import type { CliInvocation, CliRunner } from '../src/review/claudeCli.js';
import type { Subject } from '../src/review/prompt.js';
import {
  APPROVED_WORD,
  FINDING_MARKER,
  REJECTED_WORD,
  VERDICT_MARKER,
} from '../src/review/replyContract.js';
import { DEFAULT_LENS_SOURCE } from '../src/review/settings.js';

const SUBJECT: Subject = {
  title: 'a local review, spending no purchased credit',
  description: 'a subject reviewed through claude -p',
  diff: '+const x = 1;',
};

const TWO_LENSES = JSON.stringify({
  version: 1,
  lenses: [
    { id: 'correctness', title: 'Correctness', focus: 'does it do what it says' },
    { id: 'honesty', title: 'Honesty', focus: 'does it report what it observed' },
  ],
});

const APPROVE = `${VERDICT_MARKER} ${APPROVED_WORD}`;
const REJECT = `${VERDICT_MARKER} ${REJECTED_WORD}\n${FINDING_MARKER} a real finding`;

interface Calls {
  /** The sources the reader was asked for. */
  read: string[];
  /** How many times the availability preflight (`claude --version`) fired. */
  availabilityChecks: number;
  /** The lenses the runner was actually asked to review. One subprocess
   * spawn each — the number that would cost real wall-clock time. */
  reviewed: string[];
}

interface Harness {
  readonly deps: LocalReviewDeps;
  readonly calls: Calls;
}

interface HarnessOptions {
  readonly found?: ReadResult;
  /** `false` makes the availability preflight report unusable. */
  readonly available?: boolean;
  /** Per-lens reply text; defaults to an approval for every lens. */
  readonly reply?: (lensId: string) => string;
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: Calls = { read: [], availabilityChecks: 0, reviewed: [] };
  const found: ReadResult = options.found ?? { kind: 'text', text: TWO_LENSES };
  const available = options.available ?? true;
  const reply = options.reply ?? (() => APPROVE);

  const read: SourceReader = (source) => {
    calls.read.push(source);
    return Promise.resolve(found);
  };

  // A single fake CliRunner drives BOTH the preflight (`--version`, no
  // system-prompt flag) and the real per-lens calls (`--system-prompt`
  // present) — distinguished the same way claudeCliReviewer distinguishes
  // them for the real CLI: by which flags are present in `args`.
  const run: CliRunner = (args, input): Promise<CliInvocation> => {
    const isPreflight = args[0] === '--version';
    if (isPreflight) {
      calls.availabilityChecks += 1;
      if (!available) {
        return Promise.resolve({
          stdout: '',
          stderr: 'claude: command not found',
          exitCode: 127,
          signal: null,
        });
      }
      return Promise.resolve({
        stdout: '2.1.243 (Claude Code)',
        stderr: '',
        exitCode: 0,
        signal: null,
      });
    }
    // A real lens call: the per-lens prompt is the stdin `input`, and the
    // reply function has no way to see which lens this is from the args
    // alone, so the lens id is recorded from the shared prompt's own text
    // convention (buildPrompt writes "## Your lens: <title>" into perLens) —
    // simpler, and just as accurate, to key the reply by scanning `input`
    // for the lens id substring the fixture above declares.
    const lensId = input.includes('Honesty') ? 'honesty' : 'correctness';
    calls.reviewed.push(lensId);
    return Promise.resolve({
      stdout: JSON.stringify({ result: reply(lensId) }),
      stderr: '',
      exitCode: 0,
      signal: null,
    });
  };

  return { deps: { read, run }, calls };
}

describe('runLocalReview, given a diff with nothing in it', () => {
  const nothing: readonly { readonly what: string; readonly diff: string }[] = [
    { what: 'empty', diff: '' },
    { what: 'whitespace only', diff: '\n  \t\n' },
  ];

  for (const { what, diff } of nothing) {
    it(`is red and spawns nothing when the diff is ${what}`, async () => {
      const fakes = harness();

      const outcome = await runLocalReview({}, { ...SUBJECT, diff }, fakes.deps);

      expect(outcome.exitCode).toBe(1);
      expect(outcome.report).toContain('The diff was empty');
      expect(outcome.report).toContain('Nothing was reviewed');
      // No preflight, no read, no lens call — the earliest possible refusal.
      expect(fakes.calls.availabilityChecks).toBe(0);
      expect(fakes.calls.read).toEqual([]);
      expect(fakes.calls.reviewed).toEqual([]);
    });
  }
});

describe('runLocalReview, when claude is not usable', () => {
  it('refuses rather than reviewing, and never reaches the lens set or the panel', async () => {
    const fakes = harness({ available: false });

    const outcome = await runLocalReview({}, SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('The claude CLI is not usable');
    expect(outcome.report).toContain('command not found');
    expect(outcome.report).toContain('never falls back to a billed API key');
    expect(outcome.report).toContain('Nothing was reviewed');
    // The preflight fired exactly once — not once per lens.
    expect(fakes.calls.availabilityChecks).toBe(1);
    expect(fakes.calls.read).toEqual([]);
    expect(fakes.calls.reviewed).toEqual([]);
  });
});

describe('runLocalReview, given a lens set it cannot load', () => {
  const unavailable: readonly { readonly why: string; readonly found: ReadResult }[] = [
    { why: 'missing', found: { kind: 'missing', reason: 'ENOENT' } },
    { why: 'unreachable', found: { kind: 'unreachable', reason: 'HTTP 503' } },
    { why: 'malformed', found: { kind: 'text', text: '{ not json' } },
  ];

  for (const { why, found } of unavailable) {
    it(`is red, reviews nothing, and says "${why}"`, async () => {
      const fakes = harness({ found });

      const outcome = await runLocalReview({}, SUBJECT, fakes.deps);

      expect(outcome.exitCode).toBe(1);
      expect(outcome.report).toContain(why);
      expect(outcome.report).toContain(DEFAULT_LENS_SOURCE);
      expect(outcome.report).toContain('Nothing was reviewed');
      expect(fakes.calls.read).toEqual([DEFAULT_LENS_SOURCE]);
      expect(fakes.calls.reviewed).toEqual([]);
    });
  }
});

describe('runLocalReview, when the panel runs', () => {
  it('exits 0 and says so when every lens approves', async () => {
    const fakes = harness();

    const outcome = await runLocalReview({}, SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toContain('## Review: Approved');
    expect([...fakes.calls.reviewed].sort()).toEqual(['correctness', 'honesty']);
  });

  it('exits 1 and carries the finding when one lens rejects', async () => {
    const fakes = harness({ reply: (lensId) => (lensId === 'honesty' ? REJECT : APPROVE) });

    const outcome = await runLocalReview({}, SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('## Review: Rejected');
    expect(outcome.report).toContain('a real finding');
  });

  it('names the override, and not the default, when AIGENCY_REVIEW_LENSES is set', async () => {
    const fakes = harness();

    const outcome = await runLocalReview(
      { AIGENCY_REVIEW_LENSES: './review/lenses.json' },
      SUBJECT,
      fakes.deps,
    );

    expect(outcome.report).toContain('./review/lenses.json');
    expect(outcome.report).not.toContain(DEFAULT_LENS_SOURCE);
    expect(fakes.calls.read).toEqual(['./review/lenses.json']);
  });

  it('reads no ANTHROPIC_API_KEY-shaped setting at all — an env carrying one changes nothing', async () => {
    const fakes = harness();

    const withKey = await runLocalReview(
      { ANTHROPIC_API_KEY: 'sk-should-be-ignored' },
      SUBJECT,
      fakes.deps,
    );
    const withoutKey = await runLocalReview({}, SUBJECT, fakes.deps);

    expect(withKey.exitCode).toBe(withoutKey.exitCode);
    expect(withKey.report).not.toContain('sk-should-be-ignored');
  });
});
