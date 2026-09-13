// Getting the definition's bytes from somewhere.
//
// Two readers, one interface, and the interesting part of both is the error
// mapping rather than the happy path. `missing` and `unreachable` are fixed by
// different people — a 404 is a wrong URL in someone's configuration, a
// refused connection is an outage — and a reader that collapses them hands the
// wrong person the pager.
//
// Neither reader throws. `loadLensSet` will catch a throw and call it
// unreachable, which is correct but lossy, so each reader classifies what it
// knows before that fallback is needed.

import { execFile as execFileCallback } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join as joinPath, sep as pathSep } from 'node:path';
import { promisify } from 'node:util';

import type { CitationFileReader } from './citations.js';
import type { ReadResult, SourceReader } from './load.js';
import type { KeyFileReader, KeyFileResult } from './settings.js';

const execFileAsync = promisify(execFileCallback);

/** Anything that behaves like `fetch` for our purposes. */
export type FetchLike = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

/**
 * Reads over HTTP. A 404 is `missing`; any other non-2xx is `unreachable`
 * carrying its status, because a 500 or a 403 says the thing may well exist
 * and we were not allowed or not able to see it — which is not absence.
 */
export function httpReader(fetchImpl: FetchLike): SourceReader {
  return async (source: string): Promise<ReadResult> => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(source);
    } catch (cause) {
      return { kind: 'unreachable', reason: `fetch failed: ${(cause as Error).message}` };
    }

    if (response.status === 404) {
      return { kind: 'missing', reason: `HTTP 404 for ${source}` };
    }
    if (!response.ok) {
      return { kind: 'unreachable', reason: `HTTP ${String(response.status)} for ${source}` };
    }

    try {
      return { kind: 'text', text: await response.text() };
    } catch (cause) {
      // The response arrived and the body did not. Not absence.
      return { kind: 'unreachable', reason: `body unreadable: ${(cause as Error).message}` };
    }
  };
}

/**
 * Reads from disk. `ENOENT` and `ENOTDIR` are `missing`; everything else —
 * `EACCES`, `EISDIR`, an I/O error — is `unreachable`, because a file we are
 * not allowed to open is a permissions problem and not a missing definition,
 * and telling someone their path is wrong when it is right wastes the hour
 * they spend checking it.
 */
export function fileReader(): SourceReader {
  return async (source: string): Promise<ReadResult> => {
    try {
      return { kind: 'text', text: await readFile(source, 'utf8') };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { kind: 'missing', reason: `${code}: ${source}` };
      }
      return {
        kind: 'unreachable',
        reason: `${code ?? 'unknown'}: ${(cause as Error).message}`,
      };
    }
  };
}

/**
 * Picks a reader by the shape of the source. Deliberately narrow: `http:` and
 * `https:` go over the network, everything else is a path. There is no third
 * case and no guessing — a source that looks like neither is a path that will
 * not resolve, and `missing` with the path in it is a better answer than a
 * clever one.
 */
export function readerFor(source: string, fetchImpl: FetchLike): SourceReader {
  return source.startsWith('http://') || source.startsWith('https://')
    ? httpReader(fetchImpl)
    : fileReader();
}

/**
 * The only host the lens-set bearer token is ever sent to. It is the host
 * `DEFAULT_LENS_SOURCE` (settings.ts) points at, and the README documents the
 * property this constant enforces: "Any other `https://` source is fetched
 * anonymously and no token is sent."
 */
export const LENS_TOKEN_HOST = 'raw.githubusercontent.com';

/**
 * Headers for one lens-set fetch.
 *
 * `AIGENCY_REVIEW_LENSES` is caller-controlled — a repository sets it to
 * point at wherever it keeps its lens set. The bearer token is read access to
 * a private repository, and attaching it unconditionally to whatever host
 * that variable resolves to would hand it to any third party a caller (or an
 * attacker with write access to that variable) pointed the source at. So the
 * token — and the GitHub-specific `accept` header that only means anything to
 * that one host — is attached only when `url`'s host is exactly
 * `LENS_TOKEN_HOST`. Every other host, including a URL that fails to parse at
 * all, is fetched with no headers whatsoever: not a redacted token, not a
 * different one, nothing that identifies the caller.
 */
