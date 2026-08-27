// No subprocess. Every case runs through a fake `CliRunner` that records
// what it was handed and answers with whatever the case needs — same
// convention `tests/anthropic.test.ts` uses for `HttpPost`: inject the
// transport primitive, drive it with a plain function, no module mocking.
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_ENV_VARS,
  allowedEnv,
  buildArgs,
  checkClaudeCliAvailable,
  claudeCliReviewer,
  CLAUDE_CLI_CREDENTIAL_ENV_VAR,
  type CliInvocation,
  type CliRunner,
} from '../src/review/claudeCli.js';
import { NoRoomToAnswerError } from '../src/review/panel.js';
import type { Prompt } from '../src/review/prompt.js';

const PROMPT: Prompt = {
  shared: 'SHARED-MARKER-6f21: the bar and the diff, identical for every lens',
  perLens: 'PERLENS-MARKER-9a04: the one dimension this reviewer reads along',
};

interface Call {
  readonly args: readonly string[];
  readonly input: string;
}

interface FakeRun {
  readonly impl: CliRunner;
  readonly calls: Call[];
}

function fakeRun(respond: () => Promise<CliInvocation>): FakeRun {
  const calls: Call[] = [];
  return {
    calls,
    impl: (args, input) => {
      calls.push({ args, input });
      return respond();
    },
  };
}

function invocation(overrides: Partial<CliInvocation> = {}): CliInvocation {
  return { stdout: '', stderr: '', exitCode: 0, signal: null, ...overrides };
}

/** A successful invocation whose stdout is `{ result, ...extra }`. */
function ok(result: string, extra: Record<string, unknown> = {}): FakeRun {
  return fakeRun(() =>
    Promise.resolve(invocation({ stdout: JSON.stringify({ result, ...extra }) })),
  );
}

/**
 * The error a call threw, or a failure saying it did not throw. Without the
 * last line, an assertion like `.not.toContain(...)` below would pass
 * against a call that never threw at all.
 */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected the call to throw, and it returned');
}

