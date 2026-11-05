# AGENTS.md

## What this repository is

`aigency-governance` is the review — defined once, run two ways
(`decisions/009` in `aigency-rebuild`). It holds the lens definitions and a
runner that reads them. Consuming repositories add one reusable-workflow
call and get no copy of either — the lens set and runner arrive fresh from
this repository's `main` on every run.

## Layout

- `src/review/` — the review's own machinery: lens-set loading
  (`lensSet.ts`, `load.ts`), reading sources (`readers.ts`), building and
  rendering the prompt (`prompt.ts`), calling Anthropic (`anthropic.ts`,
  verified read at `main`: a single `x-api-key` transport, no OAuth —
  see the note below about PR #5), parsing its reply (`parseReply.ts`,
  `replyContract.ts`), aggregating per-lens results into a verdict
  (`verdict.ts`), and rendering the report (`report.ts`). `settings.ts`
  (also verified read at `main`) resolves configuration — `ANTHROPIC_API_KEY`
  via a three-source chain (env, then a `..._FILE` path, then a conventional
  default path), lens-set source, model, token cap — and reports every
  missing setting at once rather than the first.
- `src/practices/` — `provision.ts` (read a practice corpus, bounded by a
  required character cap, never unbounded) and `enact.ts` (turn a
  consulted corpus into an allow/refuse decision via an injected `Judge`;
  fails closed — never enacts — if the corpus could not be read).
  `createPracticeGate` is the only way to obtain `enact`, and it always
  returns `provision` bound to the same source alongside it.
- `src/cli/` — `review.ts` (the `aigency-review` binary; reads a diff on
  stdin) and `run.ts` (`runReview`, the outcome type the CLI shares with
  callers).
- `review/lenses.json` — the published lens set consuming repositories
  fetch by default.
- `scripts/` — `check-cli.mjs` (run by the `cli` gate: starts the built
  binary, checks it refuses an empty diff) and `review-head.mjs` (run by
  the `review` release step: runs the panel against HEAD).
- `tests/` — one vitest file per module under `src/review/` and
  `src/practices/`.
- `.github/workflows/` — `verify.yml` (CI gate: `npm ci && npm run
verify`, on push to `main` and every pull request), `review.yml` (the
  reusable workflow other repositories call via `workflow_call`; takes
  `governance-ref` and `model` inputs, `anthropic-api-key` and
  `governance-token` secrets), `review-pr.yml` (this repository reviewing
  its own pull requests through the same workflow, from `./` rather than
  `@main`, pinned to the PR's own head sha).

**A pull request is currently open against this repository (#5) that
substantially rewrites `anthropic.ts` and `settings.ts`** — adding a second,
OAuth-based credential path. It is not merged; the description above is
`main`, verified directly, not that branch.

## Running it

- `npm run verify` = `typecheck && test && lint` — this is the CI gate,
  unmodified.
- `npm run build` emits `dist/` from `src/` (`tsconfig.build.json`);
  required before `bin/aigency-review` or the `cli` gate reflect a source
  change.
- `aigency.json` declares: `install`, `format`, `build` as bootstrap steps
  (they write to the tree); `verify` and `cli` as blocking gates; `review`
  as a release step, not a gate — it spends money, one Anthropic call per
  lens, and runs deliberately rather than on every verification.
- Running the reviewer locally needs `ANTHROPIC_API_KEY` and, to read the
  local lens set instead of fetching the published one over HTTP,
  `AIGENCY_REVIEW_LENSES=./review/lenses.json` — see `README.md` for the
  full local-run recipe.

## Consumed by other repositories

A repository adds `.github/workflows/review.yml` calling
`verevoir/aigency-governance/.github/workflows/review.yml@main`, with
`ANTHROPIC_API_KEY` and a governance-read token as secrets — the latter
satisfies the reusable workflow's `governance-token` input, a fine-grained
PAT with `contents: read` on this private repository.

**The exact secret name a consumer should use is unsettled as of this
reading, and this is stated rather than resolved by guessing.** This
repository's own `README.md` documents `AIGENCY_GOVERNANCE_TOKEN`. But
`aigency-runtime-v2` — a real, already-merged consumer, not a hypothetical
one — names its own secret `GOVERNANCE_TOKEN` in its `review-pr.yml`, no
prefix. Confirm which name is actually configured before assuming either;
do not treat this file's mention of `AIGENCY_GOVERNANCE_TOKEN` as settled.

The rest of the setup — the four possible outcomes, the fork-PR failure
path, every setting — is in this repository's own `README.md`; read it
directly rather than trusting a summary of it.

## Why the code is shaped as it is

This repository holds the review's implementation, not its design
history. The decisions behind it live in `verevoir/aigency-rebuild`, ref
`main`:

- `decisions/009-the-review-is-one-definition-with-two-runners.md` — why
  the review is one definition run two ways, and what both runners must
  hold (three outcomes never two, synthesis resolves toward more findings,
  no claim without a record).
- `decisions/019-guardrails-is-the-authoritative-practice-corpus.md` —
  names `src/practices/provision.ts`'s `parseCorpus` directly and records
  the `{version, practices: [{id, title, body}]}` shape it was built to
  read.
- The rest of `decisions/` and `design/` in the same repository carry
  further context this repository's own files assume but do not restate —
  start from that repository's own `README.md` at `main`.

A change here that looks arbitrary is more likely undocumented than
actually arbitrary — check there before assuming otherwise.

`decisions/005-governance-is-a-service-from-day-one.md` in the same
repository was read and deliberately not cited above: it describes a
different, not-yet-built concept (governance as a standalone service with
its own API, called over the network rather than as a reusable workflow),
which does not match what this repository actually is today. Its title
matches by name; its content does not — recorded here so the omission
reads as a check, not an oversight.
