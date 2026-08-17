// Whether a diff fits the size this repository is willing to pay to review.
//
// review-head.mjs's own header names the gap this closes: it reviews one
// commit rather than a whole branch "because the whole branch is thousands
// of lines and there is no diff cap anywhere yet." A branch review needs
// this cap to exist before it can exist at all — deciding whether a diff can
// be reviewed has to happen before anything spawns a model, not after.
//
// Lives in scripts/, not src/review/, for the same reason buildFreshness.mjs
// does: this is a decision a *script* makes about what to spawn next, not
// part of the reviewer binary itself — dist/cli/review.js never computes a
// diff, it only reads one handed to it on stdin (see review.ts's own
// header) — so the cap belongs beside the thing that decides what to hand
// it, not inside the thing that reviews whatever it receives.
//
// THREE OUTCOMES, not two. `reviewable` and `too-large` are the obvious
// pair; `empty` is a third, distinct answer, not a variant of either — the
// same three-way shape this codebase already uses for ProvisionResult and
// SettingsResult, kept apart by a `kind` tag rather than collapsed into a
// boolean plus a maybe-reason. An empty diff is not a small diff that
// happens to fit under the cap, and it is not a failure either — it is its
// own fact about the subject, the same way review-head.mjs already treats an
// empty HEAD diff as its own reported case rather than as a diff with zero
// reviewable content. Collapsing it into `reviewable` would send a diff with
// nothing in it to a model that has nothing to review; collapsing it into
// `too-large` would call "nothing" too big, which is backwards.
//
// WHAT IS MEASURED: characters — `diff.length`. Lines were considered and
// rejected: review-head.mjs's own comment reasons in lines ("the whole
// branch is thousands of lines"), but line count and actual payload size
// disagree badly on exactly the diffs most worth capping — a changed
// lockfile is thousands of short lines at low cost per line, while a single
// reformatted or minified line can carry more content than the rest of a
// diff combined. A cap stated in lines would refuse the cheap one and wave
// through the expensive one. Characters are not exact either — a diff's real
// cost is tokens, and neither characters nor true UTF-8 byte count matches a
// tokenizer exactly, and multi-byte content (non-ASCII identifiers,
// non-Latin comments, emoji) makes a character count undercount true byte
// size. Byte count would close some of that gap and was considered. It was
// not chosen anyway, because this codebase already answered the identical
// question once, for the identical class of decision — bounding what
// reaches a model — and answered it with characters: `practiceSize` in
// practices/provision.ts measures `title.length + body.length`. Measuring
// this cap in bytes while that one stays in characters would mean two bounds
// guarding the same kind of thing, in the same codebase, disagreeing about
// what "size" means, and that inconsistency is a worse defect than the
// accuracy bytes would buy.
//
// THE CAP IS REQUIRED, not optional and not defaulted anywhere in this
// function. Two existing decisions back this, not one. `provision`'s own
// `maxChars` in practices/provision.ts is a required parameter for exactly
// this reason — its header says the floor it replaced "broke a context cap
// once by inheriting a bound nobody had to think about" — and that is the
// more direct precedent, since it is the identical shape of decision this
// file makes. The review's `AIGENCY_REVIEW_MAX_TOKENS` setting
// (src/review/settings.ts) answers a narrower version of the same question:
// it IS optional, with a default, but a value that is present and invalid is
// refused rather than silently replaced by that default — so even the one
// setting in this codebase that does default still refuses silent
// substitution once a person has said something specific. Whatever reads a
// cap value out of an environment next turn should follow that second
// pattern, for the same reason. This function has no configuration to parse
// — only a number a caller must already have decided — so it follows the
// simpler first one: no default, full stop.
//
// TOO LARGE IS REFUSED WHOLE, NEVER TRUNCATED — `too-large` carries the
// measured size and the cap, never a shortened diff. `boundToFit` in
// practices/provision.ts already made this call for a single practice
// larger than its own whole bound: dropped entirely rather than cut to fit,
// because truncating a governance rule quotes half of it as though it were
// the whole rule, and a reader has no way to tell it is half. A diff is the
// same shape of problem one level up: half a diff is not a smaller version
// of the same change, it is a different change, and a review of half a
// change that does not say so is worse than no review at all. Carrying both
// numbers means a refusal says how far over rather than merely that it is
// over — a caller can tell "the cap is nearly right" from "the cap is
// wildly wrong" without spending a second run to find out.

/**
 * @typedef {{ kind: 'reviewable', chars: number }
 *   | { kind: 'too-large', chars: number, maxChars: number }
 *   | { kind: 'empty' }} DiffCapAssessment
 */

/**
 * Decide whether `diff` fits `maxChars`, measured in characters
 * (`diff.length`). See the file header for why characters, why the cap is
 * required, and why a too-large diff is refused whole rather than
 * truncated.
 *
 * Emptiness is checked against the trimmed diff — matching the check
 * review-head.mjs already makes on `git show`'s own output — but the size
 * carried in `reviewable` and `too-large` is the untrimmed length, because
 * the untrimmed text is what would actually be sent.
 *
 * @param {string} diff
 * @param {number} maxChars
 * @returns {DiffCapAssessment}
 */
export function assessDiffCap(diff, maxChars) {
  if (diff.trim() === '') {
    return { kind: 'empty' };
  }
  const chars = diff.length;
  if (chars > maxChars) {
    return { kind: 'too-large', chars, maxChars };
  }
  return { kind: 'reviewable', chars };
}