describe('buildArgs', () => {
  it('uses -p, --system-prompt (replace, never append), an empty --tools, json output, no persistence, and --safe-mode', () => {
    expect(buildArgs('SYS')).toEqual([
      '-p',
      '--system-prompt',
      'SYS',
      '--tools',
      '',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--safe-mode',
    ]);
  });

  it('never emits --bare or --append-system-prompt', () => {
    const args = buildArgs('anything');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('sends the given system prompt verbatim, once', () => {
    const args = buildArgs(PROMPT.shared);
    expect(args.filter((a) => a === PROMPT.shared)).toHaveLength(1);
  });
});

describe('allowedEnv', () => {
  // A realistic operator shell: the one credential this transport needs,
  // the base names every process needs, and a pile of things it must
  // never see — cloud credentials, another provider's key, an SSH agent
  // socket, a CI token. None of PATH/HOME/TMPDIR/CLAUDE_CODE_OAUTH_TOKEN
  // is what this test is pinning; UNDECLARED is.
  const OPERATOR_ENV: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/it',
    TMPDIR: '/tmp',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-reach-the-child',
    ANTHROPIC_API_KEY: 'sk-should-never-reach-the-child',
    AWS_SECRET_ACCESS_KEY: 'aws-should-never-reach-the-child',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GITHUB_TOKEN: 'gh-should-never-reach-the-child',
  };

  it('carries every ALLOWED_ENV_VARS name that is present in the source', () => {
    const child = allowedEnv(OPERATOR_ENV);
    for (const key of ALLOWED_ENV_VARS) {
      expect(child[key]).toBe(OPERATOR_ENV[key]);
    }
  });

  // THE MUTATION TARGET for finding two. An allowlist that merely names its
  // permitted set but still spreads the source through underneath — the
  // shape a denylist-to-allowlist rename can regress into by accident — has
  // every one of these still leaking. This is the one property `stripEnv`
  // never had and could not have: it deleted five names and passed
  // everything else, which is the opposite guarantee.
  it('does not let an undeclared variable in the source reach the child, however sensitive', () => {
    const child = allowedEnv(OPERATOR_ENV);
    expect(child['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(child['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child['SSH_AUTH_SOCK']).toBeUndefined();
    expect(child['GITHUB_TOKEN']).toBeUndefined();
    // Nothing beyond ALLOWED_ENV_VARS reached the child at all — not just
    // the four named above.
    expect(Object.keys(child).sort()).toEqual([...ALLOWED_ENV_VARS].sort());
  });

  it('carries the credential the review step declares, by name — CLAUDE_CODE_OAUTH_TOKEN specifically', () => {
    expect(ALLOWED_ENV_VARS).toContain(CLAUDE_CLI_CREDENTIAL_ENV_VAR);
    expect(allowedEnv(OPERATOR_ENV)[CLAUDE_CLI_CREDENTIAL_ENV_VAR]).toBe(
      OPERATOR_ENV[CLAUDE_CLI_CREDENTIAL_ENV_VAR],
    );
  });

  it('omits an allowed name the source simply does not have, rather than inventing it', () => {
    const child = allowedEnv({ PATH: '/usr/bin' });
    expect(child['HOME']).toBeUndefined();
    expect(child[CLAUDE_CLI_CREDENTIAL_ENV_VAR]).toBeUndefined();
    expect(child['PATH']).toBe('/usr/bin');
  });

  it('leaves the original object untouched — a copy, not a mutation', () => {
    allowedEnv(OPERATOR_ENV);
    expect(OPERATOR_ENV['ANTHROPIC_API_KEY']).toBe('sk-should-never-reach-the-child');
  });
});

describe('the wire format', () => {
  it('sends the shared half as --system-prompt, verbatim', async () => {
    const run = ok('VERDICT: approved');
    await claudeCliReviewer(run.impl)('honesty', PROMPT);
    const call = run.calls[0];
    const flagIndex = call?.args.indexOf('--system-prompt') ?? -1;
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(call?.args[flagIndex + 1]).toBe(PROMPT.shared);
  });

  it('sends the per-lens half as the single stdin turn, verbatim', async () => {
    const run = ok('VERDICT: approved');
    await claudeCliReviewer(run.impl)('honesty', PROMPT);
    expect(run.calls[0]?.input).toBe(PROMPT.perLens);
  });

  it('keeps the per-lens half out of the args entirely', async () => {
    const run = ok('VERDICT: approved');
    await claudeCliReviewer(run.impl)('honesty', PROMPT);
    expect(run.calls[0]?.args.join(' ')).not.toContain(PROMPT.perLens);
  });

  it('keeps the shared half out of stdin entirely', async () => {
    const run = ok('VERDICT: approved');
    await claudeCliReviewer(run.impl)('honesty', PROMPT);
    expect(run.calls[0]?.input).not.toContain(PROMPT.shared);
  });

  it('returns the reply text and nothing else, unwrapped from the JSON envelope', async () => {
    const run = ok('VERDICT: approved');
    const reply = await claudeCliReviewer(run.impl)('honesty', PROMPT);
    expect(reply).toBe('VERDICT: approved');
  });

  it('unwraps a reply carrying newlines, fences and non-ASCII unchanged', async () => {
    const text = 'VERDICT: rejected\nFINDING: uses ```code``` fences\nFINDING: and an — em dash';
    const run = ok(text);
    const reply = await claudeCliReviewer(run.impl)('honesty', PROMPT);
    expect(reply).toBe(text);
  });

  it('never surfaces total_cost_usd or per-model costUSD anywhere in the returned text', async () => {
    const run = ok('VERDICT: approved', {
      total_cost_usd: 0.0042,
      modelUsage: { 'claude-opus-5': { costUSD: 0.01 } },
    });
    const reply = await claudeCliReviewer(run.impl)('honesty', PROMPT);
    expect(reply).toBe('VERDICT: approved');
    expect(reply).not.toContain('0.0042');
  });
});

describe('failures', () => {
  it('throws naming the exit code and stderr on a non-zero exit', async () => {
    const run = fakeRun(() =>
      Promise.resolve(invocation({ exitCode: 1, stderr: 'auth failed: no session' })),
    );
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toContain('exited with code 1');
    expect(error.message).toContain('auth failed: no session');
  });

  // THE MUTATION TARGET for finding one. Before the fix, `CliInvocation` had
  // no `signal` field at all and `failureMessage` always read
  // `claude -p exited with code ${exitCode}` — so a SIGKILL-terminated run
  // and a bare `exitCode: null` with no signal were REPORTED IDENTICALLY,
  // both as "exited with code null". This pins that the two are now told
  // apart.
  it('reports a signal-terminated close distinguishably from a null exit carrying no signal', async () => {
    const killed = fakeRun(() =>
      Promise.resolve(invocation({ exitCode: null, signal: 'SIGKILL' })),
    );
    const killedError = await failureOf(claudeCliReviewer(killed.impl)('honesty', PROMPT));
    expect(killedError.message).toContain('SIGKILL');
    expect(killedError.message).not.toContain('code null');

    const nullExit = fakeRun(() => Promise.resolve(invocation({ exitCode: null, signal: null })));
    const nullExitError = await failureOf(claudeCliReviewer(nullExit.impl)('honesty', PROMPT));
    expect(nullExitError.message).toContain('code null');
    expect(nullExitError.message).not.toContain('signal');
  });

  // Reproduces the real failure this fix exists for: a genuine `claude -p`
  // run (this sandbox, not logged into any subscription) exits 1 with
  // EMPTY stderr and the actual reason on stdout, wrapped in the JSON
  // envelope `--output-format json` always produces — `is_error: true`,
  // `result: "Not logged in · Please run /login"`. Before this fix, this
  // exact case reached the caller as only "claude -p exited with code 1" —
  // the reason existed, was sitting right there, and was thrown away.
  it("recovers the reason from the JSON envelope's result field when stdout carries one, even though stderr is empty", async () => {
    const run = fakeRun(() =>
      Promise.resolve(
        invocation({
          exitCode: 1,
          stderr: '',
          stdout: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }),
        }),
      ),
    );
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toContain('exited with code 1');
    expect(error.message).toContain('Not logged in · Please run /login');
  });

  it('falls back to raw stdout on a non-zero exit when stdout is not JSON at all', async () => {
    const run = fakeRun(() =>
      Promise.resolve(
        invocation({ exitCode: 1, stderr: '', stdout: 'a plain-text failure, not an envelope' }),
      ),
    );
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toContain('exited with code 1');
    expect(error.message).toContain('a plain-text failure, not an envelope');
  });

  it('carries both the recovered reason and stderr when a non-zero exit has both, without duplicating an identical stderr', async () => {
    const run = fakeRun(() =>
      Promise.resolve(
        invocation({
          exitCode: 1,
          stderr: 'a distinct low-level warning',
          stdout: JSON.stringify({ is_error: true, result: "the CLI's own explanation" }),
        }),
      ),
    );
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toContain("the CLI's own explanation");
    expect(error.message).toContain('a distinct low-level warning');
  });

  it('throws when stdout is not valid JSON', async () => {
    const run = fakeRun(() => Promise.resolve(invocation({ stdout: 'not json at all' })));
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toBe(
      'claude -p --output-format json produced output that was not valid JSON',
    );
  });

  it('throws when the payload carries no string "result" field', async () => {
    const run = fakeRun(() =>
      Promise.resolve(invocation({ stdout: JSON.stringify({ something_else: true }) })),
    );
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toBe(
      'claude -p --output-format json did not carry a string "result" field',
    );
  });

  it('refuses even on exit 0 when the payload itself reports is_error: true', async () => {
    const run = fakeRun(() =>
      Promise.resolve(
        invocation({
          stdout: JSON.stringify({
            is_error: true,
            subtype: 'error_max_turns',
            result: 'ran out of turns',
          }),
        }),
      ),
    );
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toContain('is_error: true');
    expect(error.message).toContain('error_max_turns');
    expect(error.message).toContain('ran out of turns');
  });

  it('throws rather than reporting an empty reply as "reply was empty"', async () => {
    const run = ok('');
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error.message).toContain('empty result');
  });

  it('throws NoRoomToAnswerError specifically when stop_reason is max_tokens and the result is empty', async () => {
    const run = fakeRun(() =>
      Promise.resolve(
        invocation({ stdout: JSON.stringify({ result: '', stop_reason: 'max_tokens' }) }),
      ),
    );
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error).toBeInstanceOf(NoRoomToAnswerError);
  });

  it('does not classify an ordinary empty result as NoRoomToAnswerError', async () => {
    const run = ok('');
    const error = await failureOf(claudeCliReviewer(run.impl)('honesty', PROMPT));
    expect(error).not.toBeInstanceOf(NoRoomToAnswerError);
  });

  it('wraps a runner that throws (e.g. claude not on PATH) rather than letting it propagate raw', async () => {
    const run: CliRunner = () => Promise.reject(new Error('spawn claude ENOENT'));
    const error = await failureOf(claudeCliReviewer(run)('honesty', PROMPT));
    expect(error.message).toContain('could not run the claude CLI');
    expect(error.message).toContain('ENOENT');
  });

  // THE MUTATION TARGET for the CI review's finding: `CliRunner`'s own type
  // permits any rejection value, not just an `Error` -- a plain
  // `(cause as Error).message` on a non-Error rejection reads as `undefined`,
  // since a string has no `.message` property, and the real cause is thrown
  // away at exactly the boundary this file's header says never to.
  it('surfaces a non-Error rejection as its actual content, not the literal string "undefined"', async () => {
    const run: CliRunner = () => Promise.reject('ETIMEDOUT: spawn claude took too long');
    const error = await failureOf(claudeCliReviewer(run)('honesty', PROMPT));
    expect(error.message).toContain('ETIMEDOUT: spawn claude took too long');
    expect(error.message).not.toContain('undefined');
  });

  it('joins the block into one reply rather than throwing when result is present and non-empty', async () => {
    const run = ok('VERDICT: rejected\nFINDING: the only block');
    const reply = await claudeCliReviewer(run.impl)('honesty', PROMPT);
    expect(reply).toBe('VERDICT: rejected\nFINDING: the only block');
  });
});

