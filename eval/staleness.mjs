// eval/staleness.mjs
//
// Every tuned number this harness produces — fan width, and anything else
// a sweep derives — is a property of the MODEL it was measured against, not
// of reviewing in general (design/tuned-constants-and-eval-harness.md, "why
// re-derivation matters"). "When the model changes, the number changes, and
// nothing today notices" is that document's own line, and this file is the
// notice: it compares the model the review path is currently configured to
// use against the model recorded in the newest file under `eval/results/`,
// and says when they disagree.
//
// A WARNING, NOT A GATE (recon/constraints.md E5). E5's own requirement is
// that a size/drift signal "asks a question early... never enforce a
// verdict late" — a human answers it, the alarm does not decide for them.
// A gate that refused reviews because an eval derivation was stale would be
// strictly worse than the staleness itself: reviewing against a possibly-
// outdated fan width is a real but survivable risk, and reviewing not at
// all is not. So `checkStaleness` below returns a verdict; nothing in this
// file throws, exits, or refuses on a caller's behalf.
//
// NAMES ITS SOURCE (H88). "A reported limit or warning names where its
// number came from... a limit with no stated source is indistinguishable
// from one nobody actually configured." A `stale` result here always
// carries `sourceFile` and `derivedAt` alongside the two models — never
// just "this looks stale", which a reader could not act on or verify.
//
// THREE OUTCOMES, NOT TWO (B2 — "empty and missing are different
// outcomes", the same shape this project keeps naming). `eval/results/`
// holding nothing derivable (today: only `.gitkeep`, because no sweep has
// ever completed) and `eval/results/` holding a derivation that has gone
// stale are different facts a caller needs told apart: the first says "no
// number exists to trust or distrust yet", the second says "a number
// exists, and it may not hold". Collapsing them into one "nothing useful"
// result would tell someone with a genuinely fresh derivation the same
// thing it tells someone who has never run the sweep at all.
//
// PURE AND TESTABLE, DELIBERATELY (matches eval/partition.mjs,
// eval/criterion.mjs and eval/score.mjs, this file's siblings). This
// module does no I/O and reaches no network: it takes the results
// directory's contents and the model the review path is configured to use
// as plain data, and returns a plain, structured verdict. In particular it
// does NOT import `resolveSettings`/`DEFAULT_MODEL` from
// `src/review/settings.ts` to work out the configured model itself —
// `sweep.mjs`'s own recorded history in eval/README.md ("Measurements")
// shows a script that imported the compiled `dist/` build of that module
// and crashed the moment the shape it assumed drifted from the shape
// `resolveSettings` actually produces. A caller that already has a
// `ReviewSettings` in hand (or an env value) passes `configuredModel` in as
// a string; this file has no opinion about how that string was resolved,
// and nothing about a settings-module contract change can break it.

/**
 * @typedef {{ name: string, text: string }} ResultsFileEntry
 * Exactly what `fs.readdir` + `fs.readFile` would hand a caller, per file,
 * for one entry of `eval/results/` — the raw name and the raw text. This
 * file parses the text itself; a caller does not need to know the results
 * schema to use this module.
 */

/**
 * @typedef {{ name: string, reason: string }} MalformedEntry
 */

/**
 * @typedef {
 *   | { kind: 'no-derivation', configuredModel: string, filesConsidered: number, malformed: MalformedEntry[] }
 *   | { kind: 'current', configuredModel: string, derivedModel: string, derivedAt: string, sourceFile: string, filesConsidered: number, malformed: MalformedEntry[] }
 *   | { kind: 'stale', configuredModel: string, derivedModel: string, derivedAt: string, sourceFile: string, filesConsidered: number, malformed: MalformedEntry[], warning: string }
 * } StalenessResult
 */

const JSON_FILE_PATTERN = /\.json$/;

/**
 * Read one results-directory entry into `{ name, model, generatedAt }`, or
 * a malformed record naming why it could not be read — never thrown, so one
 * unreadable or half-written file (a crashed `--spend` run's partial output,
 * say) does not stop every other file in the directory from being
 * considered. A non-`.json` entry (today: `.gitkeep`) is not malformed —
 * it is simply not a results file, and is dropped without comment, the same
 * way a directory listing is expected to hold things that are not the
 * thing being looked for.
 *
 * @param {ResultsFileEntry} entry
 * @returns {{ name: string, model: string, generatedAt: string } | { name: string, malformed: true, reason: string } | null}
 */
