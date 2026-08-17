// Loading the definition from wherever it lives.
//
// The loader knows nothing about HTTP or the filesystem. It takes a reader,
// so the same code path serves a URL in CI and a path on a laptop, and the
// tests exercise the real loader with no network at all. Which reader is
// wired is a composition decision (ADR 007).

import { LensSetError, parseLensSet, type LensSet } from './lensSet.js';

/**
 * What a reader found. Three answers, because collapsing them loses the one
 * that matters: a definition that is absent is a configuration mistake, and a
 * definition that is unreachable is an outage. They are fixed by different
 * people.
 */
export type ReadResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'unreachable'; readonly reason: string };

export type SourceReader = (source: string) => Promise<ReadResult>;

export type LoadResult =
  | { readonly kind: 'loaded'; readonly source: string; readonly set: LensSet }
  | {
      readonly kind: 'unavailable';
      readonly source: string;
      readonly why: 'missing' | 'unreachable' | 'malformed';
      readonly reason: string;
    };

/**
 * Load a lens set. Never throws for a bad definition or a bad source: an
 * unavailable definition is a result the caller must turn into `could_not_run`,
 * and a thrown exception invites a catch that turns it into something else.
 */
export async function loadLensSet(source: string, read: SourceReader): Promise<LoadResult> {
  let found: ReadResult;
  try {
    found = await read(source);
  } catch (cause) {
    // A reader that throws is itself unreachable — it reported nothing, which
    // is not the same as reporting absence.
    return {
      kind: 'unavailable',
      source,
      why: 'unreachable',
      reason: `reader threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  if (found.kind !== 'text') {
    return { kind: 'unavailable', source, why: found.kind, reason: found.reason };
  }

  try {
    return { kind: 'loaded', source, set: parseLensSet(found.text) };
  } catch (cause) {
    if (cause instanceof LensSetError) {
      return { kind: 'unavailable', source, why: 'malformed', reason: cause.message };
    }
    throw cause;
  }
}
