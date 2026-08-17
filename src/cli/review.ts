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
import { withReportFile } from './reportFile.js';
import { runReview } from './run.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    chunks.push(chunk as string);
  }
  return chunks.join('');
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
      review: anthropicReviewer(
        { apiKey: settings.apiKey, model: settings.model, maxTokens: settings.maxTokens },
        (url, init) => fetch(url, init),
      ),
    }),
    // Takes only the lens source and token — loadLensSet, and so this
    // reader, has no real dependency on the API key, and can be built and
    // used even when the key is missing or wrong. See the header comment on
    // `runReview`.
    //
    // `access` is passed straight through to `lensReaderFor` (readers.ts)
    // and nothing else: this file never itself writes an expression naming
    // a URL and a token together, because a branch deciding whether a
    // credential is safe to send belongs in a module a test can drive, not
    // in the process boundary this file is meant to stay free of. A review
    // found that the previous version — which built that expression here,
    // by hand, out of `lensFetchHeaders` — was untested at exactly this
    // seam: nothing proved the arguments arrived in the right order. Moving
    // the assembly into `lensReaderFor` does not add a test for that call
    // site; it removes this file's ability to make the mistake at all.
    (access) => lensReaderFor(access, fetch),
    // The real key-file source. Constructed here, at the process boundary,
    // for the same reason `readerFor` and `anthropicReviewer` are: `run.ts`
    // is tested with fakes and touches no real filesystem unless this is the
    // one place that hands it one.
    keyFileReader(),
  );

  // Unconditional, and first: CI reads this into the job summary, and
  // AIGENCY_REVIEW_REPORT below must never be able to move it — in the
  // success case or the failure case. See withReportFile.
  process.stdout.write(`${outcome.report}\n`);

  const written = await withReportFile(process.env['AIGENCY_REVIEW_REPORT'], outcome);
  if (written.failureMessage !== undefined) {
    process.stderr.write(`${written.failureMessage}\n`);
  }
  return written.exitCode;
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
