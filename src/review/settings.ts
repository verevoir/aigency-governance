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
//   A subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) is what a laptop
//   can have instead. NAMED THAT, NOT SOMETHING TIDIER, BECAUSE THAT IS THE
//   VARIABLE THAT IS ACTUALLY THERE: this is the token Claude Code's own
//   runtime already sets when this project is being worked on inside it —
//   this file reads the name a caller already has, rather than inventing an
//   `AIGENCY_...`-prefixed one and asking every caller to alias it. A
//   resolver that reads a name of its own choosing instead of the name an
//   operator actually has is exactly the shape of defect (H87) this codebase
//   keeps finding elsewhere: a value that is genuinely present and never
//   arrives, because nothing was listening for its real name. It
//   authenticates the identical Messages API call — see the header of
//   anthropic.ts for why that identity is the whole reason this is safe to
//   add rather than a second, divergent code path — and it is what makes
//   local diagnosis affordable. Every real diagnosis in this repository's
//   history so far — a missing key, a token ceiling, a broken build — was
//   found by running the panel locally against the exact diff, and API rates
//   are expensive enough to discourage the thing that has been most valuable
//   about this codebase.
//
//   The FILE-based fallback for this credential (`..._FILE` and the default
//   path) keeps this project's own `AIGENCY_REVIEW_OAUTH_TOKEN_FILE` naming
//   rather than following suit, deliberately: that mechanism does not come
//   from any runtime, it is this project's own convention for a laptop not
//   running inside Claude Code, and it stays named the way the rest of this
//   project names things it invented.
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
// names `CLAUDE_CODE_OAUTH_TOKEN` — not in a workflow's `env:` block, not
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
// LOCAL RUNS CAN BE MADE TO REFUSE RATHER THAN FALL BACK, AND THAT IS A
// SEPARATE KNOB FROM THE ORDERING ABOVE. The ordering makes OAuth-first safe
// and right; it does not, by itself, ENFORCE that a local run never reaches
// `ANTHROPIC_API_KEY` — if the OAuth token is misconfigured in a way that
// resolves to `absent` (a blank environment variable, or an explicit
// `..._FILE` path pointing at nothing), resolution would otherwise fall
// through to a working API key and spend real credits, silently, on the one
// run that exists specifically to avoid spending them. `allowApiKeyFallback`
// on `resolveCredential`/`resolveSettings` is that enforcement: when false,
// an `absent` OAuth resolution is reported directly, as a refusal naming
// which OAuth signal (if any) was attempted, and the API key chain is never
// even tried. `scripts/review-head.mjs` — the only local entry point — passes
// this as false, unconditionally, via `AIGENCY_REVIEW_ALLOW_API_KEY_FALLBACK`
// (see cli/review.ts). Nothing in `.github/workflows/review.yml` sets that
// variable, so CI's own resolution is completely unaffected by it: CI never
// passes through this branch at all, the same way it never sets
// `CLAUDE_CODE_OAUTH_TOKEN` in the first place.
//
// BLANK-ENV AND MISSING-EXPLICIT-PATH ARE TRACKED FOR THE SAME REASON A BLANK
// FILE ALREADY WAS, AND THAT TRACKING MUST SURVIVE WHICHEVER PATH REACHES IT.
// `resolveChain` already told a blank *file* apart from an absent one, for
// the ordinary case (see `blankPaths` below) — a genuine attempt that
// produced nothing is different information from never having tried. The
// same gap existed, unnoticed, for the environment variable and for an
// explicit `*_FILE` path naming a file that is not there: both collapsed
// into plain `absent`, indistinguishable from "OAuth was never mentioned".
// That is harmless while resolution is allowed to fall through — the
// distinction only matters once refusing is the alternative to spending
// money, which is when the refusal path (`!allowApiKeyFallback`) surfaces
// it: `blankEnvVar` and `missingExplicitPath` on `ChainLookup` exist for
// that path. The panel's review of this file's first version found that the
// SAME two signals were silently discarded on the *other*, ordinary
// fallback-allowed path too — the one CI and every default caller actually
// takes — whenever the API key chain was tried next and also came up empty:
// a blank `CLAUDE_CODE_OAUTH_TOKEN` or a missing explicit OAuth file path
// was a genuine attempt exactly as much there as on the refusal path, and
// reported identically to OAuth never having been mentioned at all.
// `CredentialLookup.oauthAttempted` (see `resolveCredential` below) is the
// fix: the same two signals, computed the same way, surfaced wherever
// nothing ultimately supplies a credential — not only when fallback was
// refused. The identical gap existed for the API-key chain's own blank-env
// and missing-explicit-path signals — computed by the same generic
// `resolveChain`, and never read by anything until the panel's third review
// found the asymmetry. `CredentialLookup.apiKeyAttempted` closes it the same
// way.
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
  /** Every path THIS ONE chain found blank, in the order tried. Paired with
   * the chain's own `CredentialSource` at the point it is pushed, in
   * `resolveChain` — not left as a bare path — so a message built from it
   * can name which credential's file it was. See `credentialLabel` and the
   * panel's sixth review, which found a blank OAuth file and a blank
   * API-key file rendered as the identical sentence. */
  readonly blankPaths: readonly { readonly path: string; readonly source: CredentialSource }[];
  /** True when this chain's environment variable was set but blank — a
   * signal that someone attempted to configure this credential through the
   * environment and it arrived empty, as distinct from never having
   * mentioned it at all. Read, via `attemptSignals`, by OAuth's refusal
   * path in `resolveCredential` and by the ordinary fallback-allowed path
   * too — for both chains, not only OAuth's — see the file header. */
  readonly blankEnvVar: boolean;
  /** The `*_FILE` path, when the corresponding env var named one but no file
   * was found there — a signal that someone attempted to point this
   * credential at a file, as distinct from never having set the `*_FILE`
   * variable at all. `undefined` when no such attempt was made. Read, via
   * `attemptSignals`, by OAuth's refusal path in `resolveCredential` and by
   * the ordinary fallback-allowed path too — for both chains, not only
   * OAuth's — see the file header. */
  readonly missingExplicitPath?: string;
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

