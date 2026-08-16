// The wire boundary for practices and enactment — "the runtime calls it, it
// does not link it" (S23). Everything upstream of this file is a library:
// `provision` and `enact` (practices/provision.ts, practices/enact.ts) are
// pure functions over injected ports, already built and already correct for
// S15's three outcomes. This story does not reimplement them — it puts them
// behind an API. Everything below is the smallest thing that can be true of
// "a consumer reaches this over a wire, not by importing it": a request
// shape in, a response shape out.
//
// NO SERVER LIVES HERE. `createApiHandler` returns a plain async function —
// no `listen`, no `process.env` read, no framework import, nothing that
// could not run inside a unit test with nothing else up. That is not a
// simplification of convenience; it is the point of the story, spelled out
// in `design/architecture.md`: "two composition roots, one handler — local
// and cloud differ only in which adapters are wired." That only holds if
// the handler itself is the one thing that does not know which composition
// it is in. A real transport — an HTTP framework, a queue consumer, a
// second in-process caller — deserialises a request, calls this function,
// and serialises the response back into whatever its own world expects
// (status codes, message acks, a return value). This file is neither of
// those adapters and imports neither. The test at the bottom of the suite
// for this file is the proof: it drives the handler with a plain object and
// reads a plain object back, no server having ever existed anywhere in the
// process.
//
// THE CONVERSATION ID IS NOT OPTIONAL. It travels with every request
// because spend and enactment have to be attributable back to the work that
// caused them (ADR 004, S23's own acceptance) — a governance call made on
// somebody's behalf, with no id, is a hole in the accounting exactly where
// the expensive work happens: a delegation nobody can charge to anything. A
// request that omits it is REFUSED here — reported as `rejected` — never
// silently defaulted to a placeholder. An invented id would be worse than a
// refusal: it would attribute the call to a conversation that never made
// it, a wrong answer wearing the shape of a right one. `rejected` is
// deliberately its own outcome kind, not folded into `enact`'s `refused` —
// the caller sent a malformed request, which is a different fact from a
// judge having looked at a capability and said no. Collapsing the two would
// make "you forgot the id" indistinguishable from "the bar said no", and a
// caller acting on the second diagnosis when they have the first gets
// nowhere.
//
// THE THREE OUTCOMES SURVIVE THE WIRE UNCHANGED. `enact` already fails
// closed when the bar cannot be read — `could-not-consult` — and does not
// confuse that with `refused`; see practices/enact.ts, item 2. The pressure
// to flatten the two arrives here, at the boundary, because a wire protocol
// — most concretely an HTTP status code — tempts a caller into picking ONE
// "not allowed" for both: a capability the judge refused and a bar that
// could not be consulted both look like a 4xx from outside unless the
// response body says which. This file changes nothing about the shape of
// `EnactOutcome` or `ProvisionResult` for exactly that reason: passing the
// existing discriminated unions through untouched is what keeps `refused`
// and `could-not-consult` — and `unavailable` and `nothing-matched` — as
// distinguishable coming out as they were going in. Mapping any of this to
// transport-specific codes (HTTP, gRPC, whatever) is an adapter's decision,
// made outside this file, on top of a response that still names which of
// the four kinds it is.
//
// THE FACTORY, NOT ITS PARTS. `createApiHandler` takes a `PracticeGate` —
// obtainable only from `createPracticeGate`, S15's factory, which is the
// only way to get an `enact` bound to the `provision` it reads the same bar
// through (L10: the enacting producer has hands, because the gate already
// carries its own source and reader). This file adds nothing to how that
// binding happens; it only adds the shape a caller off-process sends and
// receives.

import type { EnactOutcome, Judge, PracticeGate } from '../practices/enact.js';
import type { ProvisionResult } from '../practices/provision.js';

/** Carried on every request. See the file header for why this is required
 * rather than defaulted. */
interface RequestEnvelope {
  readonly conversationId: string;
}

export type ApiRequest =
  | (RequestEnvelope & { readonly route: 'provision'; readonly query: string })
  | (RequestEnvelope & { readonly route: 'enact'; readonly capability: string });

/**
 * The request itself was refused before either `provision` or `enact` was
 * called — a malformed request, never a judgment about a capability or a
 * bar. Kept apart from `EnactOutcome`'s `refused`, which is a judge's
 * answer to a capability that WAS consulted, and apart from
 * `could-not-consult`, which is the bar's own unavailability. See the file
 * header.
 */
export interface Rejected {
  readonly kind: 'rejected';
  readonly reason: string;
}

export type ProvisionResponse = Rejected | ProvisionResult;
export type EnactResponse = Rejected | EnactOutcome;
export type ApiResponse = ProvisionResponse | EnactResponse;

export type ApiHandler = (request: ApiRequest) => Promise<ApiResponse>;

function requireConversationId(request: ApiRequest): Rejected | undefined {
  if (typeof request.conversationId !== 'string' || request.conversationId.trim() === '') {
    return {
      kind: 'rejected',
      reason:
        'conversationId is required on every request — without it, spend and ' +
        'enactment cannot be attributed back to the work that caused them',
    };
  }
  return undefined;
}

/**
 * The one handler for both routes this story needs, and for both
 * composition roots per `design/architecture.md`. `gate` is already wired
 * to a corpus source and reader — its hands, per L10 — and `judge` is the
 * policy that decides allow-or-refuse for `enact`. Both are supplied once,
 * by the composition root, never per request: a request carries only what
 * varies per call (which route, what it asks, and who is asking).
 */
export function createApiHandler(gate: PracticeGate, judge: Judge): ApiHandler {
  return async function handle(request: ApiRequest): Promise<ApiResponse> {
    const rejected = requireConversationId(request);
    if (rejected !== undefined) {
      return rejected;
    }

    if (request.route === 'provision') {
      if (request.query.trim() === '') {
        return { kind: 'rejected', reason: 'query is required' };
      }
      return gate.provision(request.query);
    }

    // request.route === 'enact'
    if (request.capability.trim() === '') {
      return { kind: 'rejected', reason: 'capability is required' };
    }
    return gate.enact(request.capability, judge);
  };
}
