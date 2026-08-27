// The transport: one lens, one model call — through the real `claude` CLI's
// non-interactive print mode (`claude -p`), rather than the Anthropic
// Messages API.
//
// WHY THIS EXISTS. `anthropic.ts` bills a purchased API key once per lens,
// every time it runs. That is fine for a merge-gating CI check, run once per
// pull request — but `scripts/review-head.mjs` (the local, iteration-time
// entry point) was wired to the same transport, so every local run during
// active work on this repository spent the same metered key a CI run does.
// That is the wrong trade during iteration, where a reviewer runs many times
// against small, changing diffs: purchased credits are meant to last, and a
// subscription (`claude -p`, under a `claude setup-token` / interactive
// login) is the sanctioned, already-paid-for route for exactly this kind of
// call. Nothing about the panel, the lens set, or the reply contract changes
// — only which substrate answers.
//
// THE SAME CONTRACT, TWO SUBSTRATES. `parseReply` (parseReply.ts) reads the
// same VERDICT:/FINDING: text regardless of which transport produced it —
// that shared contract is the entire value of running the same panel two
// ways, and it would be lost the moment either transport started
// interpreting beyond "what is the reply text". So every bit of JSON
// unwrapping this file does happens HERE, once, and `textFrom` below is the
// only place it happens. Nothing here ever reaches into `parseReply` to
// teach it a second reply shape.
//
// REFUSE, NEVER SUBSTITUTE. This transport has no fallback ladder and none
// is added here: if `claude` cannot be run at all, every call this file
// makes throws, `runPanel` turns that into `could_not_run` for the lens, and
// nothing here reaches for a billed key instead. There is no branch in this
// file that could spend one — see `allowedEnv` below for how that is
// enforced even against an operator's own shell carrying one.
import { NoRoomToAnswerError, type Reviewer } from './panel.js';
import type { Prompt } from './prompt.js';

/** What one invocation of the CLI produced. */
export interface CliInvocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /**
   * The signal that terminated the process, or `null` when it exited under
   * its own steam. Node's `child_process` guarantees exactly one of
   * `exitCode`/`signal` is non-null on `'exit'`/`'close'` — `exitCode` is
   * `null` PRECISELY WHEN the child was killed by a signal (SIGTERM from a
   * timeout, SIGKILL from an OOM killer, anything else), not as some other,
   * unrelated shape of "no exit code". Carried through so a signal-
   * terminated run is reported distinguishably from a bare "exited with
   * code null" instead of the two collapsing into the same message — see
   * `describeExit` below.
   */
  readonly signal: NodeJS.Signals | null;
}

/**
 * Runs one `claude` CLI invocation, writing `input` to its stdin and
 * capturing stdout/stderr/exit code.
 *
 * Shaped as a single plain async function — not as an injected `spawn` — so
 * the real implementation (`node:child_process`, wired at the process
 * boundary, `cli/reviewLocal.ts`) and a test fake are both trivial to write
 * and to read. Same convention `HttpPost` sets in `anthropic.ts`: inject the
 * transport primitive this module actually needs, not the whole
 * standard-library surface behind it. This file never imports
 * `node:child_process` itself.
 */
export type CliRunner = (args: readonly string[], input: string) => Promise<CliInvocation>;

/**
 * The base environment names every invocation gets, regardless of what else
 * is permitted — mirrors `verevoir/aigency-runtime`'s `gate-runner.ts`
 * `BASE_ENV_NAMES` exactly, for the same reason: PATH so the `claude`
 * binary can be found at all, HOME because node/npm-adjacent tooling under
 * it reads per-user configuration and cache from it and fails in obscure
 * ways without it, TMPDIR because a build writes scratch files and the
 * fallback is not writable everywhere. Nothing else — this list stays
 * boring on purpose; anything added to it is handed to `claude` on every
 * invocation forever.
 */
const BASE_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR'] as const;

/**
 * The one credential this transport authenticates with — a subscription
 * OAuth token, not the billed `ANTHROPIC_API_KEY` this whole file exists to
 * avoid spending. Declared as a single named constant rather than as a
 * string literal repeated wherever it is needed, so {@link ALLOWED_ENV_VARS}
 * below and anything else that has to name this credential are reading the
 * SAME name rather than two names that merely happen to agree today — the
 * outer `review` release step this composition runs under declares exactly
 * this variable, and this constant is what keeps the two from drifting
 * apart.
 */