// `envVar` here is `CLAUDE_CODE_OAUTH_TOKEN`, not an `AIGENCY_...`-prefixed
// name to match its sibling below — see the file header's "NAMED THAT, NOT
// SOMETHING TIDIER" paragraph for why: this is the name a caller already
// has, from Claude Code's own runtime, and reading a name of this project's
// own choosing instead would mean the token that is actually present never
// resolves.
const OAUTH_CHAIN: ChainConfig = {
  source: 'subscription-oauth',
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
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
  const rawEnv = env[chain.envVar];
  const fromEnv = present(rawEnv);
  if (fromEnv !== undefined) {
    return { resolution: { kind: 'found', value: fromEnv }, blankPaths: [], blankEnvVar: false };
  }
  // Set but blank is a real attempt, distinct from never having mentioned
  // the variable at all — see the file header. Read by OAuth's refusal
  // path in `resolveCredential`, and by the ordinary fallback-allowed path
  // too, via `attemptSignals` — for whichever chain this is, not only
  // OAuth's. This comment previously said the fallback-allowed path did
  // nothing with it; that became false once the refusal-path fix landed,
  // and stayed uncorrected — see CredentialLookup.oauthAttempted and
  // CredentialLookup.apiKeyAttempted.
  const blankEnvVar = rawEnv !== undefined && rawEnv.trim() === '';

  const blankPaths: { path: string; source: CredentialSource }[] = [];
  let missingExplicitPath: string | undefined;

  const explicitPath = present(env[chain.fileEnvVar]);
  if (explicitPath !== undefined) {
    const result = await credentialFromPath(explicitPath, readKeyFile);
    if (result.kind === 'blank') {
      blankPaths.push({ path: result.path, source: chain.source });
    } else if (result.kind === 'absent') {
      // Attempted and not there — different from the *_FILE variable never
      // having been set. See the file header.
      missingExplicitPath = explicitPath;
    } else {
      return { resolution: result, blankPaths, blankEnvVar };
    }
  }

  const defaultPath = defaultCredentialFilePath(env, chain.defaultFileName);
  if (defaultPath !== undefined) {
    const result = await credentialFromPath(defaultPath, readKeyFile);
    if (result.kind === 'blank') {
      blankPaths.push({ path: result.path, source: chain.source });
    } else if (result.kind !== 'absent') {
      return {
        resolution: result,
        blankPaths,
        blankEnvVar,
        ...(missingExplicitPath !== undefined ? { missingExplicitPath } : {}),
      };
    }
  }

  return {
    resolution: { kind: 'absent' },
    blankPaths,
    blankEnvVar,
    ...(missingExplicitPath !== undefined ? { missingExplicitPath } : {}),
  };
}

