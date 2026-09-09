// The keyless local transport: one lens, one model call, through
// `@verevoir/llm`'s published `claude-cli` adapter.
//
// ONE `claude -p` IMPLEMENTATION IN THE ESTATE, NOT TWO. This repository
// previously carried its own `node:child_process.spawn('claude', …)`
// (`aigency-governance` PR #13, `src/cli/reviewLocal.ts` + the decision
// logic that used to live at this same path) — a hand-rolled duplicate of
// exactly what `@verevoir/llm/claude-cli`'s `chat()` now does, published,
// with the same confirmed argv (`-p --system-prompt … --tools ""
// --output-format json --no-session-persistence --safe-mode`, plus
// `--strict-mcp-config` and an isolated `cwd` this repository's own copy
// never had) and the same credential allowlist (`PATH`, `HOME`, `TMPDIR`,
// `CLAUDE_CODE_OAUTH_TOKEN`, nothing else). That duplicate is retired, not
// resurrected, by this file — this module never imports `node:child_process`
// itself and never will.
//
// WHY THIS EXISTS ALONGSIDE anthropic.ts. `anthropic.ts` bills the
// operator's metered `ANTHROPIC_API_KEY` once per lens — the right transport
// for GitHub Actions, gating a merge once per pull request, where that key
// is always configured as a repository secret. This transport authenticates
// through the `claude` CLI's own logged-in subscription instead, and spends
// nothing against that key — the right default for a laptop, where the key
// usually is not configured and should not need to be. `settings.ts`
// decides which route a run gets, purely on whether a billed key is
// configured at all (`ReviewSettings.route`); this file is only ever
// reached on the keyless route, and never accepts or forwards a key — see
// `claudeCliReviewer` below.
//
// THE KNOWN GAP IN @verevoir/llm 0.26.0, DISCLOSED RATHER THAN SILENTLY
// WORKED AROUND. `chat()` reads `stdout` only on a CLEAN exit. On a
// non-zero exit it reports `describeExit(...)` plus `stderr` and nothing
// else (verevoir/llm src/claude-cli/index.ts, the `spawned.exitCode !== 0`
// branch). The single most likely real failure a first-time local user
// hits — `claude -p` not logged into any subscription — exits 1 with
// `stderr` EMPTY and the actual reason ("Not logged in · Please run
// /login") sitting in the JSON envelope's `result` field on `stdout`,
// which that branch never looks at. The result: that one failure surfaces
// from `chat()` as the bare `"claude -p exited with code 1"`, with nothing
// telling a reader why.
//
// Fixing `chat()` itself needs a code change and a publish in
// `@verevoir/llm` — not this repository's call to make, and NOT done here;
// see this repository's README for where that is recorded for the
// operator. `augmentBareExit` below is a disclosed, LOCAL, best-effort
// HINT, not a decoded reason: it matches only the exact reason-less shape
// `chat()` produces on this specific gap and appends a labelled guess at
// the likely cause. It never touches any other failure message — a
// spawn-level failure (`claude` missing from PATH entirely) already
// carries its own distinct, legible wording from `chat()`
// (`claudeCli.chat(): could not run the claude CLI — …`) and is left
// exactly as `chat()` produced it.
//
// A FAILURE NEVER BECOMES A REPLY. Every branch below throws (mirroring
// `anthropic.ts`'s own `Reviewer`); `runPanel` (panel.ts) turns a throw into
// `could_not_run` for that lens, the identical path a thrown `anthropic.ts`
// failure takes. There is no branch in this file, or in the `Reviewer` it
// returns, that turns a `claude` failure — CLI missing, not logged in,
// killed by a signal, anything else — into a returned string: an
// unreachable `claude` must never read as an empty or successful review.
// (An EMPTY reply, as opposed to a failed call, is caught one layer up:
// `parseReply` — shared by both transports — already reports empty text as
// `could_not_run`, "reply was empty", regardless of which transport
// produced it.)

import { chat } from '@verevoir/llm/claude-cli';

import { NoRoomToAnswerError, type Reviewer } from './panel.js';
import type { Prompt } from './prompt.js';

