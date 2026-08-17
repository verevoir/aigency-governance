// Provision: read-only access to the bar a change is judged against.
//
// S15 asks for three outcomes, and it is tempting to build two: "here are
// practices" and "here is nothing, or something is wrong". That collapse is
// exactly the failure this file exists to avoid. `nothing-matched` and
// `unavailable` are different jobs for different people — one says the query
// found nothing IN a corpus that was read successfully, the other says the
// corpus itself could not be read at all — and only keeping them apart lets
// a caller tell "my query was wrong" from "the corpus is unreachable" from
// "the corpus doesn't exist".
//
// The SourceReader port is the same one `loadLensSet` takes, imported rather
// than redeclared. Two reader ports in one repository is how they drift —
// one gains a retry, the other doesn't, and nobody notices until the day
// they disagree about what "missing" means.
//
// `nothing-matched` carries its own search — the query, the source, and how
// many practices were considered (B4). "No practices matched" and "no
// practices matched across the 47 in the corpus at this URL" are different
// answers, and only the second lets a caller tell an empty corpus from a
// query that was simply wrong.
//
// An empty corpus is refused as malformed, at parse time, rather than
// answered as `nothing-matched`. A corpus of none matches nothing — for
// every query, always — which is indistinguishable downstream from a query
// that legitimately found nothing in a real corpus. Collapsing them is the
// exact failure `nothing-matched` carrying its own search exists to prevent,
// so the two states are kept apart at the source instead.
//
// Cheapness is the acceptance criterion, not a courtesy: `provision` must be
// callable at the start of every implementing turn. Stated in a comment,
// that is a wish. The tests call it against a counting fake and assert the
// reader was invoked exactly once, and that a write capability sitting next
// to the read one — offered to the fake but never reachable through
// `provision`'s own signature — is never touched. The signature is what
// makes the second assertion true before any test runs: `provision` takes a
// bound `read` function and nothing else, so there is no reference through
// which a write could happen even if one wanted to.
//
// THE BOUND. `provision` returns practices that go straight into a prompt,
// and the story's own row says the floor has already broken a context cap
// once — bounded like every model-facing payload. So the bound is a
// REQUIRED parameter, not optional and not defaulted. A default here is
// precisely how a cap gets forgotten a second time: a caller that must name
// a number has to think about what it can afford to send, and a caller that
// inherits one never does. This function was shipped once without a bound at
// all, built from a paraphrase of the row rather than the row itself — the
// habit of quoting stories verbatim was in place and was only ever applied
// to stories not yet started. This is the fix.
//
// The bound measures what actually reaches the model — `title` and `body`
// concatenated, via `practiceSize` below — not the count of matches. Cutting
// the fifth of five practices because of a COUNT is arbitrary; cutting it
// because the PAYLOAD is full is a measurement, and only the second is
// testable as a property of the output rather than a guess about its shape.
//
// Matches are included in order until the next one would push the running
// total over the bound, then that one and everything after it is dropped —
// a prefix, not a best-fit pack, so which practices survive is predictable
// from the order the corpus declares them in rather than from a bin-packing
// choice nobody asked for.
//
// A single practice that is, by itself, larger than the whole bound is NOT
// truncated to fit. It is dropped, and counted in the marker exactly like any
// other omission. Truncating a governance rule quotes half of it as though it
// were the whole rule, and a reader of a half-quoted rule has no way to tell
// that it is half — that is a wrong answer wearing the shape of a right one,
// which is worse than an honest, visible omission. Dropping it is the
// deliberate choice; the alternative was considered and rejected here rather
// than left to fall out of the loop.
//
// Whenever anything is dropped, the `practices` outcome carries `elided`,
// naming how many practices were omitted and the corpus source — the same
// principle S7 states for every lens: an elision that does not announce
// itself turns a partial answer into a wrong one, and the reader cannot tell
// which they have.

import type { ReadResult, SourceReader } from '../review/load.js';

