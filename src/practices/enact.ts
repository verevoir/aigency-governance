// Enact: turn a consulted bar into a decision, and never one without the
// other.
//
// 1. THE FACTORY IS THE ACCEPTANCE CRITERION. S15's row says consulting the
// bar and enacting against it are one wiring decision — a composition cannot
// end up able to enact and unable to read what it is judged by. That is not
// a rule for a composition root to remember; it is a thing this module's
// surface makes true. `createPracticeGate` is the only export that produces
// an `enact` function, and it always hands back `provision` in the same
// object, bound to the same source and the same reader. There is no
// exported `enact` to import on its own, no factory that returns it alone.
// A caller cannot end up with the power to act and not the power to read
// what it is judged by, because there is no path to the first that does not
// pass through the second.
//
// 2. THREE OUTCOMES: `enacted`, `refused`, `could-not-consult`. The third
// exists because `provision` can answer `unavailable`, and the row already
// names a bar that could not be reached, acted on anyway, as the worst
// failure available here. So this fails closed: `could-not-consult` never
// enacts, whatever the judge might have said, because the judge is never
// asked. Failing closed costs a retry — try again once the corpus is
// reachable. Failing open costs an action taken against a standard nobody
// read, which is not a cost you get to retry your way out of.
//
// 3. `nothing-matched` IS NOT `could-not-consult`, and this is the
// distinction the third outcome exists to protect. "No practice governs
// this capability" is a real, positive answer — the bar was read
// successfully and had nothing to say — so enactment proceeds on an empty
// practice list. "The corpus could not be read" is a different fact
// entirely: nothing was consulted, and nothing can be concluded from that.
// In the code these are one branch apart — `unavailable` stops here,
// `nothing-matched` falls through to the judge — and collapsing them would
// turn "we could not check" into "there was nothing to check", which is a
// much more dangerous claim than the one it replaces.
//
// 4. EVERY OUTCOME CARRIES WHAT WAS CONSULTED — the corpus source, the
// practice ids the judge actually saw, whether the bound elided anything,
// and for a `nothing-matched` enactment, what was searched. This is true of
// `refused` and `could-not-consult` as well as `enacted`: a refusal or a
// non-consultation that cannot say what it was measured against is exactly
// as unreconstructable as an approval that cannot say it either, and an
// enactment nobody can reconstruct is indistinguishable from one that never
// consulted anything at all.
//
// 5. JUDGING IS INJECTED. This file decides none of allow-or-refuse — that
// is a `Judge`, a port, handed the capability and the practices consulted
// and asked to answer. This file's job stops at wiring `provision` to
// `enact` correctly, failing closed on `unavailable`, and building the
// record. What "governs this capability" means is somebody else's decision,
// on purpose — the same separation `resolveSettings` and the lens loader
// keep between reading a definition and acting on it.

import type { SourceReader } from '../review/load.js';
import { provision, type Elided, type Practice } from './provision.js';

/** What a `Judge` decided, and why, when it refused. */
export type JudgeVerdict =
  { readonly allow: true } | { readonly allow: false; readonly reason: string };

/**
 * Decides whether `capability` may proceed, given the practices `enact`
 * actually consulted for it. Never called for a `could-not-consult` outcome
 * — see the file header, item 2.
 */
export type Judge = (capability: string, practices: readonly Practice[]) => Promise<JudgeVerdict>;

/**
 * What was consulted to reach an outcome — present on all three outcomes,
 * per the file header, item 4. `practiceIds` is empty for `nothing-matched`
 * (nothing to consult beyond the search itself) and for `could-not-consult`
 * (nothing was read at all).
 */
export interface Consulted {
  readonly source: string;
  readonly query: string;
  readonly practiceIds: readonly string[];
  /** How many practices the corpus held that matched, when that is known. */
  readonly consideredCount?: number;
  /** Present only when the bound dropped something the judge never saw. */
  readonly elided?: Elided;
}

export type EnactOutcome =
  | { readonly kind: 'enacted'; readonly consulted: Consulted }
  | { readonly kind: 'refused'; readonly reason: string; readonly consulted: Consulted }
  | {
      readonly kind: 'could-not-consult';
      readonly why: 'missing' | 'unreachable' | 'malformed';
      readonly reason: string;
      readonly consulted: Consulted;
    };

export interface PracticeGate {
  readonly provision: ReturnType<typeof bindProvision>;
  readonly enact: (capability: string, judge: Judge) => Promise<EnactOutcome>;
}

function bindProvision(source: string, read: SourceReader, maxChars: number) {
  return (query: string) => provision(query, source, read, maxChars);
}

/**
 * The only way to obtain `enact`, and it never comes alone. Bound to one
 * corpus source, one reader and one bound, shared identically by both
 * functions it returns — so `provision` and `enact` are always looking at
 * the same bar.
 */
export function createPracticeGate(
  source: string,
  read: SourceReader,
  maxChars: number,
): PracticeGate {
  const provisionBound = bindProvision(source, read, maxChars);

  async function enact(capability: string, judge: Judge): Promise<EnactOutcome> {
    const result = await provisionBound(capability);

    if (result.kind === 'unavailable') {
      // Fails closed. The judge is never invoked — there is nothing to hand
      // it, and asking it to decide against a bar it cannot see is exactly
      // the failure item 2 names.
      return {
        kind: 'could-not-consult',
        why: result.why,
        reason: result.reason,
        consulted: { source: result.source, query: capability, practiceIds: [] },
      };
    }

    if (result.kind === 'nothing-matched') {
      // The bar was read; it had nothing to say about this capability. A
      // real, positive answer — proceed, per item 3.
      const verdict = await judge(capability, []);
      const consulted: Consulted = {
        source: result.source,
        query: capability,
        practiceIds: [],
        consideredCount: result.consideredCount,
      };
      return verdict.allow
        ? { kind: 'enacted', consulted }
        : { kind: 'refused', reason: verdict.reason, consulted };
    }

    // result.kind === 'practices'
    const verdict = await judge(capability, result.practices);
    const consulted: Consulted = {
      source,
      query: capability,
      practiceIds: result.practices.map((practice) => practice.id),
      // Present only when the bound actually cut something, matching
      // provision.ts's own convention: absence means nothing was dropped,
      // and exactOptionalPropertyTypes refuses an explicit undefined here.
      ...(result.elided !== undefined ? { elided: result.elided } : {}),
    };
    return verdict.allow
      ? { kind: 'enacted', consulted }
      : { kind: 'refused', reason: verdict.reason, consulted };
  }

  return { provision: provisionBound, enact };
}
