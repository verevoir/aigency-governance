// What a run needs before it can review anything.
//
// Every failure in this file is a configuration failure, and those have one
// property that shapes everything below: they are found by someone who does
// not yet know what is missing. So this reports EVERY missing setting at once
// and says where each one goes. Reporting the first and stopping costs a CI
// round per missing value, and the person paying that cost is the person
// least able to guess what comes next.
//
// The other rule here is that a value which is present and blank is missing.
// That is not pedantry — it is the actual failure. In GitHub Actions an unset
// secret interpolates to the empty string, so `ANTHROPIC_API_KEY` for a secret
// nobody created arrives as `''` and not as absent. Treating that as set sends
// an empty key to the provider, which returns 401, which this system would
// faithfully report as "the review could not run: HTTP 401" — true, useless,
// and pointing at the wrong thing entirely. The person needed to be told they
// had not added a secret.
//
// TWO ROUTES, SELECTED BY WHETHER A BILLED KEY IS CONFIGURED AT ALL.
// `ANTHROPIC_API_KEY` (or a file source resolving to one — see below) buys
// the `route: 'billed'` path, `anthropic.ts`'s direct call to the metered
// Messages API. Nothing configuring a key at all buys `route: 'keyless'`,
// `claudeCli.ts`'s call through the operator's already-logged-in `claude`
// CLI subscription instead. This is a deliberate reversal from an earlier
// version of this file, where an absent key was `incomplete` and blocked the
// run outright: the operator's billed credits are reserved for GitHub
// Actions, where `ANTHROPIC_API_KEY` is always set as a repository secret,
// and a laptop run — where it usually is not — should default to the
// keyless transport rather than demand a key it was never meant to spend
// locally. `route` is the field the CLI boundary (`cli/review.ts`) reads to
// decide which reviewer to construct; nothing else in this module or its
// caller needs to re-derive that decision.
//
// A KEY FILE THAT IS UNREADABLE STILL BLOCKS. The reversal above applies
// only to a key being ABSENT — nobody configured one, so there is nothing to
// report beyond "this run is keyless". A key file someone DID point at
// (`ANTHROPIC_API_KEY_FILE`, or the conventional default path) that exists
// and could not be opened (`EACCES`, `EISDIR`, any other real I/O error) is
// a different fact: a person already tried to set up the billed path and it
// is broken. Silently falling back to keyless there would hide a real
// misconfiguration behind a route that happens to still run. That case
// stays `invalid`, exactly as it always has.
//
// THE API KEY, SPECIFICALLY, HAS THREE SOURCES, TRIED IN A FIXED ORDER:
//
//   1. `ANTHROPIC_API_KEY` in the environment, if set and non-blank. This
//      wins, unconditionally, because it is how GitHub Actions supplies a
//      secret and CI must keep working exactly as it does today.
//   2. Otherwise `ANTHROPIC_API_KEY_FILE`, if set — a path to read the key
//      from.
//   3. Otherwise a conventional default path: `$XDG_CONFIG_HOME/verevoir/
//      anthropic.key`, or `~/.config/verevoir/anthropic.key` when
//      `XDG_CONFIG_HOME` is unset.
//
// A file is not only a fallback for when the environment fails to arrive — it
// is the better mechanism, and the environment variable stays first for
// compatibility rather than because it is preferred. A key in the process
// environment is inherited by every child process the runtime spawns: every
// declared command in every repository, including `npm install` running a
// postinstall script fetched off the network a moment earlier. A file read at
// the point of use is touched only by the code that needs it and nothing
// else.
//
// A key read from a file is trimmed of surrounding whitespace, including a
// trailing newline; a key read from the environment is not. That asymmetry is
// deliberate and not an oversight: `echo "key" > file` is how almost every
// key file gets written, and it always ends in a newline, so trimming a file
// is trimming what every ordinary tool produces. Whitespace arriving through
// an environment variable is a broken pipeline upstream of this process, and
// should fail loudly against the provider rather than be quietly repaired
// here.
//
// Reading a file gets the same three-way care external input gets elsewhere
// in this codebase (compare `ReadResult` in load.ts): a path that does not
// exist is not an error, it is simply that source contributing nothing, and
// resolution moves on to the next one — and now, if every source ends the
// same way, moves on to the keyless route. A file that exists and cannot be
// opened — permissions, a directory, anything else — IS distinguishable from
// one that is absent, because those are different problems for a person: one
// is "you have not set this up yet", the other is "you tried, and something
// is wrong with what you set up". And whatever goes wrong, the key's value
// never appears in an error, a reason, or a log — a failure to read names the
// path it tried, never the bytes it found or failed to find there.
//
// A PRESENT-AND-BROKEN SOURCE MUST SURVIVE EVEN WHEN SOMETHING ELSE IS ALSO
// ABSENT. `kind` — `incomplete` vs `invalid` — is decided by whether anything
// is missing, not by whether anything is broken, because a person who has
// configured nothing needs the list of what to set before anything else, and
// that stays the primary message. But absence and brokenness are not
// mutually exclusive facts about a single run, and choosing one of them to
// name the `kind` must never mean discarding the other: an unreadable key
// file is real information whether or not some other setting also happens to
// be unset. `incomplete` carries `problems` alongside `missing` for exactly
// this — an unreadable key file, or a bad `AIGENCY_REVIEW_MAX_TOKENS`, is
// never silently dropped just because something else is also unset.

