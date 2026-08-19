// The lens set: the dimensions a review looks along, and the rules a
// definition must satisfy before anything is allowed to review with it.
//
// This is the definition ADR 009 says exists once. The rules below are not
// tidiness — each one closes a way for a panel to shrink without anybody
// noticing, and a panel that shrinks silently is a green badge over a review
// that did not happen.

export interface Lens {
  readonly id: string;
  readonly title: string;
  readonly focus: string;
}

export interface LensSet {
  readonly version: number;
  readonly lenses: readonly Lens[];
}

/** Thrown for any definition that cannot be trusted to describe a panel. */
export class LensSetError extends Error {
  override readonly name = 'LensSetError';
}

// The only version this runner understands. A definition declaring a higher
// version is REFUSED rather than read on a best-effort basis: a newer document
// may add a field that changes what a lens means, and a runner that ignores
// the field would review confidently against a rule it never saw.
export const SUPPORTED_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(message: string): never {
  throw new LensSetError(message);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse and validate a lens set. Malformed input is refused, never read as
 * declaring no lenses — the two look identical downstream and only one of them
 * is safe.
 */
export function parseLensSet(text: string): LensSet {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    fail(`lens set is not valid JSON: ${(cause as Error).message}`);
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    fail('lens set must be a JSON object');
  }
  const record = document as Record<string, unknown>;

  if (record['version'] !== SUPPORTED_VERSION) {
    fail(
      `lens set declares version ${JSON.stringify(record['version'])}, ` +
        `this runner understands ${SUPPORTED_VERSION}`,
    );
  }

  const raw = record['lenses'];
  if (!Array.isArray(raw)) {
    fail('lens set must carry a `lenses` array');
  }

  // An empty panel approves everything it is shown, instantly and for free.
  // That is the whole failure this story exists to prevent, so it is refused
  // at the definition rather than caught at aggregation.
  if (raw.length === 0) {
    fail('lens set declares no lenses; a panel of none approves everything');
  }

  const seen = new Set<string>();
  const lenses = raw.map((entry, index): Lens => {
    const where = `lenses[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`${where} must be an object`);
    }
    const fields = entry as Record<string, unknown>;

    const id = requireString(fields['id'], `${where}.id`);
    if (!ID_PATTERN.test(id)) {
      fail(`${where}.id ${JSON.stringify(id)} must match ${String(ID_PATTERN)}`);
    }
    // Two lenses under one id collapse into one in any map keyed by id, which
    // is how every runner will hold them. The panel would then be a member
    // short and still report the count it was given.
    if (seen.has(id)) {
      fail(`${where}.id ${JSON.stringify(id)} is declared more than once`);
    }
    seen.add(id);

    return {
      id,
      title: requireString(fields['title'], `${where}.title`),
      focus: requireString(fields['focus'], `${where}.focus`),
    };
  });

  return { version: SUPPORTED_VERSION, lenses };
}