export interface Practice {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface Corpus {
  readonly version: number;
  readonly practices: readonly Practice[];
}

/** Thrown for a corpus that cannot be trusted to describe a bar. */
export class CorpusError extends Error {
  override readonly name = 'CorpusError';
}

// The only version this reads. As with the lens set, a higher version is
// refused rather than read optimistically — a newer document may add a field
// that changes what a practice means, and reading it anyway would provision
// against a rule nobody wrote down.
export const SUPPORTED_CORPUS_VERSION = 1;

function fail(message: string): never {
  throw new CorpusError(message);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse and validate a corpus. Malformed input is refused, never read as an
 * empty corpus — the two look identical downstream and only one of them is
 * safe to answer `nothing-matched` about.
 */
export function parseCorpus(text: string): Corpus {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    // `JSON.parse` is spec-guaranteed to throw a `SyntaxError` — an `Error`
    // — on malformed input, never a string or a plain object, so the
    // `instanceof Error` branch below is defensive rather than reachable
    // today: nothing in this codebase can drive this catch with a non-Error
    // cause. It would become reachable only if `JSON.parse` here were ever
    // replaced by something else (a custom parser, a shimmed global) — at
    // which point this stops being defensive and nobody will know from the
    // test suite, because there is deliberately no test for it now.
    fail(`corpus is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    fail('corpus must be a JSON object');
  }
  const record = document as Record<string, unknown>;

  if (record['version'] !== SUPPORTED_CORPUS_VERSION) {
    fail(
      `corpus declares version ${JSON.stringify(record['version'])}, ` +
        `this reader understands ${SUPPORTED_CORPUS_VERSION}`,
    );
  }

  const raw = record['practices'];
  if (!Array.isArray(raw)) {
    fail('corpus must carry a `practices` array');
  }

  // A corpus of none matches nothing, for every query, always — which is
  // indistinguishable from a query that genuinely matched nothing in a real
  // corpus. Refused here rather than left to be discovered as a
  // suspiciously permanent `nothing-matched`.
  if (raw.length === 0) {
    fail(
      'corpus declares no practices; an empty corpus matches nothing, which is ' +
        'indistinguishable from a query that matched nothing',
    );
  }

  const seen = new Set<string>();
  const practices = raw.map((entry, index): Practice => {
    const where = `practices[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`${where} must be an object`);
    }
    const fields = entry as Record<string, unknown>;

    const id = requireString(fields['id'], `${where}.id`);
    // Two practices under one id collapse into one in any map keyed by id,
    // the same reasoning the lens set uses for its own ids.
    if (seen.has(id)) {
      fail(`${where}.id ${JSON.stringify(id)} is declared more than once`);
    }
    seen.add(id);

    return {
      id,
      title: requireString(fields['title'], `${where}.title`),
      body: requireString(fields['body'], `${where}.body`),
    };
  });

  return { version: SUPPORTED_CORPUS_VERSION, practices };
}

/** Names an elision: how many practices were omitted, and from where. */
export interface Elided {
  readonly omittedCount: number;
  readonly source: string;
}

export type ProvisionResult =
  | {
      readonly kind: 'practices';
      readonly practices: readonly Practice[];
      /** Present only when the bound cut something. Absence means nothing was dropped. */
      readonly elided?: Elided;
    }
  | {
      readonly kind: 'nothing-matched';
      readonly query: string;
      readonly source: string;
      readonly consideredCount: number;
    }
  | {
      readonly kind: 'unavailable';
      readonly source: string;
      readonly why: 'missing' | 'unreachable' | 'malformed';
      readonly reason: string;
    };

function matches(practice: Practice, needle: string): boolean {
  return (
    practice.id.toLowerCase().includes(needle) ||
    practice.title.toLowerCase().includes(needle) ||
    practice.body.toLowerCase().includes(needle)
  );
}

/**
 * What actually reaches the model: title and body concatenated. The id is
 * structural — a lookup key, not prose a reviewer reads — and does not count
 * against the bound.
 */
export function practiceSize(practice: Practice): number {
  return practice.title.length + practice.body.length;
}

/**
 * Cut `matched` to fit `maxChars`, measured by `practiceSize`, not by count.
 *
 * A prefix, not a best-fit pack: practices are included in the order they
 * matched until the next one would push the running total over the bound,
 * then that one and everything after it stops being considered. A practice
 * larger than the whole bound on its own is dropped rather than truncated —
 * see the file header for why — and counted in `elided` exactly like any
 * other omission.
 */
function boundToFit(
  matched: readonly Practice[],
  maxChars: number,
  source: string,
): ProvisionResult {
  const included: Practice[] = [];
  let used = 0;

  for (const practice of matched) {
    const size = practiceSize(practice);
    if (used + size > maxChars) {
      break;
    }
    included.push(practice);
    used += size;
  }

  const omittedCount = matched.length - included.length;
  if (omittedCount === 0) {
    return { kind: 'practices', practices: included };
  }
  return {
    kind: 'practices',
    practices: included,
    elided: { omittedCount, source },
  };
}

/**
 * Provision practices from a corpus, bounded to `maxChars`.
 *
 * `maxChars` is required. See the file header for why it is not optional and
 * not defaulted — the floor this replaces broke a context cap once by
 * inheriting a bound nobody had to think about.
 *
 * Never throws for a bad definition or a bad source: an unavailable corpus
 * is a result the caller must turn into `unavailable`, the same discipline
 * `loadLensSet` uses and for the same reason — a thrown exception invites a
 * catch that turns it into something else.
 */
export async function provision(
  query: string,
  source: string,
  read: SourceReader,
  maxChars: number,
): Promise<ProvisionResult> {
  let found: ReadResult;
  try {
    found = await read(source);
  } catch (cause) {
    // A reader that throws reported nothing at all, which is not the same as
    // reporting absence.
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

  let corpus: Corpus;
  try {
    corpus = parseCorpus(found.text);
  } catch (cause) {
    if (cause instanceof CorpusError) {
      return { kind: 'unavailable', source, why: 'malformed', reason: cause.message };
    }
    throw cause;
  }

  const needle = query.trim().toLowerCase();
  const matched = corpus.practices.filter((practice) => matches(practice, needle));

  if (matched.length === 0) {
    return {
      kind: 'nothing-matched',
      query,
      source,
      consideredCount: corpus.practices.length,
    };
  }

  return boundToFit(matched, maxChars, source);
}
