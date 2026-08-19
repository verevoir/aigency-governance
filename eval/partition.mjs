// eval/partition.mjs
//
// Turns a practice corpus into a review LensSet by splitting the corpus
// across `width` lenses — the mechanism that makes fan width a sweepable
// parameter instead of a number typed in once and never re-derived. See
// design/tuned-constants-and-eval-harness.md: "a fan width of roughly 40
// lenses, discussed this session but not yet written anywhere as a number
// with a source" is exactly the gap this module exists to close — a width
// becomes an argument to a function, not a memory.
//
// The Practice shape matches the real corpus reader, verbatim:
// src/practices/provision.ts's `Practice` is `{ id, title, body }` — NOT
// `text`. This module was first written against a guessed field name and
// corrected once the real schema was read; the tests round-trip fixtures
// through `parseCorpus` itself (not a local reimplementation of its rules)
// so this module can never be fed, or itself emit test data shaped like, a
// corpus the production parser would reject.
//
// THE OUTPUT IS CHECKED AGAINST THE REAL CONTRACT, NOT THIS MODULE'S OWN
// IDEA OF ONE: `parseLensSet` (src/review/lensSet.ts) is what actually loads
// a lens set at review time, and this module's tests round-trip every
// generated set through it. An id pattern maintained here and there would
// drift the same way the reply contract's markers would have drifted had
// they stayed in two files (see replyContract.ts's own header for that
// argument, made once and inherited here rather than re-argued).
//
// WHERE THE SLICE GOES, AND WHY IT MUST GO THERE — NOT OBVIOUS, SO STATED
// EXPLICITLY. `src/review/prompt.ts`'s `buildPrompt` splices its `practices`
// argument into `Prompt.shared`, which is byte-identical for every lens in
// one panel run, deliberately, so the prefix is cacheable (see prompt.ts's
// own header). If this module's per-lens practice slice were passed as that
// `practices` argument, every lens would receive the SAME slice — the whole
// corpus, or whichever lens's slice happened to be threaded through last —
// and the partition would have no effect on what any lens actually sees,
// while still appearing to run a width sweep. So the slice is built into
// each generated lens's own `focus` field below, which is the only half of
// the prompt (`Prompt.perLens`) that legitimately varies by lens. A caller
// wiring this module's output into `runPanel` must pass the resulting
// `LensSet` as `set` and must NOT also pass the same practices as the
// `practices` argument to `runPanel`/`buildPrompt` — doing so would put the
// whole corpus in `shared` a second time, on top of the slice already in
// `focus`, defeating the reason the corpus was split in the first place.

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * @typedef {{ id: string, title: string, body: string }} Practice
 * @typedef {{ id: string, title: string, focus: string }} Lens
 * @typedef {{ version: 1, lenses: Lens[] }} LensSet
 */

/**
 * Split `practices` across `width` lenses and return a LensSet.
 *
 * @param {readonly Practice[]} practices
 * @param {number} width
 * @param {{ strategy?: 'contiguous' | 'round-robin' }} [opts]
 * @returns {LensSet}
 */
export function partition(practices, width, opts = {}) {
  if (!Array.isArray(practices)) {
    throw new TypeError('practices must be an array');
  }
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError(`width must be an integer >= 1, got ${JSON.stringify(width)}`);
  }

  // An empty lens approves everything it sees — lensSet.ts already refuses
  // an empty SET for that reason. This is the same failure one slice down,
  // and it is exactly how a width sweep would produce a flattering result at
  // high widths if it were allowed to run: nothing to review is nothing to
  // reject.
  if (width > practices.length) {
    throw new RangeError(
      `width (${width}) exceeds the number of practices (${practices.length}); that would ` +
        'produce at least one empty lens, and an empty lens approves everything it sees',
    );
  }

  const strategy = opts.strategy ?? 'contiguous';
  if (strategy !== 'contiguous' && strategy !== 'round-robin') {
    throw new RangeError(`unknown strategy ${JSON.stringify(strategy)}`);
  }

  // Deterministic: the same inputs must always produce a byte-identical lens
  // set, or a re-derivation cannot be compared with the derivation it
  // replaces. Sorting by id, before either strategy runs, is what makes
  // input order irrelevant.
  const sorted = [...practices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const groups =
    strategy === 'contiguous'
      ? partitionContiguous(sorted, width)
      : partitionRoundRobin(sorted, width);

  assertDisjointAndExhaustive(sorted, groups);

  // At least two digits, growing if width itself needs more, so `lens-09`
  // sorts before `lens-10` as a STRING the same way it does as a number —
  // stable ordering is the point, not just uniqueness.
  const padWidth = Math.max(2, String(width).length);

  const lenses = groups.map((group, index) => {
    const n = index + 1;
    const id = `lens-${String(n).padStart(padWidth, '0')}`;
    if (!ID_PATTERN.test(id)) {
      // Unreachable given the fixed prefix and digit padding above — kept as
      // a hard stop rather than a silently invalid id parseLensSet would
      // refuse two calls downstream, further from where it was produced.
      throw new Error(
        `generated lens id ${JSON.stringify(id)} does not match ${String(ID_PATTERN)}`,
      );
    }
    return {
      id,
      title: `Lens ${n} of ${width} (${group.length} practice${group.length === 1 ? '' : 's'})`,
      // The slice goes here, in `focus` — the per-lens half of the prompt —
      // and nowhere else. See the file header: passing this same content as
      // `runPanel`'s `practices` argument instead (or as well) puts it in
      // the SHARED half, identical across lenses, and silently defeats the
      // whole partition.
      focus: focusFor(group),
    };
  });

  return { version: 1, lenses };
}

function partitionContiguous(sorted, width) {
  const base = Math.floor(sorted.length / width);
  const remainder = sorted.length % width;
  const groups = [];
  let offset = 0;
  for (let i = 0; i < width; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    groups.push(sorted.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

function partitionRoundRobin(sorted, width) {
  const groups = Array.from({ length: width }, () => []);
  sorted.forEach((practice, index) => {
    groups[index % width].push(practice);
  });
  return groups;
}

/**
 * Every practice must land in exactly one lens. Checked by object identity
 * against the sorted input, not by id — two practices sharing an id would
 * still each need to be accounted for once. Thrown, not logged: a
 * partitioner that silently drops or duplicates a practice is worse than one
 * that refuses to run.
 */
function assertDisjointAndExhaustive(sorted, groups) {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  if (total !== sorted.length) {
    throw new Error(`partition dropped or duplicated practices: ${sorted.length} in, ${total} out`);
  }
  const seen = new Set();
  for (const group of groups) {
    for (const practice of group) {
      if (seen.has(practice)) {
        throw new Error(`practice ${JSON.stringify(practice.id)} appears in more than one lens`);
      }
      seen.add(practice);
    }
  }
  if (seen.size !== sorted.length) {
    throw new Error('partition did not cover every practice exactly once');
  }
}

function focusFor(practices) {
  return practices.map((practice) => `- ${practice.title}: ${practice.body}`).join('\n');
}