/** A setting the run needs and does not have. */
export interface MissingSetting {
  /** The environment variable. */
  readonly name: string;
  /** What it is for, in one line. */
  readonly why: string;
  /** Where to put it — concrete enough to act on without leaving the log. */
  readonly where: string;
}

/**
 * The common fields both routes carry — everything that does not depend on
 * whether a billed key was configured.
 */
interface CommonSettings {
  readonly model: string;
  readonly maxTokens: number;
  readonly lensSource: string;
  /** Sent as a bearer token when the lens set is fetched over HTTP. */
  readonly lensToken?: string;
}

/**
 * What a run is configured to do — which route it takes, and everything each
 * route needs. A discriminated union rather than an optional `apiKey` field
 * on one flat shape: the billed route genuinely needs an `apiKey` and the
 * keyless route genuinely must not carry one, and a type that can express
 * "route is billed but apiKey is undefined" is a type that lets a caller
 * construct `anthropicReviewer` with nothing to authenticate with. The CLI
 * boundary (`cli/review.ts`) narrows on `route` once and TypeScript does the
 * rest.
 */
export type ReviewSettings =
  | ({ readonly route: 'billed'; readonly apiKey: string } & CommonSettings)
  | ({ readonly route: 'keyless' } & CommonSettings);

export type SettingsResult =
  | { readonly kind: 'ready'; readonly settings: ReviewSettings }
  | {
      readonly kind: 'incomplete';
      readonly missing: readonly MissingSetting[];
      /** Broken settings found along the way — never dropped just because
       * something else was also absent. See the file header. */
      readonly problems: readonly string[];
    }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] };

/**
 * What reading one candidate key file found. Three answers, for the same
 * reason `ReadResult` in load.ts has three: a file that is not there is the
 * ordinary shape of "this source has nothing to offer", and resolution moves
 * on to try the next one. A file that IS there and could not be opened is a
 * different problem for a different moment — someone already tried to set
 * this up, and `absent` would send them looking for a file that exists.
 */
export type KeyFileResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Reads one candidate path for the API key. Injected so this module never
 * touches `node:fs` itself — the same separation `loadLensSet` keeps from its
 * `SourceReader`, for the same reason: the whole precedence chain below is
 * driven by a test with no disk at all, and the one real implementation lives
 * beside the other real readers, in readers.ts.
 */
export type KeyFileReader = (path: string) => Promise<KeyFileResult>;

/**
 * Pinned, not discovered. The same commit judged by two different models is
 * two different verdicts, and a judge that changes because someone's shell
 * differs is a bar that moved without anyone deciding to move it. Sent to
 * both routes: `anthropic.ts` sends it as `model`, `claudeCli.ts` sends it
 * as `--model` (`@verevoir/llm/claude-cli`'s `ChatOptions.model`) — the same
 * commit judged by the same model whichever transport answered.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Raised from 4096 on direct evidence, not a guess: PR #1's own review
 * check - this repository judging its own definition, in CI, with no
 * override anywhere in that path - hit this ceiling on a 324,603-character
 * diff, and four of five lenses returned a `thinking` block and no text at
 * all, stop_reason max_tokens. The budget was spent entirely on reasoning
 * before a single word of the verdict could be written. 65536 is the number
 * already proven, elsewhere in this project, to complete cleanly on diffs
 * of comparable size - not a doubling picked because doubling is the
 * obvious move.
 *
 * If a lens still hits this ceiling at 65536, raising it again treats a
 * symptom. The more honest question at that point is very likely the
 * subject, not the budget: this repository's own review check, unlike
 * review-branch.mjs's standalone size cap, has no limit at all on how large
 * a diff it will attempt.
 *
 * `claudeCli.ts`'s keyless route does not send this at all — `claude -p` has
 * no confirmed flag for an output-token ceiling, and `@verevoir/llm/claude-cli`
 * silently ignores `ChatOptions.maxTokens` for exactly that reason (its own
 * file header discloses the gap). Resolved here regardless, on both routes,
 * so a caller reading `ReviewSettings` never has to ask which route it is
 * looking at before this field means something.
 */