describe('checkClaudeCliAvailable', () => {
  it('reports ok when --version exits 0', async () => {
    const run = fakeRun(() => Promise.resolve(invocation({ stdout: '2.1.243 (Claude Code)' })));
    const availability = await checkClaudeCliAvailable(run.impl);
    expect(availability.ok).toBe(true);
  });

  it('calls with exactly --version and empty input, no other args', async () => {
    const run = fakeRun(() => Promise.resolve(invocation({ stdout: '2.1.243' })));
    await checkClaudeCliAvailable(run.impl);
    expect(run.calls[0]?.args).toEqual(['--version']);
    expect(run.calls[0]?.input).toBe('');
  });

  it('reports not ok, naming the exit code and stderr, when --version exits non-zero', async () => {
    const run = fakeRun(() =>
      Promise.resolve(invocation({ exitCode: 127, stderr: 'command not found' })),
    );
    const availability = await checkClaudeCliAvailable(run.impl);
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('127');
    expect(availability.reason).toContain('command not found');
  });

  it('reports not ok, naming the failure, when the runner throws (e.g. ENOENT)', async () => {
    const run: CliRunner = () => Promise.reject(new Error('spawn claude ENOENT'));
    const availability = await checkClaudeCliAvailable(run);
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('ENOENT');
  });

  // Same mutation target as claudeCliReviewer's own case above, for this
  // catch site's copy of the same unguarded cast.
  it('reports a non-Error rejection as its actual content, not the literal string "undefined"', async () => {
    const run: CliRunner = () => Promise.reject('ETIMEDOUT: spawn claude took too long');
    const availability = await checkClaudeCliAvailable(run);
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('ETIMEDOUT: spawn claude took too long');
    expect(availability.reason).not.toContain('undefined');
  });
});
