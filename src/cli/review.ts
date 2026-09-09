#!/usr/bin/env node
// The process boundary, and deliberately the only thing here.
//
// Everything that decides anything lives in `run.ts`, where it is tested with
// fakes. What is left is what cannot be: reading argv and stdin, constructing
// the two adapters, printing, and choosing an exit code. If a branch appears
// in this file that is not visible from `runReview`, it has been put in the
// wrong place.
//
// TWO REVIEWERS, SELECTED BY `settings.route`. `resolveSettings` (settings.ts)
// has already decided, before this file ever sees a `ReviewSettings`, whether
// the run is billed (a configured `ANTHROPIC_API_KEY`) or keyless (none
// configured — the laptop default, so the operator's metered credits stay
// reserved for GitHub Actions). This file's only remaining job for that
// decision is the one thing `run.ts` cannot do for itself: actually
// construct the client the chosen route needs. `settings.route === 'billed'`
// narrows `settings` to carry `apiKey: string` — TypeScript enforces that
// `anthropicReviewer` is never reachable without one, the same guarantee the
// old, single-route version of this file had by construction.

import { stdin } from 'node:process';
import process from 'node:process';

import { anthropicReviewer } from '../review/anthropic.js';
import { claudeCliReviewer } from '../review/claudeCli.js';
import { keyFileReader, lensReaderFor } from '../review/readers.js';
import type { ReviewDeps } from './run.js';
import { runReview } from './run.js';
import type { ReviewSettings } from '../review/settings.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    chunks.push(chunk as string);
  }
  return chunks.join('');
}

/**
 * The one branch this file exists to hold: which client `settings.route`
 * says to build.
 *
 * Exported and driven directly in `tests/review.test.ts` — an earlier
 * version of this comment claimed the wiring here was "exercised end to
 * end against the real compiled binary by the `cli` gate
 * (`scripts/check-cli.mjs`)", which a review found false: that gate's
 * scenarios all use an EMPTY diff, which makes `runReview` return before
 * `reviewerFor`'s result is ever called (see run.ts's empty-diff guard), so
 * the gate proves `settings.route` reaches `ready`/`keyless` and that
 * construction doesn't throw at import time — nothing about which reviewer
 * actually gets built or what it sends once invoked. `tests/review.test.ts`
 * calls the `Reviewer` this returns, against a stubbed `fetch` (billed) or
 * a mocked `@verevoir/llm/claude-cli` `chat()` (keyless), and asserts what
 * was actually sent — the route, the model, the key. `settings.route`'s
 * own resolution stays covered separately, in `tests/settings.test.ts`.
 */
export function reviewerFor(settings: ReviewSettings): ReviewDeps['review'] {
  return settings.route === 'billed'
    ? anthropicReviewer(
        { apiKey: settings.apiKey, model: settings.model, maxTokens: settings.maxTokens },
        (url, init) => fetch(url, init),
      )
    : claudeCliReviewer({ model: settings.model });
}

async function main(): Promise<number> {
  // The title is what a reader sees at the top of the report. It is an
  // argument rather than an env var because it is not configuration — it
  // changes on every run, and the workflow already knows it.
  const title = process.argv[2] ?? 'this change';
  const diff = await readAll(stdin);

  const outcome = await runReview(
    process.env,
    { title, description: '', diff },
    (settings) => ({
      // `settings` is passed straight through to `lensReaderFor` (readers.ts)
      // and nothing else: this file never itself writes an expression naming
      // a URL and a token together, because a branch deciding whether a
      // credential is safe to send belongs in a module a test can drive, not
      // in the process boundary this file is meant to stay free of. See
      // `lensReaderFor`'s own doc comment for what that omission is worth.
      read: lensReaderFor(settings, fetch),
      review: reviewerFor(settings),
    }),
    // The real key-file source. Constructed here, at the process boundary,
    // for the same reason `readerFor` and `anthropicReviewer` are: `run.ts`
    // is tested with fakes and touches no real filesystem unless this is the
    // one place that hands it one.
    keyFileReader(),
  );

  process.stdout.write(`${outcome.report}\n`);
  return outcome.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    // Last resort. Anything reaching here is a defect in the boundary itself,
    // since `runReview` returns rather than throws — so it is reported as
    // red and as unexpected, not folded into the ordinary could-not-run
    // wording that would make it look handled.
    process.stdout.write(
      `## Review: Could not run\n\nUnexpected failure at the process boundary: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n\nThis is a defect in the runner, not a verdict about the change.\n`,
    );
    process.exitCode = 1;
  },
);