export const CLAUDE_CLI_CREDENTIAL_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Every environment variable name the `claude` child process is permitted
 * to see — an ALLOWLIST, built from {@link BASE_ENV_NAMES} plus
 * {@link CLAUDE_CLI_CREDENTIAL_ENV_VAR}, never independently.
 *
 * REPLACES an earlier `STRIPPED_ENV_VARS`/`stripEnv` DENYLIST that deleted
 * five named Anthropic/Bedrock/Vertex variables and passed everything else
 * in the operator's environment through to the child unchanged — other
 * cloud credentials, other API tokens, `SSH_AUTH_SOCK`, `GITHUB_TOKEN`,
 * all of it, handed to a third-party CLI subprocess. The outer boundary
 * this release step runs under already narrows to an explicit allowlist
 * (PATH, HOME, TMPDIR plus this one declared credential — see
 * `aigency.json`'s `review` step); this file now reasons for least surface
 * the same way at both boundaries instead of an allowlist at one and a
 * denylist one hop further in, handing the wider surface to the same
 * subprocess the outer boundary was narrowing for.
 */
export const ALLOWED_ENV_VARS = [...BASE_ENV_NAMES, CLAUDE_CLI_CREDENTIAL_ENV_VAR] as const;

/**
 * The environment to hand the `claude` child process: every name in
 * {@link ALLOWED_ENV_VARS} that `env` actually carries, and nothing else —
 * never the original object, and never anything not on the allowlist, no
 * matter what the operator's own shell exports. A name on the allowlist
 * that `env` does not have is simply absent from the result, not an error
 * here: a missing `CLAUDE_CODE_OAUTH_TOKEN` is `claude` itself refusing to
 * authenticate, reported through the normal failure path, not a concern of
 * building the environment. Pure and exported so the POLICY (which
 * variables) is asserted directly by a test, with no subprocess spawned to
 * prove it; the MECHANISM (actually building the child's environment from
 * this) lives at the process boundary, the one place this composition
 * touches `node:child_process` at all.
 */
export function allowedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENV_VARS) {
    const value = env[name];
    if (value !== undefined) {
      child[name] = value;
    }
  }
  return child;
}

/**
 * Flags for every invocation. Confirmed from real `claude` 2.1.243 `--help`
 * output and a real `--output-format json` payload — the same confirmation
 * verevoir/llm#36's file header records in full; restated here only where
 * this composition's own choices depend on it.
 *
 *   `-p`                       print / non-interactive mode.
 *   `--system-prompt`          REPLACES the default system prompt — distinct
 *                              from `--append-system-prompt`, which appends
 *                              to it instead. `prompt.shared` (the bar and
 *                              the diff, identical for every lens) is sent
 *                              here, which preserves the ordering `Prompt`
 *                              documents (prompt.ts, "shared must precede
 *                              perLens in whatever is finally sent"):
 *                              whatever the CLI does internally, a system
 *                              prompt is positioned before the user turn
 *                              that follows it.
 *   `--tools ""`               a POSITIVE declaration of zero tool access,
 *                              per the CLI's own `--help` — not an
 *                              assumption resting on whatever the CLI
 *                              defaults to.
 *   `--output-format json`     the confirmed envelope `textFrom` (below)
 *                              parses.
 *   `--no-session-persistence` stateless — this composition makes one call
 *                              per lens and keeps nothing between them.
 *   `--safe-mode`, NEVER `--bare`. `--bare`'s own `--help` states Anthropic
 *                              auth under it is strictly `ANTHROPIC_API_KEY`
 *                              or `apiKeyHelper` — OAuth is never read —
 *                              which would either fail outright or spend
 *                              the very credits this script exists to
 *                              save. `--safe-mode` gives the same
 *                              determinism (CLAUDE.md, skills, plugins,
 *                              hooks, MCP servers, custom commands/agents
 *                              disabled) while leaving auth, model
 *                              selection, built-in tools and permissions
 *                              working normally.
 *
 * KNOWN LIMITATION, disclosed rather than solved here: `prompt.shared`
 * carries the diff and the practices bar and is sent as a command-line
 * argument, not over stdin. `review-head.mjs` scopes a review to one
 * commit's diff, which keeps this bounded in ordinary use, but a very large
 * practices corpus or an unusually large single-commit diff could still
 * exceed the OS argv-length ceiling. Moving `shared` to stdin instead would
 * dodge that ceiling but would put `perLens` before `shared` in whatever the
 * CLI actually sees — the exact ordering violation `Prompt`'s own doc
 * comment warns a transport not to make. Flagged rather than silently
 * risked either way; the fix, if the operator hits it, is a real design
 * decision and not a one-line change.
 */
export function buildArgs(systemPrompt: string): string[] {
  return [
    '-p',
    '--system-prompt',
    systemPrompt,
    '--tools',
    '',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--safe-mode',
  ];
}