export const DEFAULT_MAX_TOKENS = 65536;

/**
 * One home, read live — the same shape the practices already have. A
 * repository that pins a copy of this file has reintroduced the duplication
 * this story exists to remove, and the copy looks harmless for about a month.
 */
export const DEFAULT_LENS_SOURCE =
  'https://raw.githubusercontent.com/verevoir/aigency-governance/main/review/lenses.json';

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Where the conventional key file lives, given what the environment says
 * about a config home — or `undefined` when neither it nor `HOME` is set,
 * which just means this source has nowhere to look. */
function defaultKeyFilePath(env: Record<string, string | undefined>): string | undefined {
  const xdgConfigHome = present(env['XDG_CONFIG_HOME']);
  if (xdgConfigHome !== undefined) {
    return `${xdgConfigHome}/verevoir/anthropic.key`;
  }
  const home = present(env['HOME']);
  return home === undefined ? undefined : `${home}/.config/verevoir/anthropic.key`;
}

type ApiKeyResolution =
  | { readonly kind: 'found'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

/** Reads and classifies one candidate file: genuinely absent or blank (both
 * `absent` — see the file header on why a blank file is no longer worth
 * distinguishing from one that was never written, now that "nothing
 * supplied a key" means keyless rather than blocked), found, or a real
 * problem the reader could not get past. */
async function keyFromPath(path: string, readKeyFile: KeyFileReader): Promise<ApiKeyResolution> {
  const found = await readKeyFile(path);
  if (found.kind === 'absent') {
    return { kind: 'absent' };
  }
  if (found.kind === 'unreadable') {
    return { kind: 'unreadable', path, reason: found.reason };
  }
  // Trimmed here, not by the reader: a reader that trims would silently
  // repair a value handed to it some other way tomorrow. This is the one
  // place a file's content is treated differently from the environment's, and
  // the difference is deliberate — see the file header.
  const trimmed = found.text.trim();
  return trimmed === '' ? { kind: 'absent' } : { kind: 'found', value: trimmed };
}

/** The three sources, tried in order, stopping at the first that supplies a
 * value or hits a real problem. `absent` — genuinely missing, or present and
 * blank — is what lets resolution try the next source; `unreadable` is not,
 * because it is a problem with a source someone already configured. */
async function resolveApiKey(
  env: Record<string, string | undefined>,
  readKeyFile: KeyFileReader,
): Promise<ApiKeyResolution> {
  const fromEnv = present(env['ANTHROPIC_API_KEY']);
  if (fromEnv !== undefined) {
    return { kind: 'found', value: fromEnv };
  }

  const explicitPath = present(env['ANTHROPIC_API_KEY_FILE']);
  if (explicitPath !== undefined) {
    const result = await keyFromPath(explicitPath, readKeyFile);
    if (result.kind !== 'absent') {
      return result;
    }
  }

  const defaultPath = defaultKeyFilePath(env);
  if (defaultPath !== undefined) {
    const result = await keyFromPath(defaultPath, readKeyFile);
    if (result.kind !== 'absent') {
      return result;
    }
  }

  return { kind: 'absent' };
}

/**
 * Read the settings out of an environment, plus wherever the API key file
 * source points.
 *
 * Three outcomes, kept apart because they are three different jobs: `ready`
 * (with `settings.route` saying which transport it resolved to), `incomplete`
 * (something is genuinely absent — a person must supply it; no longer ever
 * true of the API key alone, see the file header) and `invalid` (something is
 * present and wrong, and nothing is also missing — a person must correct it).
 * Collapsing the last two would tell someone who typed `4o96` that they had
 * forgotten to set a value they can see in front of them.
 */
export async function resolveSettings(
  env: Record<string, string | undefined>,
  readKeyFile: KeyFileReader,
): Promise<SettingsResult> {
  const missing: MissingSetting[] = [];
  const problems: string[] = [];

  const apiKeyResolution = await resolveApiKey(env, readKeyFile);
  let apiKey: string | undefined;
  if (apiKeyResolution.kind === 'found') {
    apiKey = apiKeyResolution.value;
  } else if (apiKeyResolution.kind === 'unreadable') {
    problems.push(
      `the API key file at ${apiKeyResolution.path} could not be read: ` + apiKeyResolution.reason,
    );
  }
  // `apiKeyResolution.kind === 'absent'`: nothing to report here at all. This
  // used to push a `missing` entry for `ANTHROPIC_API_KEY`; it no longer
  // does — an absent key selects the keyless route below rather than
  // blocking the run. See the file header.

  const lensSource = present(env['AIGENCY_REVIEW_LENSES']) ?? DEFAULT_LENS_SOURCE;
  const lensToken = present(env['AIGENCY_REVIEW_LENSES_TOKEN']) ?? present(env['GITHUB_TOKEN']);

  // Only required when the definition is fetched over HTTP from a private
  // repository — which is the default, so this is the common case and not an
  // edge one. A local path needs no token, and demanding one would make the
  // laptop run impossible for no reason.
  if (lensSource.startsWith('https://raw.githubusercontent.com/') && lensToken === undefined) {
    missing.push({
      name: 'AIGENCY_REVIEW_LENSES_TOKEN',
      why: 'the lens set lives in a private repository and cannot be fetched anonymously',
      where:
        'GitHub Actions provides one already — add `AIGENCY_REVIEW_LENSES_TOKEN: ' +
        '${{ secrets.GITHUB_TOKEN }}` to the job env, or set GITHUB_TOKEN. ' +
        'Locally: a personal access token with read access to verevoir/aigency-governance. ' +
        'To review against a checked-out copy instead, set AIGENCY_REVIEW_LENSES to a file path.',
    });
  }

  const model = present(env['AIGENCY_REVIEW_MODEL']) ?? DEFAULT_MODEL;

  let maxTokens = DEFAULT_MAX_TOKENS;
  const rawMaxTokens = present(env['AIGENCY_REVIEW_MAX_TOKENS']);
  if (rawMaxTokens !== undefined) {
    const parsed = Number(rawMaxTokens);
    // Refused rather than defaulted. Silently substituting a default for a
    // value someone deliberately set is how a run comes to disagree with its
    // own configuration while reporting nothing.
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      problems.push(
        `AIGENCY_REVIEW_MAX_TOKENS must be a positive whole number, got ${JSON.stringify(rawMaxTokens)}`,
      );
    } else {
      maxTokens = parsed;
    }
  }

  // Absence decides the `kind` before invalidity does, because someone who
  // has set nothing needs the list of what to set as the primary message.
  // That does not mean a problem found alongside it is noise — it rides
  // along in `problems` either way, and `renderMissing` shows both.
  if (missing.length > 0) {
    return { kind: 'incomplete', missing, problems };
  }
  if (problems.length > 0) {
    return { kind: 'invalid', problems };
  }

  const common: CommonSettings = {
    model,
    maxTokens,
    lensSource,
    ...(lensToken !== undefined ? { lensToken } : {}),
  };

  return {
    kind: 'ready',
    settings: apiKey === undefined ? { route: 'keyless', ...common } : { route: 'billed', apiKey, ...common },
  };
}

/**
 * The missing settings — and any problems found alongside them — rendered
 * for someone reading a CI log. `problems` is a required parameter rather
 * than an optional one defaulting to empty: a call site that has a
 * `SettingsResult` in hand should be looking at it, not assuming there is
 * nothing else to pass.
 */
export function renderMissing(
  missing: readonly MissingSetting[],
  problems: readonly string[],
): string {
  const lines = [
    `The review could not run: ${String(missing.length)} setting(s) are not configured.`,
    '',
  ];
  for (const setting of missing) {
    lines.push(
      `  ${setting.name}`,
      `    what for: ${setting.why}`,
      `    where:    ${setting.where}`,
      '',
    );
  }
  if (problems.length > 0) {
    lines.push('Also present and wrong:', '');
    for (const problem of problems) {
      lines.push(`  ${problem}`, '');
    }
  }
  lines.push('This is a red result, not a passing one. Nothing was reviewed.');
  return lines.join('\n');
}
