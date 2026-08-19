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
// TWO CREDENTIALS CAN AUTHENTICATE THE SAME CALL, AND THEY ARE RESOLVED AS
// ONE CHOICE, NOT TWO SETTINGS THAT HAPPEN TO COEXIST:
//
//   An API key (`ANTHROPIC_API_KEY`) is what CI has, and what production
//   review runs on. It is billed per call.
//
//   A subscription OAuth token (`AIGENCY_REVIEW_OAUTH_TOKEN`) is what a
//   laptop can have instead. It authenticates the identical Messages API call
//   — see the header of anthropic.ts for why that identity is the whole
//   reason this is safe to add rather than a second, divergent code path —
//   and it is what makes local diagnosis affordable. Every real diagnosis in
//   this repository's history so far — a missing key, a token ceiling, a
//   broken build — was found by running the panel locally against the exact
//   diff, and API rates are expensive enough to discourage the thing that
//   has been most valuable about this codebase.
//
// EACH CREDENTIAL HAS ITS OWN THREE-SOURCE CHAIN, THE SAME SHAPE THE API KEY
// ALREADY HAD, EXTENDED RATHER THAN DUPLICATED (see `resolveChain` and
// `ChainConfig` below — one function, two configurations):
//
//   1. An environment variable, if set and non-blank. Wins unconditionally
//      within its own chain, because that is how GitHub Actions supplies a
//      secret and CI must keep working exactly as it does today.
//   2. Otherwise a `..._FILE` variable naming a path to read from.
//   3. Otherwise a conventional default path under `$XDG_CONFIG_HOME/
//      verevoir/` (or `~/.config/verevoir/` when that is unset).
//
// A file is not only a fallback for when the environment fails to arrive — it
// is the better mechanism, and the environment variable stays first for
// compatibility rather than because it is preferred. A credential in the
// process environment is inherited by every child process the runtime spawns:
// every declared command in every repository, including `npm install`
// running a postinstall script fetched off the network a moment earlier. A
// file read at the point of use is touched only by the code that needs it and
// nothing else.
//
// A credential read from a file is trimmed of surrounding whitespace,
// including a trailing newline; one read from the environment is not. That
// asymmetry is deliberate and not an oversight: `echo "key" > file` is how
// almost every credential file gets written, and it always ends in a newline,
// so trimming a file is trimming what every ordinary tool produces.
// Whitespace arriving through an environment variable is a broken pipeline
// upstream of this process, and should fail loudly against the provider
// rather than be quietly repaired here.
//
// BETWEEN THE TWO CREDENTIALS, THE ORDER IS: OAUTH FIRST, ENTIRELY, THEN THE
// API KEY. Not the other order, and not "whichever is set" left to accident.
// The reasoning: nothing anywhere in this repository's CI configuration ever
// names `AIGENCY_REVIEW_OAUTH_TOKEN` — not in a workflow's `env:` block, not
// in a `secrets:` mapping (see `.github/workflows/review.yml`, whose one
// `Review` step lists every variable it receives, and does not list this
// one). A GitHub Actions runner starts with none of a contributor's local
// environment, so the omission there is what keeps it out — a fact about
// what that step's `env:` names, not a promise anyone has to remember to
// keep. That makes OAuth-first *safe*: CI can never have it, so giving it top
// priority never changes what CI does. It is also what makes it *right*: a
// developer who has deliberately set up a subscription token gets the
// cheaper path even if `ANTHROPIC_API_KEY` also happens to be lying around
// from some other tool, which is exactly the case this exists to make free —
// the alternative (API key wins when both are present) would mean the story
// this file exists for is defeated by an unrelated export sitting in a shell
// profile, silently, with nothing to say so.
//
// A source that is genuinely broken — present, and unreadable, rather than
// simply absent — is a hard stop for the WHOLE credential resolution, not a
// reason to fall through to the other credential. If the OAuth token file is
// there and cannot be opened, that is real, actionable information someone
// needs (see the same reasoning below for a broken API key file); silently
// falling through to a working `ANTHROPIC_API_KEY` at that point would spend
// real money on a run whose whole configuration exists to avoid spending it,
// and would never tell anyone why. A blank source is different — see below —
// because a blank source is not evidence of an attempt gone wrong, and
// falling through past it is the existing, established behaviour this file
// extends rather than replaces.
//
// Reading a file gets the same three-way care external input gets elsewhere
// in this codebase (compare `ReadResult` in load.ts): a path that does not
// exist is not an error, it is simply that source contributing nothing, and
// resolution moves on to the next one. A file that exists and cannot be
// opened — permissions, a directory, anything else — IS distinguishable from
// one that is absent, because those are different problems for a person: one
// is "you have not set this up yet", the other is "you tried, and something
// is wrong with what you set up". And whatever goes wrong, a credential's
// value never appears in an error, a reason, or a log — a failure to read
// names the path it tried, never the bytes it found or failed to find there.
// The report a run produces names which credential judged it — see
// `ReportContext.credentialSource` in report.ts — and names only the KIND,
// never the value: "via subscription OAuth" or "via API key", nothing that
// could be redacted because nothing that could leak was ever put there.
//
// A PRESENT-AND-BROKEN SOURCE MUST SURVIVE EVEN WHEN SOMETHING ELSE IS ALSO
// ABSENT. `kind` — `incomplete` vs `invalid` — is decided by whether anything
// is missing, not by whether anything is broken, because a person who has
// configured nothing needs the list of what to set before anything else, and
// that stays the primary message. But absence and brokenness are not
// mutually exclusive facts about a single run, and choosing one of them to
// name the `kind` must never mean discarding the other: an unreadable
// credential file is real information whether or not some other setting also
// happens to be unset. The first version of this file got that wrong —
// `incomplete` and `invalid` were built as if only one problem could ever be
// true at once, so whenever a broken key file coincided with any other
// missing setting, the broken-file message vanished entirely and the person
// was told only "you haven't set X", with no trace that the file they DID set
// was the actual problem. So `incomplete` carries `problems` alongside
// `missing`: nothing collected on the way through `resolveSettings` is ever
// silently dropped, whichever `kind` ends up describing the run, and
// `renderMissing` renders both when both are true.
//
// THE SAME GAP EXISTED FOR BLANK, NARROWER THAN UNREADABLE. A credential file
// that IS there and reads back empty is deliberately collapsed into `absent`
// inside `credentialFromPath` itself, so resolution keeps trying the next
// source within that chain — matching what `present()` already does for the
// environment. But collapsing the CONTROL FLOW and collapsing the
// INFORMATION are two different choices, and an earlier version of this file
// made only the first one: if every source ultimately came up empty, the
// report said only "ANTHROPIC_API_KEY is not configured", with no trace that
// the specific, user-configured `..._FILE` path was found and was blank —
// the exact collapse of "you never set this up" and "you set this up and it
// produced nothing" that `unreadable` was already kept apart from `missing`
// to prevent, simply missed for `blank` the first time. Resolution still
// falls through past a blank file exactly as before; it now also remembers
// every path that was blank along the way, across both credential chains, and
// `resolveSettings` names each one in `problems` whenever nothing ultimately
// supplied a credential.

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
 * Which credential authenticated a call, never the credential itself. This is
 * what a report is allowed to carry — see `ReportContext.credentialSource` in
 * report.ts — precisely because it names a KIND, not a secret: nothing here
 * could be redacted because nothing here could leak.
 */
