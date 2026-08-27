#!/usr/bin/env node
// The process boundary for the LOCAL review path — the only thing here is
// what cannot live anywhere else: reading argv and stdin, constructing the
// one thing that actually spawns a subprocess, printing, and choosing an
// exit code. Everything that DECIDES anything lives in `runLocal.ts` and
// `review/claudeCli.ts`, where a test drives it with fakes and no real
// subprocess — mirrors `review.ts`'s own header, for the same reason.
//
// Deliberately a second boundary file rather than a branch inside
// `review.ts`. That file's `main` constructs an `anthropicReviewer` and
// resolves settings that REQUIRE `ANTHROPIC_API_KEY` — correctly, for the
// substrate it drives. This composition needs no key at all and must never
// fall back to one if `claude` is unavailable; a branch here choosing
// between the two substrates would put a which-transport-am-I-configuring
// decision inside the one file this codebase deliberately keeps free of
// decisions.

import { spawn } from 'node:child_process';
import { stdin } from 'node:process';
import process from 'node:process';

import { runLocalReview } from './runLocal.js';
import { allowedEnv, type CliInvocation, type CliRunner } from '../review/claudeCli.js';
import { lensReaderFor } from '../review/readers.js';
import { DEFAULT_LENS_SOURCE } from '../review/settings.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    chunks.push(chunk as string);
  }
  return chunks.join('');
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * The real transport: spawns the actual `claude` CLI with its environment
 * built by `allowedEnv` — an allowlist, never the operator's full
 * environment with a few names removed. The only function in this entire
 * composition that touches `node:child_process` — same separation
 * `review.ts` keeps for `fetch`.
 */
function realClaudeCliRunner(command = 'claude'): CliRunner {
  return (args, input) =>
    new Promise<CliInvocation>((resolve, reject) => {
      const child = spawn(command, [...args], { env: allowedEnv(process.env) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // e.g. ENOENT — claude is not on PATH at all. A spawn-level failure,
      // distinct from a non-zero exit; claudeCliReviewer treats both as a
      // refusal, never a reason to try anything else.
      child.on('error', reject);
      // `signal` is captured, not discarded: Node sets `exitCode` to `null`
      // PRECISELY WHEN the child was terminated by a signal, so dropping
      // this argument is how a SIGKILL-terminated run and a genuine null
      // exit end up reported as the identical, uninformative "exited with
      // code null" — see `describeExit` in `review/claudeCli.ts`.
      child.on('close', (exitCode, signal) => {
        resolve({ stdout, stderr, exitCode, signal });
      });
      child.stdin.write(input);
      child.stdin.end();
    });
}

async function main(): Promise<number> {
  const title = process.argv[2] ?? 'this change';
  const diff = await readAll(stdin);

  const lensSource = present(process.env['AIGENCY_REVIEW_LENSES']) ?? DEFAULT_LENS_SOURCE;
  const lensToken =
    present(process.env['AIGENCY_REVIEW_LENSES_TOKEN']) ?? present(process.env['GITHUB_TOKEN']);

  const read = lensReaderFor(
    { lensSource, ...(lensToken === undefined ? {} : { lensToken }) },
    (url, init) => fetch(url, init),
  );

  const outcome = await runLocalReview(
    process.env,
    { title, description: '', diff },
    { read, run: realClaudeCliRunner() },
  );

  process.stdout.write(`${outcome.report}\n`);
  return outcome.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    // Last resort. Anything reaching here is a defect in the boundary
    // itself, since `runLocalReview` returns rather than throws.
    process.stdout.write(
      `## Review: Could not run\n\nUnexpected failure at the process boundary: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n\nThis is a defect in the runner, not a verdict about the change.\n`,
    );
    process.exitCode = 1;
  },
);
