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

/** A setting the run needs and does not have. */
export interface MissingSetting {
  /** The environment variable. */
  readonly name: string;
  /** What it is for, in one line. */
  readonly why: string;
  /** Where to put it — concrete enough to act on without leaving the log. */
  readonly where: string;
}

export interface ReviewSettings {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly lensSource: string;
  /** Sent as a bearer token when the lens set is fetched over HTTP. */
  readonly lensToken?: string;
}

export type SettingsResult =
  | { readonly kind: 'ready'; readonly settings: ReviewSettings }
  | { readonly kind: 'incomplete'; readonly missing: readonly MissingSetting[] }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] };

/**
 * Pinned, not discovered. The same commit judged by two different models is
 * two different verdicts, and a judge that changes because someone's shell
 * differs is a bar that moved without anyone deciding to move it.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TOKENS = 4096;

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

/**
 * Read the settings out of an environment.
 *
 * Three outcomes, kept apart because they are three different jobs: `ready`,
 * `incomplete` (something is absent — a person must supply it) and `invalid`
 * (something is present and wrong — a person must correct it). Collapsing the
 * last two would tell someone who typed `4o96` that they had forgotten to set
 * a value they can see in front of them.
 */
export function resolveSettings(env: Record<string, string | undefined>): SettingsResult {
  const missing: MissingSetting[] = [];
  const problems: string[] = [];

  const apiKey = present(env['ANTHROPIC_API_KEY']);
  if (apiKey === undefined) {
    missing.push({
      name: 'ANTHROPIC_API_KEY',
      why: 'the review calls a model once per lens, and cannot run without a key',
      where:
        'GitHub: Settings → Secrets and variables → Actions → New repository secret, ' +
        'named ANTHROPIC_API_KEY. Locally: export ANTHROPIC_API_KEY=sk-...',
    });
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

  // Absence is reported before invalidity, because someone who has set nothing
  // needs the list of what to set, and a complaint about a value they never
  // supplied would be noise.
  if (missing.length > 0) {
    return { kind: 'incomplete', missing };
  }
  if (problems.length > 0) {
    return { kind: 'invalid', problems };
  }
  return {
    kind: 'ready',
    settings: {
      apiKey: apiKey as string,
      model,
      maxTokens,
      lensSource,
      ...(lensToken !== undefined ? { lensToken } : {}),
    },
  };
}

/** The missing settings, rendered for someone reading a CI log. */
export function renderMissing(missing: readonly MissingSetting[]): string {
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
  lines.push('This is a red result, not a passing one. Nothing was reviewed.');
  return lines.join('\n');
}
