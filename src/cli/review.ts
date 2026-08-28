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

import { anthropicReviewer, type ServedModelSink } from '../review/anthropic.js';
import { keyFileReader, lensReaderFor } from '../review/readers.js';
import { boundaryFailureReport, crashOutcome } from './crashGuard.js';
import { runReview } from './run.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    chunks.push(chunk as string);
  }
  return chunks.join('');
}

// `boundaryFailureReport` — the one report this file ever writes for a
// failure it did not itself decide — and `crashOutcome` — what a crash
// handler below should do about it, given whether `main()` has already
// settled — both live in `crashGuard.ts`, imported above, so a test can
// drive the decision with fakes rather than provoking Node's own crash
// machinery. See that file for the reasoning; this file only wires it to
// the real `process.on`, `process.stdout.write` and `process.exit`.

// A crash `main()`'s own promise chain never sees. A synchronous throw before
// `main()` is even called would be one way; the realistic one is an
// unhandled rejection from a promise this file never awaited, somewhere
// deeper in the panel or reviewer stack — `fetch` calls that are started and
// not properly chained are the likeliest source, and Node's own fetch/undici
// internals doing late socket cleanup are a documented source of exactly
// this shape, independent of anything this file's own code does. Either
// bypasses `main().then(resolve, reject)` below entirely: left to Node's own
// default handling, the process would exit 1 and write a stack trace to
// STDERR, never touching review.md at all.
//
// `mainSettled` is what makes the two cases below different. Before it is
// true, nothing else has reported anything — this crash IS the result, and
// is reported and exited on exactly as before this flag existed. Once true,
// a verdict already stands, correctly, and this crash is unrelated to it —
// see `crashGuard.ts`'s `crashOutcome` for the decision itself and why
// overwriting the verdict (the bug this flag fixes) and silently ignoring
// the crash (the same defect facing the other way) were both rejected in
// favour of recording it without touching the verdict or the exit code.
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
let mainSettled = false;

function handleBoundaryCrash(cause: unknown): void {
  const outcome = crashOutcome(cause, mainSettled);
  const exitCode = outcome.exitCode;
  if (exitCode === undefined) {
    process.stdout.write(outcome.text);
    return;
  }
  process.stdout.write(outcome.text, () => {
    process.exit(exitCode);
  });
}

process.on('uncaughtException', handleBoundaryCrash);
process.on('unhandledRejection', handleBoundaryCrash);

async function main(): Promise<number> {
  // The title is what a reader sees at the top of the report. It is an
  // argument rather than an env var because it is not configuration — it
  // changes on every run, and the workflow already knows it.
  const title = process.argv[2] ?? 'this change';
  const diff = await readAll(stdin);

  const outcome = await runReview(
    process.env,
    { title, description: '', diff },
    (settings) => {
      // One sink per run, constructed here rather than module-level: a
      // module-level slot would leak whichever model served the LAST run
      // that used this process into the NEXT one, if this binary were ever
      // reused across runs instead of exiting after one. It is not, today
      // — but a fact that happens to be true of how this file is currently
      // invoked is not something to build a shared mutable default on.
      const servedModel: ServedModelSink = {};
      return {
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
          servedModel,
        ),
        servedModel: () => servedModel.value,
      };
    },
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
    // Settled before the exit code is even assigned: the window between
    // `main()` returning and this line running is a single microtask, and
    // nothing else can run inside it. See `crashGuard.ts` for what
    // "settled" changes about how a crash from here on is handled.
    mainSettled = true;
    process.exitCode = code;
  },
  (cause: unknown) => {
    // Last resort for a rejection of `main()` itself, as opposed to the
    // process-level handlers above, which cover a crash `main()`'s own
    // promise never sees. Reported as red and as unexpected, not folded
    // into the ordinary could-not-run wording that would make it look
    // handled — via the same shared report as those handlers, so the two
    // paths cannot describe the same kind of failure two different ways.
    mainSettled = true;
    process.stdout.write(`${boundaryFailureReport(cause)}\n`);
    process.exitCode = 1;
  },
);
