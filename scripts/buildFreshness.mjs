// Whether dist/ is safe to judge as a stand-in for src/.
//
// check-cli.mjs exists to run the emitted artifact rather than the source —
// see its own header — and can only prove something about the build it
// actually spawns. run_gates runs the declared gates and nothing that
// produces them: aigency.json's `commands` is a flat array with no way to
// say "this gate requires that bootstrap to have run first". So nothing
// stops a gate from spawning a dist/ built before the last edit under src/,
// and reporting whatever it finds as if it were about the code under review
// right now. This module is the guard against that, not a fix for it — see
// the comment where check-cli.mjs uses it.
//
// Pure and filesystem-only, deliberately separate from check-cli.mjs itself,
// so a test can drive it against a real temporary tree without spawning
// anything or touching this repository's own src/ or dist/.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function collectFiles(root, files) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') {
      return;
    }
    throw cause;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

/**
 * The newest mtime, in milliseconds, of any file under `root`. `undefined`
 * when `root` does not exist or holds no files — both read the same way to a
 * caller comparing two trees: there is nothing there to be newer than
 * anything.
 */
export async function newestMtimeMs(root) {
  const files = [];
  await collectFiles(root, files);
  if (files.length === 0) {
    return undefined;
  }
  const stats = await Promise.all(files.map((file) => stat(file)));
  return Math.max(...stats.map((entry) => entry.mtimeMs));
}

/**
 * Whether `distRoot` is safe to spawn as a stand-in for `srcRoot`.
 *
 * `distRoot` absent, or holding no files, is stale — there is nothing built
 * at all. `distRoot` with a newest file strictly older than `srcRoot`'s
 * newest file is stale — something under `srcRoot` changed since the last
 * build. Equal or newer is current: a build that ran after every source
 * edit is a build of what is there now, however long ago it ran.
 */
export async function buildFreshness(srcRoot, distRoot) {
  const [srcNewest, distNewest] = await Promise.all([
    newestMtimeMs(srcRoot),
    newestMtimeMs(distRoot),
  ]);
  if (distNewest === undefined) {
    return { stale: true, reason: `${distRoot} does not exist, or holds no files` };
  }
  if (srcNewest !== undefined && srcNewest > distNewest) {
    return {
      stale: true,
      reason: `${srcRoot} was modified more recently than anything under ${distRoot}`,
    };
  }
  return { stale: false };
}
