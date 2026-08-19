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