type CredentialResolution =
  | { readonly kind: 'found'; readonly credential: Credential }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'unreadable';
      readonly path: string;
      readonly reason: string;
      /** Which credential this broken file belongs to — the panel's sixth
       * review found `resolveSettings` naming neither, so a reader whose
       * `*_FILE` path was not one of the two conventional filenames could
       * not tell which credential had actually broken. See
       * `credentialLabel`. */
      readonly source: CredentialSource;
    }
  | {
      /** OAuth resolved to nothing and `allowApiKeyFallback` was false, so
       * the API key chain was never tried. See the file header. */
      readonly kind: 'oauth-required';
      /** What was actually attempted for OAuth, in the order tried — empty
       * when OAuth was never mentioned at all. */
      readonly attempted: readonly string[];
    };

interface CredentialLookup {
  readonly resolution: CredentialResolution;
  /** Every path found blank, across BOTH chains, in the order they were
   * tried — even the ones from a chain that was not, in the end, the one
   * that supplied the credential. See the file header: a blank file is real
   * information that must not vanish just because something else eventually
   * worked out or came up empty too. Each entry carries its own
   * `CredentialSource`, for the same reason `CredentialResolution`'s
   * `unreadable` variant now does — see that type's doc comment and
   * `credentialLabel`. */
  readonly blankPaths: readonly { readonly path: string; readonly source: CredentialSource }[];
  /**
   * A genuine OAuth attempt that produced nothing — a blank
   * `CLAUDE_CODE_OAUTH_TOKEN`, or an `AIGENCY_REVIEW_OAUTH_TOKEN_FILE`
   * naming a path that does not exist — carried forward whenever nothing
   * ultimately supplies a credential, regardless of WHY nothing did:
   * whether OAuth was required and refused (`oauth-required` builds and
   * reports this same information itself, so it stays empty here for that
   * branch) or whether fallback was allowed and the API key chain was tried
   * next and also came up empty (the ordinary path CI and every default
   * caller take). The panel's review of this file's first version found
   * that this second case discarded both signals entirely — see the file
   * header's "BLANK-ENV AND MISSING-EXPLICIT-PATH" section. Deliberately
   * excludes blank OAuth *files*: those are already carried in `blankPaths`
   * above and rendered from there, so repeating them here would report the
   * same fact under two different names. Empty whenever a credential was
   * found. NOT empty when OAuth's own file resolved to `unreadable` either —
   * an earlier version of this comment said it was, which stayed true only
   * until the panel's fourth review found that branch discarding a genuine
   * OAuth attempt signal it should have preserved, the same way the
   * fallback-allowed path above already had to learn to. See
   * `resolveCredential`'s oauth-unreadable branch, which computes this via
   * `attemptSignals` like every other branch here does — the panel's fifth
   * review found this comment had not been updated to match.
   */
  readonly oauthAttempted: readonly string[];
  /**
   * The same signal, mirrored for the API-key chain. `resolveChain`
   * already computed a blank-env-var and missing-explicit-path signal for
   * the API-key chain exactly as it does for OAuth's, but nothing ever
   * read them until the panel's third review found the asymmetry: a blank
   * `ANTHROPIC_API_KEY`, or an `ANTHROPIC_API_KEY_FILE` naming a path that
   * does not exist, collapsed indistinguishably into "ANTHROPIC_API_KEY is
   * not configured". Carried forward whenever the API-key chain was
   * actually tried and did not supply a credential — the final all-absent
   * outcome, or the API-key chain itself resolving to `unreadable`. Empty
   * whenever the API-key chain was never reached at all: OAuth resolved to
   * `found` or `unreadable`, or fallback was disallowed and
   * `oauth-required` refused before the API-key chain was ever tried.
   * Deliberately excludes blank API-key *files*: those are already carried
   * in `blankPaths` above.
   */
  readonly apiKeyAttempted: readonly string[];
}