function readEntry(entry) {
  if (!JSON_FILE_PATTERN.test(entry.name)) {
    return null;
  }

  let document;
  try {
    document = JSON.parse(entry.text);
  } catch (cause) {
    return { name: entry.name, malformed: true, reason: `not valid JSON: ${cause.message}` };
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { name: entry.name, malformed: true, reason: 'not a JSON object' };
  }

  const { model, generatedAt } = document;
  if (typeof model !== 'string' || model.trim() === '') {
    return { name: entry.name, malformed: true, reason: 'missing or empty `model` field' };
  }
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
    return {
      name: entry.name,
      malformed: true,
      reason: 'missing or unparseable `generatedAt` field',
    };
  }

  return { name: entry.name, model, generatedAt };
}

/**
 * The most recently generated of a set of parsed results entries. Compared
 * by `generatedAt` (the ISO timestamp the entry itself carries), not by
 * file name and not by array order — a resumed or backfilled run can land
 * in the directory listing in any order, and the timestamp inside the file
 * is the actual fact being compared. Ties (same instant, two files) are
 * broken by file name so the choice is deterministic rather than depending
 * on which order the caller happened to list them in.
 *
 * @param {{ name: string, model: string, generatedAt: string }[]} entries
 */
function newestOf(entries) {
  return entries.reduce((best, entry) => {
    if (best === null) {
      return entry;
    }
    const delta = Date.parse(entry.generatedAt) - Date.parse(best.generatedAt);
    if (delta > 0) {
      return entry;
    }
    if (delta < 0) {
      return best;
    }
    return entry.name > best.name ? entry : best;
  }, /** @type {{ name: string, model: string, generatedAt: string } | null} */ (null));
}

function renderWarning({ derivedModel, configuredModel, derivedAt, sourceFile }) {
  return (
    `Stale eval derivation: ${sourceFile} derived its numbers (fan width and any other ` +
    `tuned constant this sweep covers) against model ${JSON.stringify(derivedModel)} on ` +
    `${derivedAt}. The review path is currently configured to use ` +
    `${JSON.stringify(configuredModel)} — a different model. A tuned number derived against ` +
    `one model is a fact about that model, not about reviewing in general, so this ` +
    `derivation may no longer hold. This is a question to check, not a verdict: re-run the ` +
    `eval sweep against ${JSON.stringify(configuredModel)} before relying on ` +
    `${sourceFile}'s numbers, or confirm by inspection that they still do.`
  );
}

/**
 * Compare the model the review path is configured to use against the model
 * recorded in the newest file in `eval/results/`, and report whether they
 * agree.
 *
 * Never throws for bad or missing DATA in `resultsFiles` — an unreadable or
 * malformed results file is recorded in the returned `malformed` array and
 * otherwise ignored, the same discipline `provision.ts`'s `parseCorpus` and
 * `loadLensSet` apply to their own inputs. Only a caller error (a missing
 * `configuredModel`, or `resultsFiles` that is not an array at all) throws,
 * because those are programming mistakes in the caller, not a fact about
 * the results directory this check exists to report on.
 *
 * @param {{ configuredModel: string, resultsFiles: readonly ResultsFileEntry[] }} input
 * @returns {StalenessResult}
 */
export function checkStaleness({ configuredModel, resultsFiles }) {
  if (typeof configuredModel !== 'string' || configuredModel.trim() === '') {
    throw new TypeError('configuredModel must be a non-empty string');
  }
  if (!Array.isArray(resultsFiles)) {
    throw new TypeError('resultsFiles must be an array');
  }

  const parsed = resultsFiles.map(readEntry).filter((entry) => entry !== null);
  const malformed = parsed
    .filter((entry) => entry.malformed === true)
    .map(({ name, reason }) => ({ name, reason }));
  const usable = parsed.filter((entry) => entry.malformed !== true);

  if (usable.length === 0) {
    // No derivation exists at all — today's actual state of eval/results/,
    // which holds only `.gitkeep` because no --spend run has completed.
    // Deliberately a different `kind` from `stale`: "no number exists yet"
    // and "a number exists and may not hold" are different facts (B2), and
    // a caller acting on this result needs to be able to tell them apart —
    // the first says nothing has been derived yet, the second says
    // something has and it needs a second look.
    return {
      kind: 'no-derivation',
      configuredModel,
      filesConsidered: resultsFiles.length,
      malformed,
    };
  }

  const newest = newestOf(usable);
  const base = {
    configuredModel,
    derivedModel: newest.model,
    derivedAt: newest.generatedAt,
    sourceFile: newest.name,
    filesConsidered: resultsFiles.length,
    malformed,
  };

  if (newest.model === configuredModel) {
    return { kind: 'current', ...base };
  }

  return { kind: 'stale', ...base, warning: renderWarning(base) };
}