export function lensFetchHeaders(url: string, token: string | undefined): Record<string, string> {
  if (token === undefined) {
    return {};
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  if (host !== LENS_TOKEN_HOST) {
    return {};
  }
  return { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw' };
}

/**
 * What building the lens-set reader needs — nothing else. Lives here, next
 * to the reader that consumes it, rather than at the process boundary that
 * merely holds one: see `lensReaderFor` below for why.
 */
export interface LensAccess {
  readonly lensSource: string;
  /** Absent, not present-and-undefined, when the source needs no token. */
  readonly lensToken?: string;
}

/**
 * The two-argument shape of the global `fetch` — what `lensReaderFor` needs
 * in order to attach headers per request, since `FetchLike` above takes only
 * a URL.
 */
export type RawFetch = (
  url: string,
  init: { readonly headers: Record<string, string> },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

/**
 * Builds the reader used to fetch a lens set, with the bearer-token
 * restriction wired in as part of construction.
 *
 * This exists because an earlier version left the assembly to the caller:
 * the CLI boundary (src/cli/review.ts) would call `lensFetchHeaders(url,
 * access.lensToken)` itself, inside a closure it wrote out by hand — naming
 * `url` and `access.lensToken` together in the one file this codebase
 * deliberately keeps untestable (see that file's own header: everything
 * that decides anything lives elsewhere, and only the process boundary
 * lives there). A caller writing that closure by hand has nothing proving
 * it passed the right values in the right order: `access.lensSource` where
 * `url` belonged, or the two arguments swapped, would type-check and pass
 * every test that only drives `lensFetchHeaders` directly.
 *
 * The fix is not a test for that call site — it is removing the call
 * site's ability to make the mistake. The boundary calls
 * `lensReaderFor(access, fetch)`: it passes `access` through whole and
 * never writes an expression naming a URL and a token together itself. The
 * wiring this function does — calling `lensFetchHeaders` with the URL
 * actually being fetched — is proven here, end to end, by driving
 * `lensReaderFor` itself with a fake `rawFetch` and reading what arrived,
 * rather than only exercising `lensFetchHeaders` in isolation.
 */
export function lensReaderFor(access: LensAccess, rawFetch: RawFetch): SourceReader {
  return readerFor(access.lensSource, (url) =>
    rawFetch(url, { headers: lensFetchHeaders(url, access.lensToken) }),
  );
}

/**
 * Reads a candidate API key file from disk. `ENOENT` and `ENOTDIR` are
 * `absent` — a file nobody wrote is the ordinary shape of a source with
 * nothing to offer, and `resolveSettings` moves on to the next one.
 * Everything else — `EACCES`, `EISDIR`, any other I/O error — is
 * `unreadable`, because a file that IS there and could not be opened is a
 * problem someone already tried to solve, and calling it absent sends them
 * looking for a file that exists.
 *
 * A failed read has no content to have leaked: the reason names the failure
 * code and the message Node produced opening the path, never bytes read from
 * it, because there are none to name.
 */
export function keyFileReader(): KeyFileReader {
  return async (path: string): Promise<KeyFileResult> => {
    try {
      return { kind: 'text', text: await readFile(path, 'utf8') };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { kind: 'absent' };
      }
      return {
        kind: 'unreadable',
        reason: `${code ?? 'unknown'}: ${(cause as Error).message}`,
      };
    }
  };
}

/**
 * The two/three-argument shape of `child_process.execFile`, promisified —
 * what `listTrackedFiles` needs, injected the same way `FetchLike` and
 * `KeyFileReader` are elsewhere in this file, so the git-dependent path is
 * unit-testable without a real git process.
 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly maxBuffer: number },
) => Promise<{ readonly stdout: string }>;

/**
 * Thrown by `listTrackedFiles` when git itself cannot answer whether files
 * are tracked. NEVER caught here and turned into an empty set — see that
 * function's own header for why an empty set would be a confident, false
 * claim rather than an honest "unknown". Propagates through
 * `citationFileReader` and `buildCitedContext` (neither wraps the reader
 * call in a try/catch) to `cli/review.ts`'s top-level handler, which
 * reports it as a whole-review `could not run`, before any lens is asked
 * to review anything.
 */
export class TrackedFilesUnavailableError extends Error {
  override readonly name = 'TrackedFilesUnavailableError';
}

/**
 * The set of paths git considers tracked in `repoRoot`, exactly as `git
 * ls-files` reports them — forward-slash-separated, relative to `repoRoot`,
 * the same shape a citation's `path` already has. Computed once per run
 * (see cli/review.ts) and passed to `citationFileReader`: this is layer 2
 * of the path-safety defence citations.ts's own file header describes —
 * a citation naming a path outside this set is refused regardless of
 * whether the path exists on disk, because a file the repository's own
 * history does not track is not part of the change under review and has
 * no business being quoted to a model. This is specifically what stops a
 * gitignored `.env` that happens to carry a permitted-looking name: layer
 * 1 (citations.ts's extension allowlist) cannot see the filesystem at all,
 * so this layer is load-bearing on its own, not merely defence in depth.
 *
 * FAILS LOUD, NOT CLOSED — CORRECTED FROM AN EARLIER VERSION OF THIS
 * FUNCTION. That earlier version caught any failure here — no git on
 * `PATH`, not a git repository, a transient exec error — and returned an
 * EMPTY set, reasoning that every citation would then be refused as
 * untracked, which "sounded" safe. A review of this PR found that reasoning
 * wrong: an empty set does not read as "unknown", it reads as a specific,
 * confident, FALSE claim — "this document cited N files and NONE of them
 * are tracked" — when the truth is "nothing could be checked at all".
 * `citationFileReader` cannot tell the two apart once it only has the set,
 * so a reader of the rendered report cannot either: it looks exactly like
 * every citation pointing at a genuinely untracked file. That is the same
 * conflation the whole path-safety mechanism exists to prevent, one level
 * up. So this now THROWS `TrackedFilesUnavailableError`, naming the
 * failure, and does not catch it — a citation mechanism that cannot prove
 * a path is tracked must say so, not guess "probably not" on every citation
 * at once.
 */
export async function listTrackedFiles(
  repoRoot: string,
  execFileImpl: ExecFileLike = execFileAsync,
): Promise<ReadonlySet<string>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileImpl('git', ['ls-files'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (cause) {
    throw new TrackedFilesUnavailableError(
      `could not determine which files git tracks in ${repoRoot}, so no citation in this ` +
        `diff could be safely checked against layer 2 of the path-safety defence (see this ` +
        `file's own header): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return new Set(stdout.split('\n').filter((line) => line.trim() !== ''));
}

/**
 * Reads a file cited by a diff — the real, filesystem-and-git-touching
 * implementation. `path` has already passed citations.ts's `pathSafety`
 * (layer 1: no absolute path, no traversal, an allowed extension) before
 * this is ever called; what remains is what only the filesystem and git
 * can answer, in order:
 *
 *   1. TRACKED (layer 2). `path` must be a member of `trackedFiles` — see
 *      `listTrackedFiles`. An untracked file, including one that is
 *      gitignored for exactly this reason, is refused here even if it has
 *      a permitted-looking extension.
 *   2. NO SYMLINK ESCAPE (layer 3). `path` is resolved, relative to
 *      `repoRoot`, to its real symlink-free target (`fs.realpath`), and
 *      that target must sit inside `repoRoot`'s own real path. A tracked
 *      symlink pointing outside the checkout is refused even though the
 *      symlink file itself passed layer 1.
 *   3. READ. Only once both checks pass is the real target actually read.
 *
 * Every refusal here carries a reason beginning "refused —", the same
 * convention citations.ts's own `pathSafety` uses, so a reader of the
 * rendered context can always tell "this citation named something we
 * would not fetch" from "this citation named something that is not
 * there" (`missing`).
 */
export function citationFileReader(
  repoRoot: string,
  trackedFiles: ReadonlySet<string>,
): CitationFileReader {
  // Resolved once, lazily, and SHARED across every citation this reader
  // instance handles — not for speed, but for honesty. An earlier version
  // resolved this fresh per citation and, on failure, returned a
  // per-citation `missing` result: indistinguishable from one specific
  // cited file individually happening to be absent, when the real fact is
  // that the repository root itself could not be resolved and NOTHING
  // could be checked for ANY citation — the same cannot-look-vs-
  // found-nothing conflation `TrackedFilesUnavailableError` above exists to
  // prevent, one level down. So a failure here PROPAGATES (throws) rather
  // than degrading into a misleading per-file `missing`, exactly like
  // `listTrackedFiles`.
  let realRootPromise: Promise<string> | undefined;
  const resolveRealRoot = (): Promise<string> => {
    realRootPromise ??= realpath(repoRoot).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      throw new Error(
        `could not resolve the repository root (${repoRoot}) for citation path-safety ` +
          `checking, so no citation could be safely resolved: ${code ?? 'unknown'}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
    return realRootPromise;
  };

  return async (path: string) => {
    if (!trackedFiles.has(path)) {
      return {
        kind: 'refused',
        reason:
          'refused — this path is not tracked in the repository’s git index; only committed, ' +
          'tracked files may be quoted into a review (this is also what refuses a gitignored ' +
          'file such as .env that happens to have a permitted-looking name)',
      };
    }

    // Resolved FIRST, before the file-specific realpath below — the root
    // does not depend on which file is being checked, and ordering it
    // after would mean a citation naming an absent tracked file returns
    // early with a per-citation `missing` before this is ever attempted,
    // so a broken root would only ever surface on a citation whose own
    // file happened to exist. Throws (propagates) on failure — see
    // resolveRealRoot's own comment above for why this must never degrade
    // into a per-citation `missing`.
    const realRoot = await resolveRealRoot();

    let real: string;
    try {
      real = await realpath(joinPath(repoRoot, path));
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      return { kind: 'missing', reason: `${code ?? 'unknown'}: ${(cause as Error).message}` };
    }

    if (real !== realRoot && !real.startsWith(realRoot + pathSep)) {
      return {
        kind: 'refused',
        reason:
          'refused — this path resolves outside the repository checkout, most likely via a ' +
          'symlink; a citation cannot be used to read anything the checkout does not itself contain',
      };
    }

    try {
      return { kind: 'text', text: await readFile(real, 'utf8') };
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      return { kind: 'missing', reason: `${code ?? 'unknown'}: ${(cause as Error).message}` };
    }
  };
}
