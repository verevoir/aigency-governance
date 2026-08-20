# truncation-mechanism-overclaim

## What this case is

`.review-report/branch__s24-verify-findings__s23-api-and-bar.json` — a real
review run comparing `s23/api-and-bar` against `s24/verify-findings` — has
the `honesty` lens rejecting on one finding: a hardcoded message, attached to
every finding a `checkQuote`-style function classified as "truncated," always
asserted the _specific_ cause "reshaped by a source line wrap the diff breaks
with a real newline." The finding's own analysis: the actual check behind
that label only tested whether the citation matched after generic whitespace
normalization and comment-marker stripping — which also fires for a quote
that merely strips a leading `//`/`#`, or one that differs from the diff only
by internal whitespace (extra spaces, a tab) with no newline crossed at all.
In those cases the fixed message names a mechanism that never happened.

**Ground truth: `defect`.** A message that states a specific, checkable
mechanism as fact, produced by code that did not check for that mechanism
specifically, is exactly the shape of overclaim the `honesty` lens exists to
catch — indistinguishable in kind from the `readme-drift` instances (prose
asserting something the code does not actually do).

## Provenance

**`verdict: defect` — `provenance: verified-directly`** for the finding's own
text and quoted evidence: both are copied verbatim from a real
`.review-report/*.json` file, read directly in this pass, and the quoted
string (`'Evidence citation confirmed genuine, reshaped by a source line wrap
the diff breaks with a real newline — not invented.'`) appears nowhere else
in this pass's search of the repository except that report file itself,
confirming it as a real captured quote rather than a paraphrase.

**`provenance: reported-not-rechecked`** for whether the underlying logic
critique is _currently_ true of shipped code: grepping current `main` in
this pass for `checkQuote` (the function the finding names) found no match
anywhere in `src/` — it does not exist on `main`. The verify layer that
shipped on `main` (`src/review/verifyFindings.ts`, read directly in an
earlier pass of this same work) uses a different, simpler design entirely:
`findingIsVerified`/`verifyLensResult`, pass/fail only on whether a quote is
literally present or literally absent from the diff, with no "truncated"
outcome and no per-finding mechanism message at all. This strongly suggests
`checkQuote` and its truncation message belonged to a design on the
`s23/api-and-bar` / `s24/verify-findings` branches that did not ship in this
shape — superseded rather than directly patched — but that inference is not
independently confirmed against those branches' actual code in this pass, so
it is recorded as an inference, not a checked fact.

## `diff.txt`

**Present, and real.** A later pass established that `checkQuote` lives on
the real, still-extant branch `s23/api-and-bar` (`src/review/verifyFindings.ts`,
confirmed by `grep` against `origin/s23/api-and-bar` in that pass), and that
the report file's own name and its `.md` header (`s23/api-and-bar vs
s24/verify-findings`) name the exact base/head pair. `eval/corpus/refs.json`
records `base: s24/verify-findings`, `head: s23/api-and-bar`, scoped to
`src/review/verifyFindings.ts` and its test file; `eval/corpus/make-diffs.mjs`
(a declared release step, `make-corpus-diffs`, following the pattern already
set by `scripts/_diag-precompute-diff.mjs`) ran `git diff --merge-base
origin/s24/verify-findings origin/s23/api-and-bar -- <those two paths>` and
wrote the real result here. The diff shows the exact pre-fix `checkQuote`
(one fixed truncation message for every match, regardless of mechanism) and
the fix (`classifyTruncation`, naming each transformation that actually
applied), which is why this entry's provenance was upgraded to fully
`verified-directly` — see `truth.json`.