export type CredentialSource = 'api-key' | 'subscription-oauth';

/**
 * A resolved credential: which kind it is, and the value to send with it.
 * `anthropicReviewer` (anthropic.ts) is the only place `value` is ever read
 * for anything other than comparison or redaction — see that file's header
 * for the parity argument this type exists to make possible: one transport,
 * one request shape, a `Credential` deciding only which header carries it.
 */
export interface Credential {
  readonly source: CredentialSource;
  readonly value: string;
}

export interface ReviewSettings {
  readonly credential: Credential;
  readonly model: string;
  readonly maxTokens: number;
  readonly lensSource: string;
  /** Sent as a bearer token when the lens set is fetched over HTTP. */
  readonly lensToken?: string;
}

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
 * What reading one candidate file found. Three answers, for the same reason
 * `ReadResult` in load.ts has three: a file that is not there is the ordinary
 * shape of "this source has nothing to offer", and resolution moves on to try
 * the next one. A file that IS there and could not be opened is a different
 * problem for a different moment — someone already tried to set this up, and
 * `absent` would send them looking for a file that exists. Shared between the
 * API key chain and the OAuth chain: this is a statement about reading a
 * file, and neither credential changes what that means.
 */
export type KeyFileResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Reads one candidate path for a credential. Injected so this module never
 * touches `node:fs` itself — the same separation `loadLensSet` keeps from its
 * `SourceReader`, for the same reason: the whole precedence chain below is
 * driven by a test with no disk at all, and the one real implementation lives
 * beside the other real readers, in readers.ts. One reader, used for both
 * credentials' file sources: reading a file has no opinion about what the
 * bytes authenticate.
 */
export type KeyFileReader = (path: string) => Promise<KeyFileResult>;

/**
 * Pinned, not discovered. The same commit judged by two different models is
 * two different verdicts, and a judge that changes because someone's shell
 * differs is a bar that moved without anyone deciding to move it.
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

/** Where a conventional credential file lives, given what the environment
 * says about a config home — or `undefined` when neither it nor `HOME` is
 * set, which just means this source has nowhere to look. `fileName` is the
 * one thing that differs between the two chains — `anthropic.key` versus
 * `anthropic-oauth.token` — everything else about the path is shared. */