/**
 * `--output-format json`'s confirmed envelope — the same shape
 * verevoir/llm#36 confirmed against a real invocation. Only the fields this
 * file reads are declared.
 */
interface ClaudeCliJsonResult {
  readonly result?: string;
  readonly is_error?: boolean;
  readonly subtype?: string;
  readonly stop_reason?: string;
  /**
   * Present in the real payload and DELIBERATELY UNUSED — same reasoning as
   * verevoir/llm#36's file header: the payload does not state whether this
   * figure is billed or notional, so asserting either would be an unbacked
   * claim. This transport already knows the stronger, certain fact
   * independently: no billed-credential env var this codebase knows about
   * reached the child process at all (see `ALLOWED_ENV_VARS`/`allowedEnv`
   * above — an allowlist that never named a billed credential in the first
   * place). Declared here as a field, not silently omitted from the type,
   * so a reader sees it was seen and set aside on purpose rather than
   * missed.
   */
  readonly total_cost_usd?: number;
}

/**
 * What the CLI itself said about a non-zero exit — or `undefined` if
 * nothing legible could be recovered from `stdout`.
 *
 * CONFIRMED, NOT ASSUMED, and confirmed by direct reproduction rather than
 * by reasoning about the code: a real `claude -p` failure (this sandbox,
 * not logged into any subscription) exits 1 with `stderr` EMPTY and the
 * actual reason — `"Not logged in · Please run /login"` — sitting on
 * `stdout`. With `--output-format json` (what `buildArgs` always sends),
 * the identical reason arrives wrapped in the JSON envelope's own `result`
 * field, alongside `is_error: true`. Before this function existed, that
 * reason was silently discarded: the caller only ever looked at `stderr`,
 * which was empty, so the thrown error carried nothing but the exit code —
 * this corpus's defining defect, reproduced in miniature: the reason
 * existed, was available, and was thrown away on the way out.
 *
 * ONLY THIS ONE FAILURE SHAPE HAS BEEN REPRODUCED. This function does not
 * assume every failure puts JSON on stdout, or that `result` is always
 * where the reason lives — it tries the JSON envelope first (the shape
 * confirmed for `buildArgs`'s own flags), falls back to raw stdout if
 * parsing fails or `result` is absent/empty, and returns `undefined` rather
 * than fabricate a reason when stdout itself is empty too.
 *
 * NO MASKING IS APPLIED HERE, and that is a deliberate limit, not an
 * oversight. `allowedEnv` already limits the child's OWN environment to
 * {@link ALLOWED_ENV_VARS} before it ever runs — so there is no known secret
 * value this composition hands the child (beyond the one credential it is
 * meant to have) that could be matched out of `stdout` the way a process
 * holding a known key value can mask it in its own logs. Scanning arbitrary
 * CLI output for credential-shaped text the CLI might print for reasons
 * unrelated to this composition's own environment would be improvising a
 * redactor against a failure shape nobody has reproduced — refused here for
 * exactly that reason. If a future failure shape is found to leak something
 * sensitive, that is a real problem to fix then, with evidence, not a
 * heuristic to guess at now.
 */
function reasonFromFailedInvocation(invocation: CliInvocation): string | undefined {
  const stdout = invocation.stdout.trim();
  if (stdout === '') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as ClaudeCliJsonResult;
    if (typeof parsed.result === 'string' && parsed.result !== '') {
      return parsed.result;
    }
  } catch {
    // Not JSON — or JSON without a usable `result` falls through below.
  }
  return stdout;
}

/**
 * How the process ended, described for a human reading a failure message.
 *
 * `exitCode` is `null` PRECISELY WHEN the child was terminated by a signal
 * — SIGTERM from a timeout, SIGKILL from an OOM killer, anything else that
 * sends one — not as some other, unrelated shape of "no exit code".
 * Collapsing that into "exited with code null" throws away the one piece of
 * information that would tell a signal kill apart from whatever else null
 * might otherwise mean, which is exactly the defect this corpus keeps
 * finding in other shapes: the cause was available and was not kept. This
 * checks `signal` FIRST, and unconditionally — Node never sets both, so
 * there is no case where checking `signal` first hides a real exit code.
 */
function describeExit(
  command: string,
  invocation: Pick<CliInvocation, 'exitCode' | 'signal'>,
): string {
  if (invocation.signal !== null) {
    return `${command} was killed by signal ${invocation.signal}`;
  }
  return `${command} exited with code ${String(invocation.exitCode)}`;
}

