#!/usr/bin/env node
// The process boundary, and deliberately the only thing here.
//
// Everything that decides anything lives in `run.ts`, where it is tested with
// fakes. What is left is what cannot be: reading argv and stdin, constructing
// the two adapters, printing, and choosing an exit code. If a branch appears
// in this file that is not visible from `runReview`, it has been put in the
// wrong place.

import { stdin } from 'node:process';
import process from 'node:process';

import { anthropicReviewer } from '../review/anthropic.js';
import { keyFileReader, lensReaderFor } from '../review/readers.js';
import { runReview } from './run.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    chunks.push(chunk as string);
  }
  return chunks.join('');
}

// The one report this file ever writes for a failure it did not itself
// decide — as opposed to `runReview`'s own reports, which are a verdict
// about the change. Shared by both places that can reach it (the promise
// rejection below, and the process-level handlers further down) so the
// wording cannot drift into two different descriptions of the same kind of
// failure.
function boundaryFailureReport(cause: unknown): string {
  return [
    '## Review: Could not run',
    '',
    `Unexpected failure at the process boundary: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    '',
    'This is a defect in the runner, not a verdict about the change.',
  ].join('\n');
}

// A crash `main()`'s own promise chain never sees. A synchronous throw before
// `main()` is even called would be one way; the realistic one is an
// unhandled rejection from a promise this file never awaited, somewhere
// deeper in the panel or reviewer stack — `fetch` calls that are started and
// not properly chained are the likeliest source. Either bypasses
// `main().then(resolve, reject)` below entirely: left to Node's own default
// handling, the process would exit 1 and write a stack trace to STDERR,
// never touching review.md at all — indistinguishable, from anything reading
// this process's output, from `runReview`'s own designed exit(1) for an
// ordinary rejected verdict. `report.ts`'s `exitCodeFor` is deliberately,
// testedly binary (see its own comment: "0 only for an approval... only an
// approval is zero"), so a third exit code was never going to be able to
// carry this distinction, and giving it one here would mean widening that
// invariant for every caller of this binary to serve one workflow's
// artefact. Reporting it the same way the existing rejection path already
// does, instead, means anything already parsing this process's stdout for a
// recognised heading keeps working without needing to know this exists.
//
// Two explicit calls, one per event, rather than a loop over both event
// names: each event's own listener type differs (`UncaughtExceptionListener`
// takes an `Error`, `UnhandledRejectionListener` takes a `reason` and the
// rejected `Promise`), and a loop would ask TypeScript to resolve the right
// overload for a union-typed event name, which is not guaranteed to hold
// across type-definition versions the way two calls against their own single
// literal event are.
//
// What this still cannot catch, named rather than left implied: this file's
// process dying BELOW the JS layer entirely — a segfault, or the runner
// OOM-killing or timing out the whole step — never reaches a JS event
// handler of any kind, this one included. `review.yml`'s own "Review" and
// "Assemble the review artefact" steps are where that residual case is
// caught instead, from outside this process, by its exit code; see the
// comments there for exactly what that outer boundary still owns.
process.on('uncaughtException', (cause: unknown) => {
  process.stdout.write(`${boundaryFailureReport(cause)}\n`, () => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (cause: unknown) => {
  process.stdout.write(`${boundaryFailureReport(cause)}\n`, () => {
    process.exit(1);
  });
});

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
      review: anthropicReviewer(
        { apiKey: settings.apiKey, model: settings.model, maxTokens: settings.maxTokens },
        (url, init) => fetch(url, init),
      ),
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
    // Last resort for a rejection of `main()` itself, as opposed to the
    // process-level handlers above, which cover a crash `main()`'s own
    // promise never sees. Reported as red and as unexpected, not folded
    // into the ordinary could-not-run wording that would make it look
    // handled — via the same shared report as those handlers, so the two
    // paths cannot describe the same kind of failure two different ways.
    process.stdout.write(`${boundaryFailureReport(cause)}\n`);
    process.exitCode = 1;
  },
);
