# The labelled defect corpus

Seeded per `design/tuned-constants-and-eval-harness.md` (outer `aigency` repo), which
is the ground-truth source for every case here and carries its own honest grading of
how well each entry was verified. Read that document before trusting anything below
it disagrees with.

## Layout

```
eval/corpus/<case-id>/subject.md   — what this case is, where the diff came from,
                                      the provenance of the ground truth, and — when
                                      diff.txt is absent — exactly why
eval/corpus/<case-id>/diff.txt     — the diff the lenses are shown (may be absent)
eval/corpus/<case-id>/truth.json   — the labelled findings, an array
```

## `truth.json`

Each entry uses the finding field names as they actually appear in a real
`.review-report/*.json` file (observed directly from
`branch__main__s24a-lens-set.json` in this repository): `lens`, `summary`,
`evidence` (`{kind, text}`), and optionally `detail`. Two fields are added on top:

- `"verdict"`: `"defect"` or `"not-a-defect"` — the ground truth a scored
  configuration is checked against.
- `"provenance"`: how the verdict was established, and how strongly. This corpus
  uses exactly the two levels the design record itself uses, deliberately not
  collapsed into one:
  - **`verified-directly`** — checked against a retrievable source in this pass
    (a real diff, a real file at a real commit, a PR's own recorded body, code read
    directly), with what was checked and against what named explicitly.
  - **`reported-not-rechecked`** — a real, specific claim, from a real prior source,
    that this pass did not independently re-verify (usually because the code or
    commit it would be checked against no longer exists to read).

A corpus that only contains real defects cannot score false positives. Every case
directory here either contains a `not-a-defect` verdict itself
(`practices-not-dead-code`) or exists specifically as the contrast case that shows
the same lens, on the same shape of evidence, can be right (`dead-decorators`) —
correct rejections are load-bearing entries, not omissions.

## Where `diff.txt` is absent

No tool available in this pass runs `git diff` between two arbitrary historical
refs. Rather than hand-fabricate hunks — which the source instructions for this
work explicitly forbid — every `diff.txt` here is either a real diff (reconstructed
by hand from complete, verified file content fetched at two real, named commits,
with that method disclosed in the case's `subject.md`) or is absent, with the
reason recorded in `subject.md` and the case kept rather than dropped.

## `diff.txt`, obtained for real rather than hand-reconstructed

`eval/corpus/make-diffs.mjs` (declared as the `make-corpus-diffs` release step in
`aigency.json`, following the pattern already set by `scripts/_diag-precompute-diff.mjs`)
reads a case's `refs.json` (`{base, head, paths?}`, all real branch names) and runs
`git diff --merge-base origin/<base> origin/<head>`, scoped to `paths` when given,
writing the result to that case's `diff.txt`. It touches only cases that carry a
`refs.json`; a case with none is left exactly as it is. This is how
`truncation-mechanism-overclaim` moved from a hand-reconstructed account to a real,
machine-produced diff, and its `provenance` was upgraded accordingly. A case whose
real base/head pair cannot be established honestly (no report file or PR names one)
is left without `refs.json` and without `diff.txt`, per the rule above, rather than
guessed at.

## A case with no `diff.txt` does not contribute to recall

This is worth stating plainly rather than leaving implicit: a lens is scored by what
it finds when shown a diff. A `truth.json` entry attached to a case with no
`diff.txt` cannot be shown to anything, so it cannot be caught, so it cannot count
toward a configuration's recall — it exists in this corpus as a documented, honestly-
sourced label, not as a scoring input. The corpus's _case count_ and its _usable-for-
scoring size_ are different numbers, and the gap between them is exactly the set of
cases with `diff.txt` absent. Whoever runs the eval against this corpus should count
only the diff-bearing cases as contributing to recall.

## Two classes of false positive, and why they are not scored the same way

Most `not-a-defect` entries here are review-lens false positives:
`practices-not-dead-code` is one lens (`blast-radius`), shown a diff, reaching the
wrong conclusion about it. Those are directly comparable to what this corpus's
recall/false-positive metrics measure a review configuration on.

**`guard-destroyed-report-false-positive` and `guard-quoted-verdict-not-asserted` are
a different class.** Both are false positives from a _guard_ — the harness-level
mechanism that checks a turn's own report for an unearned verdict claim — not from a
review lens looking at a diff. Neither has a diff, by nature: the thing that went
wrong was not a judgement about source code, it was a judgement about a report's own
prose (was a verdict token being asserted, or merely quoted). Both are kept in this
corpus because they are the same pattern the corpus exists to probe — something was
raised as wrong and was not — but **scoring either of them as though a review lens
had raised it would misrepresent what they demonstrate.** They exist to test whether
a configuration can tell reporting something from doing it, a real and recurring
confusion; they do not exist to move a lens's measured false-positive rate on
diff-shaped evidence, and neither contributes to recall for the same diff-less reason
given above.

## Two open questions this corpus inherits, unresolved

Named in `design/tuned-constants-and-eval-harness.md`'s own "What is not decided"
section, and unresolved here too — carried forward rather than silently answered
by how this corpus happens to be built:

**What happens to a corpus entry when the code it describes moves.**
`practices-not-dead-code` and `dead-decorators` are both pinned to specific commits
of `verevoir/aigency-governance` (`7b9e3e4609e80bb595c7be6f337f9422de846620` and its
immediate parent). If those files are refactored past recognition, nothing here
says whether the entry should be re-derived against the new shape, retired, or left
exactly as a snapshot of a defect that no longer maps onto current code. This
corpus does not decide that; it only tries to make the pinning explicit enough that
whoever decides it later has what they need.

**Whether a fixed defect stays as a regression check or gets retired.**
Every instance in `readme-drift`, and the decorator modules in `dead-decorators`,
are already fixed — the defects are real and historical, not live. They are kept
here as regression checks (would a configuration still catch this if the same
shape reappeared?), which is one of the two options the design record names
without choosing between. That choice was made implicitly by including them at
all; it is named here rather than left for someone to infer from the fact that
they're present.
