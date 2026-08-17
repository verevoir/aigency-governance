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

import { readFile } from 'node:fs/promises';

import type { ReadResult, SourceReader } from './load.js';
import type { KeyFileReader, KeyFileResult } from './settings.js';

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
 * the CLI boundary (src/cli/review.ts) called `lensFetchHeaders(url,
 * access.lensToken)` itself, inside a closure it wrote out by hand — naming
 * `url` and `access.lensToken` together in the one file this codebase
 * deliberately keeps untestable (see that file's own header: everything
 * that decides anything lives elsewhere, and only the process boundary
 * lives there). A review caught what that made possible: nothing proved the
 * boundary passed the right values in the right order. `access.lensSource`
 * where `url` belonged, or the two arguments swapped, would type-check and
 * pass every test that existed, because every test drove `lensFetchHeaders`
 * directly and none drove the call site that mattered.
 *
 * The fix is not a test for that call site — it is removing the call
 * site's ability to make the mistake. The boundary now calls
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