/** The two attempt signals a blank source and a missing explicit path leave
 * behind for ONE chain, independent of the blank-FILE case already tracked
 * in `blankPaths` — see `ChainLookup`, `CredentialLookup.oauthAttempted` and
 * `CredentialLookup.apiKeyAttempted` above. Generalised, like `resolveChain`
 * itself, to one function given either chain's own lookup and config — see
 * `ChainConfig` — rather than an OAuth-only version and a second,
 * API-key-only copy the panel's third review found missing. Used by OAuth's
 * refusal path (`oauth-required`, which appends its own blank-file messages
 * on top) and by the ordinary fallback-allowed path, for whichever chain(s)
 * were actually tried and came up empty. */
function attemptSignals(chain: ChainLookup, config: ChainConfig): string[] {
  const attempted: string[] = [];
  if (chain.blankEnvVar) {
    attempted.push(`${config.envVar} is set but blank`);
  }
  if (chain.missingExplicitPath !== undefined) {
    attempted.push(
      `${config.fileEnvVar} names ${chain.missingExplicitPath}, but no file exists there`,
    );
  }
  return attempted;
}

/**
 * The two-word phrase a reader uses to tell the two credentials' broken
 * files apart, once the path itself is not self-describing enough to —
 * an explicit `*_FILE` pointing somewhere other than the two conventional
 * filenames (`anthropic.key`, `anthropic-oauth.token`) gives no clue on its
 * own. The panel's sixth review found `resolveSettings` rendering an
 * unreadable or blank OAuth file and an unreadable or blank API-key file
 * through the identical sentence, with nothing to tell them apart — the
 * exact same words `report.ts`'s own `CREDENTIAL_LABEL` already uses for
 * the same two kinds ("via API key" / "via subscription OAuth"), reused
 * here rather than invented afresh, so a reader carries one mapping
 * between the two places a credential's kind is ever named.
 */
