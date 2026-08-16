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