/**
 * The exact shape `@verevoir/llm/claude-cli`'s `chat()` produces for a
 * non-zero exit with EMPTY `stderr` — `describeExit()`'s own two forms
 * (an ordinary exit code, or a signal), with nothing appended after either.
 * `chat()` appends `stderr` only when it is non-empty (see that file's
 * `spawned.exitCode !== 0` branch), so this pattern matches precisely the
 * case where nothing beyond the bare exit description survived — which is
 * exactly the shape the "not logged in" failure takes (see the file
 * header). Deliberately narrow: a message carrying an actual `stderr`
 * reason is never touched, and a spawn-level failure
 * (`claudeCli.chat(): could not run the claude CLI — …`, e.g. `claude` not
 * on `PATH` at all) never matches this pattern in the first place — that
 * failure is already legible and distinct, and must stay so.
 */
const BARE_EXIT_PATTERN = /^claude -p (?:exited with code -?\d+|was killed by signal \S+)$/;

/**
 * Appends a disclosed, best-effort hint to a `chat()` failure message that
 * matches {@link BARE_EXIT_PATTERN} exactly. Every other message — including
 * one that already carries a `stderr` reason, or a spawn-level failure — is
 * returned byte-for-byte unchanged: this never claims to explain a failure
 * shape it has not matched precisely, and never collapses two distinct
 * failure reasons into one wording.
 *
 * Exported so the exact wording — and the fact that it is labelled as a
 * guess rather than a decoded reason — is asserted by a test rather than
 * merely read in this comment.
 */
export function augmentBareExit(message: string): string {
  if (!BARE_EXIT_PATTERN.test(message)) {
    return message;
  }
  return (
    `${message} (no further detail was available from the CLI). This most often means ` +
    'the `claude` CLI is not logged into a subscription — try `claude setup-token`, or an ' +
    'interactive `claude` login. This is a GUESS, not a decoded reason: as of ' +
    "@verevoir/llm 0.26.0, its claude-cli adapter does not read the CLI's own stdout on a " +
    'non-zero exit, so the true reason (if this guess is wrong) cannot be recovered here. ' +
    "See this repository's README, \"Running it locally\", for the upstream gap this works " +
    'around.'
  );
}

export interface ClaudeCliOptions {
  /**
   * Sent as `--model` (`@verevoir/llm/claude-cli`'s `ChatOptions.model`) —
   * pinned to the same value the billed route sends
   * (`settings.ts`'s `DEFAULT_MODEL` / `AIGENCY_REVIEW_MODEL`), which is the
   * exact case that field exists for: the SAME model answering across two
   * transports of one provider, not two models that merely share a class
   * label. Omitted entirely (never sent) when absent, leaving the `claude`
   * CLI's own default model selection untouched.
   */
  readonly model?: string;
}

/**
 * A `Reviewer` backed by `@verevoir/llm/claude-cli`'s `chat()` — the
 * keyless local transport.
 *
 * `prompt.shared` is sent as the system prompt; `prompt.perLens` is the
 * single user turn — the same split, in the same order, `anthropic.ts`
 * sends over HTTP (see `prompt.ts`'s own ordering contract: "shared must
 * precede perLens in whatever is finally sent"). `apiKey` is never set on
 * the call this makes — this transport authenticates however the
 * installed `claude` CLI is already logged in, never a supplied
 * credential, and `@verevoir/llm`'s own `chat()` refuses outright if one
 * is passed.
 */
export function claudeCliReviewer(options: ClaudeCliOptions = {}): Reviewer {
  return async (_lensId: string, prompt: Prompt): Promise<string> => {
    try {
      const reply = await chat({
        systemPrompt: prompt.shared,
        turns: [{ role: 'user', content: prompt.perLens }],
        ...(options.model === undefined ? {} : { model: options.model }),
      });
      return reply.content;
    } catch (cause) {
      const message = augmentBareExit(cause instanceof Error ? cause.message : String(cause));
      // Preserve the class through augmentation rather than rewrap into a
      // plain Error - mirrors anthropic.ts's own catch. Nothing on this
      // transport constructs a NoRoomToAnswerError itself (an empty reply is
      // caught one layer up, by the shared parseReply - see the file
      // header), but a future caller's rejection should not lose the class
      // on its way through this one.
      throw cause instanceof NoRoomToAnswerError
        ? new NoRoomToAnswerError(message)
        : new Error(message);
    }
  };
}