function credentialLabel(source: CredentialSource): string {
  return source === 'api-key' ? 'API key' : 'subscription OAuth';
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
 *
 * `allowApiKeyFallback` is a second, independent hard stop: when false, an
 * `absent` OAuth resolution is reported directly as `oauth-required`, naming
 * whatever OAuth signal was actually attempted, and the API key chain is
 * never called at all — not tried and rejected, never invoked. See the file
 * header for why this exists apart from the ordering above.
 */
async function resolveCredential(
  env: Record<string, string | undefined>,
  readKeyFile: KeyFileReader,
  allowApiKeyFallback: boolean,
): Promise<CredentialLookup> {
  const oauth = await resolveChain(env, readKeyFile, OAUTH_CHAIN);

  if (oauth.resolution.kind === 'found') {
    return {
      resolution: {
        kind: 'found',
        credential: { source: 'subscription-oauth', value: oauth.resolution.value },
      },
      blankPaths: oauth.blankPaths,
      oauthAttempted: [],
      apiKeyAttempted: [],
    };
  }
  if (oauth.resolution.kind === 'unreadable') {
    // OAuth's own file is broken — a hard stop, unchanged. But this branch
    // previously discarded OAuth's own genuinely-attempted signals (a blank
    // CLAUDE_CODE_OAUTH_TOKEN, a missing explicit *_FILE path) by
    // hardcoding oauthAttempted: [], exactly the bug already fixed in the
    // sibling apiKey-unreadable branch below for the CROSS-chain case (OAuth
    // blank, API key file unreadable) — the panel's fourth review found the
    // SAME-chain case (OAuth blank, OAuth's own file unreadable) left
    // uncorrected. Computed via the same attemptSignals helper every other
    // branch here already uses.
    return {
      resolution: { ...oauth.resolution, source: OAUTH_CHAIN.source },
      blankPaths: oauth.blankPaths,
      oauthAttempted: attemptSignals(oauth, OAUTH_CHAIN),
      apiKeyAttempted: [],
    };
  }

  // oauth.resolution.kind === 'absent'.
  if (!allowApiKeyFallback) {
    const attempted = attemptSignals(oauth, OAUTH_CHAIN);
    for (const blank of oauth.blankPaths) {
      attempted.push(
        `the ${credentialLabel(blank.source)} credential file at ${blank.path} was found but was blank`,
      );
    }
    return {
      resolution: { kind: 'oauth-required', attempted },
      blankPaths: oauth.blankPaths,
      oauthAttempted: [],
      apiKeyAttempted: [],
    };
  }

  // OAuth contributed nothing, though it may have left blank paths behind —
  // carried forward regardless of what the API key chain does next.
  const apiKey = await resolveChain(env, readKeyFile, API_KEY_CHAIN);
  const blankPaths = [...oauth.blankPaths, ...apiKey.blankPaths];

  if (apiKey.resolution.kind === 'found') {
    return {
      resolution: {
        kind: 'found',
        credential: { source: 'api-key', value: apiKey.resolution.value },
      },
      blankPaths,
      oauthAttempted: [],
      apiKeyAttempted: [],
    };
  }
  if (apiKey.resolution.kind === 'unreadable') {
    // The API-key chain hit a real problem — a file found but not readable
    // — and this branch previously discarded whatever OAuth had genuinely
    // attempted along the way (a blank env var, a missing explicit path) by
    // hardcoding oauthAttempted: []. That collapsed two independently
    // real, distinguishable failures into one reported cause. Computed via
    // the same helper the plain-absent branch below already uses — see
    // CredentialLookup.oauthAttempted. apiKeyAttempted is included for the
    // same reason: a blank ANTHROPIC_API_KEY alongside its own unreadable
    // file is a second, independently real fact about this same chain —
    // see CredentialLookup.apiKeyAttempted.
    return {
      resolution: { ...apiKey.resolution, source: API_KEY_CHAIN.source },
      blankPaths,
      oauthAttempted: attemptSignals(oauth, OAUTH_CHAIN),
      apiKeyAttempted: attemptSignals(apiKey, API_KEY_CHAIN),
    };
  }
  // Nothing at all supplied a credential, on either chain. The blank-FILE
  // signal is already folded into `blankPaths` above; the two signals that
  // previously vanished here — a blank OAuth env var, or an explicit OAuth
  // `*_FILE` path naming nothing — are surfaced now too, exactly as
  // `oauth-required` already surfaces them when fallback is refused instead
  // of allowed. See the file header and `CredentialLookup.oauthAttempted`.
  // The identical gap existed on the API-key side, unnoticed because the
  // machinery to close it (`attemptSignals`, generalised here from what was
  // `oauthAttemptSignals`) had only ever been built for OAuth — see
  // `CredentialLookup.apiKeyAttempted`.
  return {
    resolution: { kind: 'absent' },
    blankPaths,
    oauthAttempted: attemptSignals(oauth, OAUTH_CHAIN),
    apiKeyAttempted: attemptSignals(apiKey, API_KEY_CHAIN),
  };
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
  allowApiKeyFallback = true,
): Promise<SettingsResult> {
  const missing: MissingSetting[] = [];
  const problems: string[] = [];

  const credentialLookup = await resolveCredential(env, readKeyFile, allowApiKeyFallback);
  const credentialResolution = credentialLookup.resolution;
  let credential: Credential | undefined;
  if (credentialResolution.kind === 'found') {
    credential = credentialResolution.credential;
  } else if (credentialResolution.kind === 'unreadable') {
    problems.push(
      `the ${credentialLabel(credentialResolution.source)} credential file at ` +
        `${credentialResolution.path} could not be read: ${credentialResolution.reason}`,
    );
    for (const blank of credentialLookup.blankPaths) {
      problems.push(
        `the ${credentialLabel(blank.source)} credential file at ${blank.path} was found but was blank`,
      );
    }
    // The other half of this fix: an OAuth attempt (a blank env var, a
    // missing explicit path) must not vanish just because the API-key
    // chain's own failure is also being reported here. See
    // resolveCredential's apiKey-unreadable branch and
    // CredentialLookup.oauthAttempted.
    for (const detail of credentialLookup.oauthAttempted) {
      problems.push(detail);
    }
    // The mirror of the fix above, for the API-key chain's own signals —
    // see CredentialLookup.apiKeyAttempted. Empty here whenever OAuth
    // itself was the source of `unreadable`, since the API-key chain is
    // never reached in that case.
    for (const detail of credentialLookup.apiKeyAttempted) {
      problems.push(detail);
    }
  } else if (credentialResolution.kind === 'oauth-required') {
    // allowApiKeyFallback was false and OAuth resolved to nothing: the API
    // key was never tried, so ANTHROPIC_API_KEY is not the missing setting
    // here — CLAUDE_CODE_OAUTH_TOKEN is. See the file header.
    missing.push({
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      why:
        'this is a local run, and local runs are restricted to the subscription so that ' +
        'purchased API credits are spent only by GitHub Actions',
      where:
        'Claude Code already sets this when this runs inside it, or export it yourself, ' +
        'or set AIGENCY_REVIEW_OAUTH_TOKEN_FILE to a path holding it, or place it at ' +
        '$XDG_CONFIG_HOME/verevoir/anthropic-oauth.token ' +
        '(~/.config/verevoir/anthropic-oauth.token when XDG_CONFIG_HOME is unset). ' +
        'ANTHROPIC_API_KEY is not offered as an alternative for a local run: purchased ' +
        'credits are for GitHub Actions only.',
    });
    for (const detail of credentialResolution.attempted) {
      problems.push(detail);
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
        'subscription, which costs nothing per call: Claude Code already sets ' +
        'CLAUDE_CODE_OAUTH_TOKEN when this runs inside it, or export it yourself, ' +
        'or set AIGENCY_REVIEW_OAUTH_TOKEN_FILE to a path holding it, or place it at ' +
        '$XDG_CONFIG_HOME/verevoir/anthropic-oauth.token ' +
        '(~/.config/verevoir/anthropic-oauth.token when XDG_CONFIG_HOME is unset). ' +
        'CI never sets the OAuth variable, so it is the right default for a laptop and ' +
        'cannot affect a production run.',
    });
    for (const blank of credentialLookup.blankPaths) {
      problems.push(
        `the ${credentialLabel(blank.source)} credential file at ${blank.path} was found but was blank`,
      );
    }
    // The gap the panel's review found: a blank CLAUDE_CODE_OAUTH_TOKEN, or
    // an AIGENCY_REVIEW_OAUTH_TOKEN_FILE naming a path that is not there, is
    // a genuine attempt exactly as much here — the ordinary fallback-allowed
    // path — as it already was on the refusal path above. See the file
    // header and CredentialLookup.oauthAttempted.
    for (const detail of credentialLookup.oauthAttempted) {
      problems.push(detail);
    }
    // The asymmetry the panel's third review found: resolveChain already
    // computed these same two signals for the API-key chain too, but
    // nothing ever read them, so a blank ANTHROPIC_API_KEY or an
    // ANTHROPIC_API_KEY_FILE naming a path that does not exist collapsed
    // indistinguishably into "ANTHROPIC_API_KEY is not configured" — the
    // exact distinction this file went to some trouble to establish for
    // OAuth, left unestablished for the identical case one chain over. See
    // CredentialLookup.apiKeyAttempted.
    for (const detail of credentialLookup.apiKeyAttempted) {
      problems.push(detail);
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

  // The panel's fifth review found this: cli/review.ts computes
  // allowApiKeyFallback with `process.env[...] !== 'false'`, a strict
  // inequality against one literal string — so ANY other value (a typo,
  // '0', 'False', 'no') is treated exactly like the variable never having
  // been set at all, and fallback silently stays allowed with no problem
  // reported, even though the whole point of this variable is to make a
  // local run refuse rather than spend a purchased credential. Validated
  // here, independently of the boolean the caller already computed and
  // passed in as `allowApiKeyFallback` above, for the same reason every
  // other setting in this function is validated here rather than at the
  // call site: this module is the one place a malformed value becomes a
  // reportable message rather than a silent default. `present()`, not a raw
  // read: a blank value is treated as not set (matching MAX_TOKENS's own
  // precedent, and matching the direction cli/review.ts's own loose
  // comparison already takes for blank), so this only fires on a value that
  // is actually there and actually wrong. `problems.length > 0 ? invalid :
  // ...` below means the run refuses before anything is spent — the
  // credential lookup above may already have run in whichever direction the
  // caller's own loose comparison chose, but nothing downstream of it costs
  // money until this function returns `ready`, and it will not.
  const rawAllowApiKeyFallback = present(env['AIGENCY_REVIEW_ALLOW_API_KEY_FALLBACK']);
  if (
    rawAllowApiKeyFallback !== undefined &&
    rawAllowApiKeyFallback !== 'true' &&
    rawAllowApiKeyFallback !== 'false'
  ) {
    problems.push(
      `AIGENCY_REVIEW_ALLOW_API_KEY_FALLBACK must be "true" or "false", got ${JSON.stringify(rawAllowApiKeyFallback)}`,
    );
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