/**
 * The message for a non-zero exit — how the process ended (see
 * `describeExit`), then whatever {@link reasonFromFailedInvocation}
 * recovered from `stdout`, then `stderr` if it adds anything `stdout` did
 * not already say. Previously this was exit code and `stderr` alone; see
 * {@link reasonFromFailedInvocation}'s own comment for why that discarded
 * the CLI's actual explanation whenever it arrived on `stdout` instead,
 * which — confirmed by reproduction — is where it lives.
 */
function failureMessage(invocation: CliInvocation): string {
  const reason = reasonFromFailedInvocation(invocation);
  const stderr = invocation.stderr.trim();
  const parts = [describeExit('claude -p', invocation)];
  if (reason !== undefined) {
    parts.push(reason);
  }
  if (stderr !== '' && stderr !== reason) {
    parts.push(stderr);
  }
  return parts.join(': ');
}

/**
 * Pull the reply text out of one CLI invocation.
 *
 * This is the ONLY unwrapping this transport does, and it happens entirely
 * here — see the file header's "THE SAME CONTRACT, TWO SUBSTRATES". Every
 * failure throws, exactly like `anthropic.ts`'s own `textFrom`: `runPanel`
 * turns a throw into `could_not_run` for that lens and lets the others
 * finish, and a caught error returned as a string here would be parsed as a
 * reply.
 */
function textFrom(invocation: CliInvocation): string {
  if (invocation.exitCode !== 0) {
    throw new Error(failureMessage(invocation));
  }

  let parsed: ClaudeCliJsonResult;
  try {
    parsed = JSON.parse(invocation.stdout) as ClaudeCliJsonResult;
  } catch {
    throw new Error('claude -p --output-format json produced output that was not valid JSON');
  }

  // Confirmed real: the CLI can exit 0 while its own payload says
  // is_error: true. Exit code alone is not a sufficient failure signal.
  if (parsed.is_error) {
    throw new Error(
      `claude -p reported is_error: true (subtype=${parsed.subtype ?? 'unknown'})` +
        (typeof parsed.result === 'string' && parsed.result !== '' ? ` — ${parsed.result}` : ''),
    );
  }

  if (typeof parsed.result !== 'string') {
    throw new Error('claude -p --output-format json did not carry a string "result" field');
  }

  // Never returned as `''` to the caller. Same reasoning as anthropic.ts's
  // textFrom: an empty string would reach `parseReply` and be reported as
  // "reply was empty" — true about the reply and false about what happened,
  // since a reply of nothing IS what happened here (the process exited 0
  // with a well-formed envelope; the model simply wrote nothing into it).
  // `stop_reason: 'max_tokens'` with no text is the same cut-off-before-
  // answering case `NoRoomToAnswerError` exists for on the Anthropic side.
  if (parsed.result === '') {
    const stopReason = parsed.stop_reason ?? 'absent';
    const message = `claude -p returned an empty result, stop_reason ${stopReason}`;
    throw stopReason === 'max_tokens' ? new NoRoomToAnswerError(message) : new Error(message);
  }

  return parsed.result;
}

/**
 * A `Reviewer` backed by the real `claude` CLI's non-interactive print mode.
 *
 * `prompt.shared` is sent as the system prompt; `prompt.perLens` is sent as
 * the single stdin turn. See `buildArgs` for the full reasoning and the
 * known argv-length limitation this ordering accepts.
 */
export function claudeCliReviewer(run: CliRunner): Reviewer {
  return async (_lensId: string, prompt: Prompt): Promise<string> => {
    const args = buildArgs(prompt.shared);
    let invocation: CliInvocation;
    try {
      invocation = await run(args, prompt.perLens);
    } catch (cause) {
      // Refuse, don't fall back — there is no other credential or transport
      // this composition will reach for. `claude` being unusable (not on
      // PATH, not logged in) is could_not_run for this lens, never a
      // silent retry against a billed key. See the file header.
      throw new Error(
        `could not run the claude CLI — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return textFrom(invocation);
  };
}

export interface Availability {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * A cheap preflight: is the CLI usable at all, checked once, before the
 * panel would otherwise spend up to five lenses' worth of invocations each
 * discovering the same fact independently and reporting it five confusing
 * ways. Costs nothing against a billed key either way — `run` here goes
 * through the same allowlisted environment as every other call this
 * transport makes.
 */
export async function checkClaudeCliAvailable(run: CliRunner): Promise<Availability> {
  try {
    const invocation = await run(['--version'], '');
    if (invocation.exitCode !== 0) {
      return {
        ok: false,
        reason:
          describeExit('claude --version', invocation) +
          (invocation.stderr.trim() !== '' ? `: ${invocation.stderr.trim()}` : ''),
      };
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