function defaultCredentialFilePath(
  env: Record<string, string | undefined>,
  fileName: string,
): string | undefined {
  const xdgConfigHome = present(env['XDG_CONFIG_HOME']);
  if (xdgConfigHome !== undefined) {
    return `${xdgConfigHome}/verevoir/${fileName}`;
  }
  const home = present(env['HOME']);
  return home === undefined ? undefined : `${home}/.config/verevoir/${fileName}`;
}

type ChainResolution =
  | { readonly kind: 'found'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'blank'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

/** Reads and classifies one candidate file: genuinely absent, found, or
 * present but blank — kept apart from absent, unlike a step further up this
 * chain, because the caller needs to know WHICH path was blank if nothing
 * else ends up supplying a credential — or a real problem the reader could
 * not get past. */
async function credentialFromPath(
  path: string,
  readKeyFile: KeyFileReader,
): Promise<ChainResolution> {
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
  return trimmed === '' ? { kind: 'blank', path } : { kind: 'found', value: trimmed };
}

interface ChainLookup {
  readonly resolution: ChainResolution;
  readonly blankPaths: readonly string[];
}

/** One credential's three sources, named. `envVar` and `fileEnvVar` are the
 * two variable names; `defaultFileName` is the one segment that differs in
 * the conventional path. */
interface ChainConfig {
  readonly source: CredentialSource;
  readonly envVar: string;
  readonly fileEnvVar: string;
  readonly defaultFileName: string;
}

const API_KEY_CHAIN: ChainConfig = {
  source: 'api-key',
  envVar: 'ANTHROPIC_API_KEY',
  fileEnvVar: 'ANTHROPIC_API_KEY_FILE',
  defaultFileName: 'anthropic.key',
};

const OAUTH_CHAIN: ChainConfig = {
  source: 'subscription-oauth',
  envVar: 'AIGENCY_REVIEW_OAUTH_TOKEN',
  fileEnvVar: 'AIGENCY_REVIEW_OAUTH_TOKEN_FILE',
  defaultFileName: 'anthropic-oauth.token',
};

/** The three sources for ONE credential, tried in order, stopping at the
 * first that supplies a value or hits a real problem. `absent` and `blank`
 * are both what let resolution try the next source; `unreadable` is not,
 * because it is a problem with a source someone already configured. A
 * `blank` result is never returned as the final resolution — it always
 * either yields to the next source or, having none left, becomes `absent` —
 * but every path found blank along the way is collected in `blankPaths`
 * regardless of how the search ends. Generalised from what used to be named
 * `resolveApiKey`: the API key chain and the OAuth chain are this same
 * function, given different names — see `ChainConfig` above. */
async function resolveChain(
  env: Record<string, string | undefined>,
  readKeyFile: KeyFileReader,
  chain: ChainConfig,
): Promise<ChainLookup> {
  const fromEnv = present(env[chain.envVar]);
  if (fromEnv !== undefined) {
    return { resolution: { kind: 'found', value: fromEnv }, blankPaths: [] };
  }

  const blankPaths: string[] = [];

  const explicitPath = present(env[chain.fileEnvVar]);
  if (explicitPath !== undefined) {
    const result = await credentialFromPath(explicitPath, readKeyFile);
    if (result.kind === 'blank') {
      blankPaths.push(result.path);
    } else if (result.kind !== 'absent') {
      return { resolution: result, blankPaths };
    }
  }

  const defaultPath = defaultCredentialFilePath(env, chain.defaultFileName);
  if (defaultPath !== undefined) {
    const result = await credentialFromPath(defaultPath, readKeyFile);
    if (result.kind === 'blank') {
      blankPaths.push(result.path);
    } else if (result.kind !== 'absent') {
      return { resolution: result, blankPaths };
    }
  }

  return { resolution: { kind: 'absent' }, blankPaths };
}

type CredentialResolution =
  | { readonly kind: 'found'; readonly credential: Credential }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

interface CredentialLookup {
  readonly resolution: CredentialResolution;
  /** Every path found blank, across BOTH chains, in the order they were
   * tried — even the ones from a chain that was not, in the end, the one
   * that supplied the credential. See the file header: a blank file is real
   * information that must not vanish just because something else eventually
   * worked out or came up empty too. */
  readonly blankPaths: readonly string[];
}

/**
 * The choice between the two credentials, made once, deterministically. See
 * the file header for the full argument; the shape of it here is: try OAuth
 * first, in full — all three of its sources — and only fall through to the
 * API key chain when OAuth resolved to nothing at all (`absent`). A genuinely
 * broken OAuth source (`unreadable`) is a hard stop: it is reported and
 * resolution does not continue on to the API key, because silently spending
 * a paid credential instead of surfacing a broken free one would be exactly
 * the kind of accident this function exists to remove.
 */
async function resolveCredential(
  env: Record<string, string | undefined>,
  readKeyFile: KeyFileReader,
): Promise<CredentialLookup> {
  const oauth = await resolveChain(env, readKeyFile, OAUTH_CHAIN);

  if (oauth.resolution.kind === 'found') {
    return {
      resolution: {
        kind: 'found',
        credential: { source: 'subscription-oauth', value: oauth.resolution.value },
      },
      blankPaths: oauth.blankPaths,
    };
  }
  if (oauth.resolution.kind === 'unreadable') {
    return { resolution: oauth.resolution, blankPaths: oauth.blankPaths };
  }

  // oauth.resolution.kind === 'absent': OAuth contributed nothing, though it
  // may have left blank paths behind — carried forward regardless of what
  // the API key chain does next.
  const apiKey = await resolveChain(env, readKeyFile, API_KEY_CHAIN);
  const blankPaths = [...oauth.blankPaths, ...apiKey.blankPaths];

  if (apiKey.resolution.kind === 'found') {
    return {
      resolution: {
        kind: 'found',
        credential: { source: 'api-key', value: apiKey.resolution.value },
      },
      blankPaths,
    };
  }
  if (apiKey.resolution.kind === 'unreadable') {
    return { resolution: apiKey.resolution, blankPaths };
  }
  return { resolution: { kind: 'absent' }, blankPaths };
}

/**
 * Read the settings out of an environment, plus wherever the credential file
 * sources point.
 *
 * Three outcomes, kept apart because they are three different jobs: `ready`,
 * `incomplete` (something is absent — a person must supply it) and `invalid`
 * (something is present and wrong, and nothing is also absent — a person must
 * correct it). Collapsing the last two would tell someone who typed `4o96`
 * that they had forgotten to set a value they can see in front of them.
 *
 * `incomplete` wins the `kind` whenever anything is missing — absence stays
 * the primary message — but it carries `problems` too, so a broken
 * credential file or a bad `AIGENCY_REVIEW_MAX_TOKENS` found along the way is
 * never silently dropped just because something else also happened to be
 * unset. See the file header for why this matters.
 */
export async function resolveSettings(
  env: Record<string, string | undefined>,
  readKeyFile: KeyFileReader,
): Promise<SettingsResult> {
  const missing: MissingSetting[] = [];
  const problems: string[] = [];

  const credentialLookup = await resolveCredential(env, readKeyFile);
  const credentialResolution = credentialLookup.resolution;
  let credential: Credential | undefined;
  if (credentialResolution.kind === 'found') {
    credential = credentialResolution.credential;
  } else if (credentialResolution.kind === 'unreadable') {
    problems.push(
      `the credential file at ${credentialResolution.path} could not be read: ` +
        credentialResolution.reason,
    );
    for (const path of credentialLookup.blankPaths) {
      problems.push(`the credential file at ${path} was found but was blank`);
    }
  } else {
    missing.push({
      name: 'ANTHROPIC_API_KEY',
      why: 'the review calls a model once per lens, and needs a credential to call it with',
      where:
        'GitHub: Settings → Secrets and variables → Actions → New repository secret, ' +
        'named ANTHROPIC_API_KEY. Locally, two independent ways to supply one — see ' +
        'settings.ts for how they are chosen between when both are set. An API key: ' +
        'export ANTHROPIC_API_KEY=sk-..., or set ANTHROPIC_API_KEY_FILE to a path ' +
        'holding it, or place it at $XDG_CONFIG_HOME/verevoir/anthropic.key ' +
        '(~/.config/verevoir/anthropic.key when XDG_CONFIG_HOME is unset). Or a ' +
        'subscription, which costs nothing per call: export ' +
        'AIGENCY_REVIEW_OAUTH_TOKEN=..., or set AIGENCY_REVIEW_OAUTH_TOKEN_FILE to a ' +
        'path holding it, or place it at ' +
        '$XDG_CONFIG_HOME/verevoir/anthropic-oauth.token ' +
        '(~/.config/verevoir/anthropic-oauth.token when XDG_CONFIG_HOME is unset). ' +
        'CI never sets the OAuth variable, so it is the right default for a laptop and ' +
        'cannot affect a production run.',
    });
    for (const path of credentialLookup.blankPaths) {
      problems.push(`the credential file at ${path} was found but was blank`);
    }
  }

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
  return {
    kind: 'ready',
    settings: {
      credential: credential as Credential,
      model,
      maxTokens,
      lensSource,
      ...(lensToken !== undefined ? { lensToken } : {}),
    },
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
