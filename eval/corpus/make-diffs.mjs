// Compute real diffs for corpus cases that declare a real ref pair.
//
// No verb on the belt reports a diff (H39-series harness findings, H44
// among them) — but scripts/_diag-precompute-diff.mjs already established
// the fix for that: a declared release step can shell out to git directly,
// same as CI does. This is that pattern, generalised: for every directory
// under eval/corpus/ that carries a refs.json naming a `base` and `head`
// branch, `git diff --merge-base origin/<base> origin/<head>` is run —
// scoped to `paths`, when the case names any — and the result is written to
// that case's own diff.txt.
//
// A case with no refs.json is left alone, silently. Not every corpus entry
// has a real ref pair to diff against; inventing one here would be exactly
// the fabrication the corpus's own subject.md discipline refuses to do, one
// layer further from where a human would notice.
//
// Declared unrestricted, same reasoning as _diag-precompute-diff.mjs: it
// needs PATH to spawn git, and an OAuth-scoped step's allow-list cannot
// declare PATH alongside a credential.
//
// GUARDED, THE SAME WAY eval/sweep.mjs ALREADY IS. All the work below now
// runs only when this file is the process entry point - checked by
// comparing import.meta.url to pathToFileURL(process.argv[1]).href, copied
// from eval/sweep.mjs's own guard rather than a second way of asking the
// same question. A bare `import('./make-diffs.mjs')`, from anywhere, now
// spawns no git process and writes no file. Confirmed against the actual
// invocation in aigency.json's `make-corpus-diffs` step (`node
// eval/corpus/make-diffs.mjs`): that is exactly the argv[1] shape this
// guard compares against, so the release step's behaviour is unchanged.

import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import console from 'node:console';
import process from 'node:process';

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.stderr.on('data', (c) => (err += String(c)));
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || `exit ${String(code)}`)),
    );
  });
}

async function main() {
  const CORPUS_DIR = 'eval/corpus';

  const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
  const caseDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const caseId of caseDirs) {
    const dir = path.join(CORPUS_DIR, caseId);
    const refsPath = path.join(dir, 'refs.json');

    let refsText;
    try {
      refsText = await readFile(refsPath, 'utf8');
    } catch {
      console.log(`[${caseId}] no refs.json — skipped`);
      skipped += 1;
      continue;
    }

    let refs;
    try {
      refs = JSON.parse(refsText);
    } catch (cause) {
      console.error(`[${caseId}] refs.json is not valid JSON: ${cause.message}`);
      failed += 1;
      continue;
    }

    if (
      typeof refs.base !== 'string' ||
      refs.base === '' ||
      typeof refs.head !== 'string' ||
      refs.head === ''
    ) {
      console.error(`[${caseId}] refs.json must declare non-empty string "base" and "head"`);
      failed += 1;
      continue;
    }

    const args = ['diff', '--merge-base', `origin/${refs.base}`, `origin/${refs.head}`];
    if (Array.isArray(refs.paths) && refs.paths.length > 0) {
      args.push('--', ...refs.paths);
    }

    let diff;
    try {
      diff = await capture('git', args);
    } catch (cause) {
      console.error(
        `[${caseId}] git diff origin/${refs.base}..origin/${refs.head} failed: ${cause.message}`,
      );
      failed += 1;
      continue;
    }

    if (diff.trim() === '') {
      console.error(
        `[${caseId}] diff between origin/${refs.base} and origin/${refs.head}` +
          `${refs.paths ? ` (paths: ${refs.paths.join(', ')})` : ''} is empty — refusing to write an empty diff.txt`,
      );
      failed += 1;
      continue;
    }

    await writeFile(path.join(dir, 'diff.txt'), diff, 'utf8');
    console.log(`[${caseId}] wrote diff.txt (${String(diff.length)} characters)`);
    written += 1;
  }

  console.log(
    `\n${String(written)} diff(s) written, ${String(skipped)} case(s) had no refs.json, ${String(failed)} failed.`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

// Same idiom as eval/sweep.mjs, copied rather than reinvented: only run
// main() when this file is the process entry point, not merely imported.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((cause) => {
    console.error(cause?.stack ?? String(cause));
    process.exitCode = 1;
  });
}
