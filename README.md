# aigency-governance

The bar, and enacting against it: practices, capability enactment, review
panels, and the gate contract.

**Service.** Depends on `model` and `sources`. The runtime calls it over its
API and never links it (ADR 005).

_Reason to change:_ the bar changes, or how work is judged against it changes.

_Why a service:_ it owns the corpus and the review record — and as a service
with its own toolbelt, an enacting capability can reach the repository it is
enacting against, which a linked library could not (`constraints.md` L10).

The antagonist review lives here, once, rather than as twelve divergent copies
across twelve repos (L9).

Design lives in the meta repo, `verevoir/aigency-rebuild` — `design/architecture.md`
for why this boundary is here, `recon/constraints.md` for the defects it must
not reproduce.

## Verify

```
npm install   # first time only
npm run verify
```

`verify` is typecheck, test and lint. CI runs the same script, so a green pull
request and a green working tree mean the same thing.
