// The environment is passed in, so none of this touches `process.env`, and
// the key file reader is passed in too, so none of this touches a real
// filesystem — no test can leak configuration, or a real credential file on
// the machine running the suite, into another.
//
// What is asserted here is mostly the CONTENT of the answer rather than its
// shape. A configuration failure is read by someone who does not yet know what
// is wrong, so a suite that only checked `kind` would stay green while the log
// said "incomplete" and nothing else — which is the failure this module was
// written to prevent, restated as a test that cannot see it.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LENS_SOURCE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  renderMissing,
  resolveSettings,
  type KeyFileReader,
  type KeyFileResult,
  type MissingSetting,
  type ReviewSettings,
  type SettingsResult,
} from '../src/review/settings.js';

/**
 * A minimally complete environment. Tests that care about one variable
 * override that one, so a test about `AIGENCY_REVIEW_MAX_TOKENS` is not
 * quietly also a test about a missing credential. Overriding with `undefined`
 * removes a variable, which is what an unset one looks like to `process.env`.
 */
function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    AIGENCY_REVIEW_LENSES_TOKEN: 'lens-token',
    ...overrides,
  };
}

/** No file exists anywhere. The default for tests that are not about a file
 * source at all, so they stay tests of one thing. */
const NO_FILES: KeyFileReader = () => Promise.resolve({ kind: 'absent' });

/** A reader backed by a plain map, so a test names the paths it cares about
 * and nothing else, and asserts which paths were actually asked for. */
function filesystem(files: Record<string, KeyFileResult>): {
  readonly read: KeyFileReader;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    read: (path: string) => {
      asked.push(path);
      return Promise.resolve(files[path] ?? { kind: 'absent' });
    },
  };
}

// Each of these throws with the WHOLE result in the message, so a test that
// expected `ready` and got `incomplete` names the missing settings in its
// failure rather than saying `undefined is not an object` three lines later.
function readyOf(result: SettingsResult): ReviewSettings {
  if (result.kind !== 'ready') {
    throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  }
  return result.settings;
}

function missingOf(result: SettingsResult): readonly MissingSetting[] {
  if (result.kind !== 'incomplete') {
    throw new Error(`expected incomplete, got ${JSON.stringify(result)}`);
  }
  return result.missing;
}

// `problems` can ride on either `invalid` or `incomplete` — see the file
// header in settings.ts — so this accepts both rather than pinning one.
function problemsOf(result: SettingsResult): readonly string[] {
  if (result.kind === 'invalid' || result.kind === 'incomplete') {
    return result.problems;
  }
  throw new Error(`expected incomplete or invalid, got ${JSON.stringify(result)}`);
}

function named(missing: readonly MissingSetting[], name: string): MissingSetting {
  const found = missing.find((setting) => setting.name === name);
  if (found === undefined) {
    throw new Error(`no entry for ${name} in ${JSON.stringify(missing.map((s) => s.name))}`);
  }
  return found;
}

describe('resolveSettings, given everything it needs', () => {
  it('returns ready with every field taken from the environment', async () => {
    const settings = readyOf(
      await resolveSettings(
        {
          ANTHROPIC_API_KEY: 'sk-ant-complete',
          AIGENCY_REVIEW_MODEL: 'claude-opus-9',
          AIGENCY_REVIEW_MAX_TOKENS: '8192',
          AIGENCY_REVIEW_LENSES: 'https://lenses.test/set.json',
          AIGENCY_REVIEW_LENSES_TOKEN: 'lens-token',
        },
        NO_FILES,
      ),
    );

    // Compared whole, so a field silently dropped or added fails here.
    expect(settings).toEqual({
      credential: { source: 'api-key', value: 'sk-ant-complete' },
      model: 'claude-opus-9',
      maxTokens: 8192,
      lensSource: 'https://lenses.test/set.json',
      lensToken: 'lens-token',
    });
  });
});

describe('resolveSettings, given no credential at all', () => {
  it('reports it as incomplete, naming the variable and what it is for', async () => {
    const missing = missingOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES),
    );
    const entry = named(missing, 'ANTHROPIC_API_KEY');

    expect(entry.why).toContain('credential');
    // No assertion on the rest of `why`. A length threshold passes for any
    // prose of roughly the right size, including prose that says the wrong
    // thing, and asserting the exact sentence would pin wording rather than
    // behaviour. What is checkable is that the field is populated and that
    // the branch was taken, and the `where` assertions below do that.
  });

  // Both credentials, both audiences. A log that gives only the GitHub route
  // leaves someone reproducing the failure locally with nothing to type, and
  // one that mentions only the API key leaves the whole point of this story —
  // a free local option — undiscoverable from the one place someone actually
  // reads when something is missing.
  it('names the GitHub place, and both local ways to supply an API key', async () => {
    const missing = missingOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES),
    );
    const entry = named(missing, 'ANTHROPIC_API_KEY');

    expect(entry.where).toContain('Secrets and variables');
    expect(entry.where).toContain('export ANTHROPIC_API_KEY=');
    expect(entry.where).toContain('ANTHROPIC_API_KEY_FILE');
    expect(entry.where).toContain('.config/verevoir/anthropic.key');
  });

  it('also names both local ways to supply a subscription OAuth token instead', async () => {
    const missing = missingOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES),
    );
    const entry = named(missing, 'ANTHROPIC_API_KEY');

    expect(entry.where).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(entry.where).toContain('AIGENCY_REVIEW_OAUTH_TOKEN_FILE');
    expect(entry.where).toContain('.config/verevoir/anthropic-oauth.token');
  });

  // This is the real GitHub Actions failure, not a hypothetical one: an unset
  // secret interpolates to '' rather than disappearing, so the empty case is
  // the case that actually reaches production. Asserted as its own test, and
  // then compared against the absent case so the two cannot drift apart.
  it('treats an empty-string API key exactly as an absent one', async () => {
    const result = await resolveSettings(env({ ANTHROPIC_API_KEY: '' }), NO_FILES);

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result)).toEqual(
      missingOf(await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES)),
    );
  });

  it('treats a whitespace-only API key as absent', async () => {
    const result = await resolveSettings(env({ ANTHROPIC_API_KEY: '  \t\n ' }), NO_FILES);

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result)).toEqual(
      missingOf(await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES)),
    );
  });
});

describe('resolveSettings, given an empty environment', () => {
  // The defect this shape exists to avoid: one missing value per CI round,
  // discovered by the person least able to guess what the next one will be.
  // Asserting the length as well as the names is what makes "reports the first
  // and stops" a failure here rather than a passing subset.
  it('reports both missing settings together rather than one at a time', async () => {
    const missing = missingOf(await resolveSettings({}, NO_FILES));

    expect(missing).toHaveLength(2);
    expect(missing.map((setting) => setting.name).sort()).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
      'ANTHROPIC_API_KEY',
    ]);
  });

  it('says where the lens token comes from in Actions and on a laptop', async () => {
    const entry = named(
      missingOf(await resolveSettings({}, NO_FILES)),
      'AIGENCY_REVIEW_LENSES_TOKEN',
    );

    expect(entry.where).toContain('secrets.GITHUB_TOKEN');
    expect(entry.where).toContain('AIGENCY_REVIEW_LENSES');
    expect(entry.why).toContain('private');
  });
});

describe('resolveSettings, resolving the API key from a file', () => {
  it('prefers the environment variable over ANTHROPIC_API_KEY_FILE, even when both are set', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: 'sk-from-file' } });

    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: 'sk-from-env', ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
        fs.read,
      ),
    );

    expect(settings.credential).toEqual({ source: 'api-key', value: 'sk-from-env' });
    // The whole point of the precedence: a file present on disk is never even
    // opened when the environment already answered.
    expect(fs.asked).toEqual([]);
  });

  it('reads ANTHROPIC_API_KEY_FILE when the environment variable is unset', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: 'sk-from-file' } });

    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
        fs.read,
      ),
    );

    expect(settings.credential).toEqual({ source: 'api-key', value: 'sk-from-file' });
  });

  it('prefers ANTHROPIC_API_KEY_FILE over the default path, when both would supply a key', async () => {
    const fs = filesystem({
      '/keys/anthropic': { kind: 'text', text: 'sk-from-explicit-file' },
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const settings = readyOf(
      await resolveSettings(
        env({
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
          HOME: '/home/it',
        }),
        fs.read,
      ),
    );

    expect(settings.credential.value).toBe('sk-from-explicit-file');
  });

  it('falls back to the default path when neither the environment nor ANTHROPIC_API_KEY_FILE supply a key', async () => {
    const fs = filesystem({
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }), fs.read),
    );

    expect(settings.credential.value).toBe('sk-from-default-path');
  });

  it('reads the default path under XDG_CONFIG_HOME, when it is set', async () => {
    const fs = filesystem({
      '/xdg/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-xdg' },
    });

    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: undefined, XDG_CONFIG_HOME: '/xdg', HOME: '/home/it' }),
        fs.read,
      ),
    );

    expect(settings.credential.value).toBe('sk-from-xdg');
  });

  // A missing default path is not an error — it is simply that source
  // contributing nothing, same as any other absent file. This is the case
  // that actually matters most: most environments have not set any of this
  // up, and the review must still resolve to a clear "incomplete" rather than
  // a thrown exception.
  it('resolves to incomplete, not an error, when the default path does not exist', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }),
      NO_FILES,
    );

    expect(result.kind).toBe('incomplete');
    expect(named(missingOf(result), 'ANTHROPIC_API_KEY')).toBeDefined();
  });

  // A file that exists and cannot be read is a different problem from a file
  // that was never created, and must be reported differently: `invalid`
  // rather than `incomplete`, because it is present and broken rather than
  // absent.
  it('reports a file that cannot be read differently from one that is absent', async () => {
    const unreadable = filesystem({
      '/keys/anthropic': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      unreadable.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
    expect(problems.some((problem) => problem.includes('EACCES'))).toBe(true);

    // Compared against the genuinely-absent case, so the two cannot collapse
    // into the same outcome by accident.
    const absent = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      NO_FILES,
    );
    expect(absent.kind).toBe('incomplete');
  });

  // The asymmetry the panel's third review found: resolveChain already
  // computed a blank-env-var signal for the API-key chain too, exactly as
  // it does for OAuth's, but nothing read it — a blank ANTHROPIC_API_KEY
  // alongside this chain's own unreadable file dropped the blank signal
  // entirely, reporting only the broken file. Mirrors 'names a blank OAuth
  // env var alongside an unreadable API key file' below, chains reversed:
  // here it is the SAME chain that is both blank-then-unreadable.
  it('names a blank API-key env var alongside its own unreadable file, rather than dropping the signal', async () => {
    const unreadable = filesystem({
      '/keys/anthropic': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: '   ', ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      unreadable.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
    expect(problems.some((problem) => problem.includes('EACCES'))).toBe(true);
    expect(
      problems.some(
        (problem) => problem.includes('ANTHROPIC_API_KEY') && problem.includes('blank'),
      ),
    ).toBe(true);
  });

  // There WAS a test here asserting the joined problems string did not
  // contain 'sk-', driven by a mock whose `reason` was the hardcoded string
  // 'EACCES: permission denied'. That string can never contain 'sk-'
  // regardless of what resolveSettings does with it, so the assertion could
  // not fail — it held vacuously, and would not have caught an actual
  // key-leaking implementation. That is the same shape of defect this very
  // change fixed elsewhere, caught here by the panel's first real review.
  //
  // The honest state of the property "a credential's value never reaches a
  // problem" is that it CANNOT be violated at this layer, and that is worth
  // stating rather than faking a test for. On the unreadable-file path,
  // `resolveSettings` never has a credential value in scope to leak:
  // `credential` is assigned only in the `found` branch (see
  // `resolveSettings` above), and `KeyFileResult`'s `unreadable` variant
  // carries only `reason` — there is no `text` field for a reader to have put
  // a value into even by mistake. The type system is what enforces this, not
  // a runtime check, so no test belongs here. What CAN leak a credential is a
  // reader or a provider client that reads it successfully and then fails to
  // redact it before it reaches an error or a log — a different bug, in a
  // different place, and it is covered where it is real:
  // `redact()`/`headersFor()` in tests/anthropic.test.ts, tested against
  // values that actually are the credential, for both credential kinds.

  it('treats empty file contents as blank, falling through to the next source', async () => {
    const fs = filesystem({
      '/keys/anthropic': { kind: 'text', text: '' },
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const settings = readyOf(
      await resolveSettings(
        env({
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
          HOME: '/home/it',
        }),
        fs.read,
      ),
    );

    expect(settings.credential.value).toBe('sk-from-default-path');
  });

  it('treats whitespace-only file contents as blank, falling through to the next source', async () => {
    const fs = filesystem({
      '/keys/anthropic': { kind: 'text', text: '  \n\t  \n' },
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const settings = readyOf(
      await resolveSettings(
        env({
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
          HOME: '/home/it',
        }),
        fs.read,
      ),
    );

    expect(settings.credential.value).toBe('sk-from-default-path');
  });

  // The gap the panel found: falling through past a blank file must not
  // erase that it WAS blank, if nothing further on ever supplies a
  // credential.
  it('names the blank explicit key file as a problem when nothing else supplies a credential either', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: '   \n' } });

    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      fs.read,
    );

    expect(result.kind).toBe('incomplete');
    expect(named(missingOf(result), 'ANTHROPIC_API_KEY')).toBeDefined();
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
    expect(problems.some((problem) => problem.includes('blank'))).toBe(true);
  });

  // The same gap, at the default path rather than the explicit one —
  // resolveChain threads blankPaths through both branches, and this proves
  // the second one independently rather than assuming symmetry.
  it('names the blank default key file as a problem too, when no explicit path was even set', async () => {
    const fs = filesystem({
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: '' },
    });

    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }),
      fs.read,
    );

    expect(result.kind).toBe('incomplete');
    const problems = problemsOf(result);
    expect(
      problems.some((problem) => problem.includes('/home/it/.config/verevoir/anthropic.key')),
    ).toBe(true);
    expect(problems.some((problem) => problem.includes('blank'))).toBe(true);
  });

  // The boundary this fix deliberately does not cross: when the default path
  // DOES supply a credential despite the explicit one being blank, the result
  // is `ready`, which carries no `problems` field at all — so the blank-file
  // information is not, and cannot be, surfaced here. readyOf() itself is the
  // assertion: it throws if the outcome is anything other than a clean ready
  // result with exactly the shape SettingsResult's `ready` variant has.
  it('stays a clean ready result, with no trace of the blank file, when the fallback succeeds', async () => {
    const fs = filesystem({
      '/keys/anthropic': { kind: 'text', text: '' },
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const settings = readyOf(
      await resolveSettings(
        env({
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
          HOME: '/home/it',
        }),
        fs.read,
      ),
    );

    expect(settings.credential.value).toBe('sk-from-default-path');
  });

  // The asymmetry that matters most in this feature: a file is trimmed, the
  // environment is not. Both asserted here, together, so a future edit that
  // "fixes" one to match the other fails immediately rather than passing a
  // suite that only ever checked one direction.
  it('trims a trailing newline from an API key read from a file', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: 'sk-from-file\n' } });

    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
        fs.read,
      ),
    );

    expect(settings.credential.value).toBe('sk-from-file');
  });

  it('does not trim whitespace from an API key read from the environment', async () => {
    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: 'sk-from-env\n' }), NO_FILES),
    );

    // Not "absent" and not "trimmed" — the value the environment handed over,
    // byte for byte, because whitespace arriving through an env var is a
    // broken pipeline that should fail loudly against the provider rather
    // than be quietly repaired here.
    expect(settings.credential.value).toBe('sk-from-env\n');
  });
});

describe('resolveSettings, resolving the subscription OAuth token', () => {
  const OAUTH_TOKEN = 'oauth-THE-SUBSCRIPTION-SECRET-VALUE-DO-NOT-LOG';

  it('resolves from the environment variable to a subscription-oauth credential', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }),
        NO_FILES,
      ),
    );

    expect(settings.credential).toEqual({ source: 'subscription-oauth', value: OAUTH_TOKEN });
  });

  // The deterministic case this story exists to pin down. Both credentials
  // are genuinely present and would each independently resolve to `ready` —
  // and the answer must not depend on which happened to be checked first by
  // accident. OAuth wins, unconditionally, because nothing in this
  // repository's CI configuration can ever set the OAuth variable (see the
  // file header), so giving it priority never changes what CI does, and it
  // is what makes a stray ANTHROPIC_API_KEY left over from some other tool
  // unable to silently defeat the whole point of this feature.
  it('prefers the OAuth token over the API key when both are genuinely present', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: 'sk-ant-also-present', CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }),
        NO_FILES,
      ),
    );

    expect(settings.credential).toEqual({ source: 'subscription-oauth', value: OAUTH_TOKEN });
  });

  it('reads AIGENCY_REVIEW_OAUTH_TOKEN_FILE when the environment variable is unset', async () => {
    const fs = filesystem({ '/oauth/token': { kind: 'text', text: OAUTH_TOKEN } });

    const settings = readyOf(
      await resolveSettings(
        env({
          ANTHROPIC_API_KEY: undefined,
          AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/token',
        }),
        fs.read,
      ),
    );

    expect(settings.credential).toEqual({ source: 'subscription-oauth', value: OAUTH_TOKEN });
  });

  it('falls back to the default OAuth path when neither the env var nor the explicit file supply one', async () => {
    const fs = filesystem({
      '/home/it/.config/verevoir/anthropic-oauth.token': { kind: 'text', text: OAUTH_TOKEN },
    });

    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }), fs.read),
    );

    expect(settings.credential).toEqual({ source: 'subscription-oauth', value: OAUTH_TOKEN });
  });

  it('reads the default OAuth path under XDG_CONFIG_HOME, when it is set', async () => {
    const fs = filesystem({
      '/xdg/verevoir/anthropic-oauth.token': { kind: 'text', text: OAUTH_TOKEN },
    });

    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: undefined, XDG_CONFIG_HOME: '/xdg', HOME: '/home/it' }),
        fs.read,
      ),
    );

    expect(settings.credential).toEqual({ source: 'subscription-oauth', value: OAUTH_TOKEN });
  });

  // A blank OAuth env var must not stop at "absent" and stall — it must fall
  // through to the API key chain exactly as a blank API key source falls
  // through to its own next source. This is the ordinary blank-is-absent
  // behaviour, extended across the credential boundary rather than stopping
  // at it.
  it('falls through to the API key when the OAuth variable is blank', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: 'sk-from-env', CLAUDE_CODE_OAUTH_TOKEN: '   ' }),
        NO_FILES,
      ),
    );

    expect(settings.credential).toEqual({ source: 'api-key', value: 'sk-from-env' });
  });

  it('falls through to the API key when the OAuth file is blank', async () => {
    const fs = filesystem({ '/oauth/token': { kind: 'text', text: '\n\t \n' } });

    const settings = readyOf(
      await resolveSettings(
        env({
          ANTHROPIC_API_KEY: 'sk-from-env',
          AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/token',
        }),
        fs.read,
      ),
    );

    expect(settings.credential).toEqual({ source: 'api-key', value: 'sk-from-env' });
  });

  it('names the blank OAuth path as a problem when nothing else supplies a credential either', async () => {
    const fs = filesystem({ '/oauth/token': { kind: 'text', text: '  \n' } });

    const result = await resolveSettings(
      env({
        ANTHROPIC_API_KEY: undefined,
        AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/token',
      }),
      fs.read,
    );

    expect(result.kind).toBe('incomplete');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/oauth/token'))).toBe(true);
    expect(problems.some((problem) => problem.includes('blank'))).toBe(true);
  });

  // The hard-stop case, and the one most worth getting right: a genuinely
  // broken (present, unreadable) OAuth source must not be silently skipped in
  // favour of a working API key. Falling through here would spend real money
  // on a run whose whole configuration exists to avoid spending it, and would
  // never tell anyone why — exactly the accident the file header argues
  // against. `unreadable` for OAuth is a hard stop for the WHOLE resolution,
  // same as `unreadable` already was for the API key chain alone.
  it('reports an unreadable OAuth file as invalid, and does NOT fall through to a working API key', async () => {
    const unreadable = filesystem({
      '/oauth/token': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      env({
        ANTHROPIC_API_KEY: 'sk-would-otherwise-have-worked',
        AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/token',
      }),
      unreadable.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/oauth/token'))).toBe(true);
    expect(problems.some((problem) => problem.includes('EACCES'))).toBe(true);
    // The API key was never even looked at: this is not merely "resolution
    // ended up invalid", it is "resolution stopped at OAuth and never tried
    // the fallback that would have worked".
  });

  // The gap the panel's second review found: an OAuth attempt signal (here,
  // a blank env var) must not vanish just because the API-key chain that
  // was tried next also hit a real problem of its own. Before this fix,
  // resolveCredential's apiKey-unreadable branch hardcoded oauthAttempted:
  // [], so this scenario reported only the broken key file and never
  // mentioned that CLAUDE_CODE_OAUTH_TOKEN had also been set-but-blank —
  // two independently real failures collapsing into one reported cause.
  it('names a blank OAuth env var alongside an unreadable API key file, rather than dropping the OAuth signal', async () => {
    const unreadable = filesystem({
      '/keys/anthropic': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      env({
        CLAUDE_CODE_OAUTH_TOKEN: '   ',
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
      }),
      unreadable.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
    expect(problems.some((problem) => problem.includes('EACCES'))).toBe(true);
    // The signal this fix restores.
    expect(
      problems.some(
        (problem) => problem.includes('CLAUDE_CODE_OAUTH_TOKEN') && problem.includes('blank'),
      ),
    ).toBe(true);
  });

  // The mirror of the test above, chains reversed: here OAuth's OWN file is
  // what turns out unreadable, coinciding with OAuth's own blank env var —
  // the gap the panel's fourth review found. Before this fix, the
  // oauth.resolution.kind === 'unreadable' branch in resolveCredential
  // hardcoded oauthAttempted: [], discarding oauth.blankEnvVar even though
  // the sibling apiKey-unreadable branch above already preserved this exact
  // signal for OAuth via attemptSignals.
  it('names a blank OAuth env var alongside its own unreadable file, rather than dropping the signal', async () => {
    const unreadable = filesystem({
      '/oauth/token': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      env({
        CLAUDE_CODE_OAUTH_TOKEN: '   ',
        AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/token',
      }),
      unreadable.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/oauth/token'))).toBe(true);
    expect(problems.some((problem) => problem.includes('EACCES'))).toBe(true);
    expect(
      problems.some(
        (problem) => problem.includes('CLAUDE_CODE_OAUTH_TOKEN') && problem.includes('blank'),
      ),
    ).toBe(true);
  });

  // `attemptSignals` reports two DIFFERENT signals — a blank env var, and a
  // missing explicit *_FILE path — and every test above that pairs a genuine
  // attempt with a second real problem uses only the first one. This is that
  // same pairing for the second: an explicit `AIGENCY_REVIEW_OAUTH_TOKEN_FILE`
  // naming a path that is not there, falling through to a default path that
  // IS there and unreadable. Read alongside the test above rather than review
  // findings this time — found by re-reading this file's own coverage rather
  // than by the panel, on the same reasoning: a signal proven in isolation is
  // not proven in combination with the failure that would most plausibly
  // swallow it.
  it('names a missing explicit OAuth file path alongside its own unreadable default-path file, rather than dropping either signal', async () => {
    const unreadable = filesystem({
      '/xdg/verevoir/anthropic-oauth.token': {
        kind: 'unreadable',
        reason: 'EACCES: permission denied',
      },
    });

    const result = await resolveSettings(
      env({
        AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/missing',
        XDG_CONFIG_HOME: '/xdg',
        HOME: '/home/it',
      }),
      unreadable.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(
      problems.some((problem) => problem.includes('/xdg/verevoir/anthropic-oauth.token')),
    ).toBe(true);
    expect(problems.some((problem) => problem.includes('EACCES'))).toBe(true);
    expect(
      problems.some(
        (problem) =>
          problem.includes('AIGENCY_REVIEW_OAUTH_TOKEN_FILE') &&
          problem.includes('/oauth/missing') &&
          problem.includes('no file exists there'),
      ),
    ).toBe(true);
  });

  it('reads AIGENCY_REVIEW_OAUTH_TOKEN_FILE without ever asking for it when the env var already answered', async () => {
    const fs = filesystem({ '/oauth/token': { kind: 'text', text: OAUTH_TOKEN } });

    await resolveSettings(
      env({
        ANTHROPIC_API_KEY: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
        AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/token',
      }),
      fs.read,
    );

    expect(fs.asked).toEqual([]);
  });

  // A test used to sit here — 'never puts a genuinely-resolved OAuth token
  // in a rendered report' — asserting `not.toContain(OAUTH_TOKEN)` on a
  // report built from a SUCCESSFULLY resolved OAuth credential. The panel's
  // fourth review found it vacuous for a narrower reason than the version it
  // replaced: on the `found` branch, `resolveSettings` never writes
  // `credential.value` into `missing` or `problems` — the only two fields
  // `renderMissing` ever reads — so the assertion held regardless of what
  // OAUTH_TOKEN actually was, by construction of the code, not by verifying
  // any behaviour. Deleted rather than patched, because no path was found,
  // on trying, where a genuinely-resolved credential's VALUE could reach
  // `missing` or `problems` at all: every string either module writes there
  // is a fixed explanatory sentence, an environment-variable NAME (see
  // `attemptSignals`), or a file PATH (see `blankPaths`) — never a
  // credential's own bytes. That is a property of the types this module
  // returns (`ReviewSettings.credential` is the only field carrying a
  // value, and it exists only on the `ready` result, which produces no
  // rendered report at all — `renderMissing` is never called with one), not
  // something a test at this layer can meaningfully exercise by asserting a
  // string's absence. The real leak surface is one level down, at the point
  // a credential's value is actually SENT and could actually appear in a
  // thrown error or a response body — see tests/anthropic.test.ts's leak
  // tests, which embed the real secret in a thrown error and a response
  // body before asserting `redact()` removed it. That is where a leak could
  // really happen, and where a test can really catch one.
});

describe('resolveSettings, when OAuth was attempted but came up empty, and fallback is allowed', () => {
  // The gap the panel's review found in this file's first version: a blank
  // CLAUDE_CODE_OAUTH_TOKEN or a missing explicit AIGENCY_REVIEW_OAUTH_TOKEN_FILE
  // path is a genuine attempt — see the file header's own stated principle —
  // and that principle was honoured on the `!allowApiKeyFallback` refusal
  // path but silently lost here, on the ordinary path CI and every default
  // caller actually take, whenever the API key chain was tried next and also
  // came up empty. These two tests are the ones missing before this fix; the
  // blank-OAuth-FILE case immediately above was already covered.
  it('names a blank OAuth env var as a problem, even though the API key chain was tried next and also failed', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: '   ' }),
      NO_FILES,
    );

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual(['ANTHROPIC_API_KEY']);
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(true);
    expect(problems.some((problem) => problem.includes('blank'))).toBe(true);
  });

  it('names a missing explicit OAuth file path as a problem, even though the API key chain was tried next and also failed', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/missing' }),
      NO_FILES,
    );

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual(['ANTHROPIC_API_KEY']);
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('AIGENCY_REVIEW_OAUTH_TOKEN_FILE'))).toBe(
      true,
    );
    expect(problems.some((problem) => problem.includes('/oauth/missing'))).toBe(true);
  });
});

describe('resolveSettings, when the API key was attempted but came up empty', () => {
  // The mirror of the OAuth block above, and the asymmetry the panel's
  // third review found: resolveChain computes these same two signals for
  // the API-key chain too, but nothing read them until now — a blank
  // ANTHROPIC_API_KEY, or a missing explicit ANTHROPIC_API_KEY_FILE path,
  // collapsed indistinguishably into "ANTHROPIC_API_KEY is not configured",
  // the exact distinction this file already established for OAuth.
  it('names a blank API-key env var as a problem, even though nothing else supplies a credential either', async () => {
    const result = await resolveSettings(env({ ANTHROPIC_API_KEY: '   ' }), NO_FILES);

    expect(result.kind).toBe('incomplete');
    expect(named(missingOf(result), 'ANTHROPIC_API_KEY')).toBeDefined();
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('ANTHROPIC_API_KEY'))).toBe(true);
    expect(problems.some((problem) => problem.includes('blank'))).toBe(true);
  });

  it('names a missing explicit API-key file path as a problem, even though nothing else supplies a credential either', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/missing' }),
      NO_FILES,
    );

    expect(result.kind).toBe('incomplete');
    expect(named(missingOf(result), 'ANTHROPIC_API_KEY')).toBeDefined();
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('ANTHROPIC_API_KEY_FILE'))).toBe(true);
    expect(problems.some((problem) => problem.includes('/keys/missing'))).toBe(true);
  });
});

describe('resolveSettings, when a local run must not fall back to the API key', () => {
  const OAUTH_TOKEN = 'oauth-THE-SUBSCRIPTION-SECRET-VALUE-DO-NOT-LOG';

  it('still resolves to the OAuth credential when OAuth is genuinely present', async () => {
    const settings = readyOf(
      await resolveSettings(env({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }), NO_FILES, false),
    );

    expect(settings.credential).toEqual({ source: 'subscription-oauth', value: OAUTH_TOKEN });
  });

  // Never configured at all: refuses, names CLAUDE_CODE_OAUTH_TOKEN rather
  // than ANTHROPIC_API_KEY, and — because nothing was actually attempted —
  // carries no spurious problems.
  it('refuses when OAuth was never configured, naming CLAUDE_CODE_OAUTH_TOKEN rather than ANTHROPIC_API_KEY', async () => {
    const result = await resolveSettings(env(), NO_FILES, false);

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    expect(problemsOf(result)).toEqual([]);
  });

  // The gap this story exists to close: a blank env var must not read the
  // same as "never mentioned" once refusing is the alternative to spending
  // money.
  it('refuses when the OAuth env var is set but blank, and names the attempt', async () => {
    const result = await resolveSettings(env({ CLAUDE_CODE_OAUTH_TOKEN: '   ' }), NO_FILES, false);

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    const problems = problemsOf(result);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(problems[0]).toContain('blank');
  });

  // The second half of the same gap: an explicit *_FILE path naming a file
  // that is not there is a real, distinguishable attempt, not silence.
  it('refuses when AIGENCY_REVIEW_OAUTH_TOKEN_FILE names a path that does not exist, and names the attempt', async () => {
    const result = await resolveSettings(
      env({ AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/missing' }),
      NO_FILES,
      false,
    );

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    const problems = problemsOf(result);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('AIGENCY_REVIEW_OAUTH_TOKEN_FILE');
    expect(problems[0]).toContain('/oauth/missing');
  });

  // The API key chain is never even tried when refusing — proven by handing a
  // key that would otherwise have worked and asserting the file backing it
  // was never asked for.
  it('never asks for the API key at all when refusing to fall back', async () => {
    const fs = filesystem({});

    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      fs.read,
      false,
    );

    expect(result.kind).toBe('incomplete');
    expect(fs.asked).toEqual([]);
  });

  // A genuinely broken (present, unreadable) OAuth source stays a hard stop
  // regardless of this parameter — unaffected by whether fallback would
  // otherwise have been allowed.
  it('still reports an unreadable OAuth file as invalid, unaffected by this parameter', async () => {
    const unreadable = filesystem({
      '/oauth/token': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      env({ AIGENCY_REVIEW_OAUTH_TOKEN_FILE: '/oauth/token' }),
      unreadable.read,
      false,
    );

    expect(result.kind).toBe('invalid');
    expect(problemsOf(result).some((problem) => problem.includes('EACCES'))).toBe(true);
  });

  // Passing true explicitly proves the parameter itself toggles behaviour,
  // not merely that omitting it preserves the default — the two are different
  // claims and only one is proven by every other test in this file, which
  // never passes a third argument at all.
  it('falls back to a working API key when explicitly allowed, even with the same blank OAuth env var', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: 'sk-from-env', CLAUDE_CODE_OAUTH_TOKEN: '   ' }),
        NO_FILES,
        true,
      ),
    );

    expect(settings.credential).toEqual({ source: 'api-key', value: 'sk-from-env' });
  });

  // The shape CI is actually in: no OAuth variable ever mentioned, fallback
  // allowed (CI's implicit default, since review.yml never passes a third
  // argument at all) — the API key still resolves exactly as it always has.
  it('resolves the API key normally when OAuth was never mentioned and fallback is allowed — the shape CI is in', async () => {
    const settings = readyOf(await resolveSettings(env(), NO_FILES));

    expect(settings.credential).toEqual({ source: 'api-key', value: 'sk-ant-test' });
  });
});

describe('resolveSettings, when a problem and a missing setting are both true', () => {
  // The exact shape the panel's first real review caught: an unreadable key
  // file (a problem) coinciding with an unset lens token (a missing
  // setting). Before this fix, `missing.length > 0` alone decided `kind`
  // and the broken-file problem vanished from the result entirely — a
  // person would see only "you haven't set AIGENCY_REVIEW_LENSES_TOKEN",
  // with no trace that the key file they DID set could not be opened.
  it('keeps the problem even though something is also missing — nothing is dropped', async () => {
    const unreadable = filesystem({
      '/keys/anthropic': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        AIGENCY_REVIEW_LENSES_TOKEN: undefined,
      },
      unreadable.read,
    );

    // `kind` stays 'incomplete': the lens token is genuinely absent, and
    // absence remains the primary message.
    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
    ]);

    // But the broken key file is not thereby lost.
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
    expect(problems.some((problem) => problem.includes('EACCES'))).toBe(true);
  });

  it('renders both in the message a person actually reads', async () => {
    const unreadable = filesystem({
      '/keys/anthropic': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });

    const result = await resolveSettings(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        AIGENCY_REVIEW_LENSES_TOKEN: undefined,
      },
      unreadable.read,
    );

    const missing = missingOf(result);
    const problems = problemsOf(result);
    const rendered = renderMissing(missing, problems);

    expect(rendered).toContain('AIGENCY_REVIEW_LENSES_TOKEN');
    expect(rendered).toContain('/keys/anthropic');
    expect(rendered).toContain('EACCES');
  });
});

describe('resolveSettings, resolving the lens token', () => {
  it('accepts GITHUB_TOKEN when no dedicated token is set', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ AIGENCY_REVIEW_LENSES_TOKEN: undefined, GITHUB_TOKEN: 'gh-actions-token' }),
        NO_FILES,
      ),
    );

    expect(settings.lensToken).toBe('gh-actions-token');
  });

  // The dedicated variable exists precisely so a token with wider access can
  // override the one Actions injects. If GITHUB_TOKEN won, setting it would do
  // nothing and nothing would say so.
  it('prefers AIGENCY_REVIEW_LENSES_TOKEN over GITHUB_TOKEN when both are set', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ AIGENCY_REVIEW_LENSES_TOKEN: 'dedicated', GITHUB_TOKEN: 'gh-actions-token' }),
        NO_FILES,
      ),
    );

    expect(settings.lensToken).toBe('dedicated');
  });

  it('treats an empty GITHUB_TOKEN as no token at all', async () => {
    const result = await resolveSettings(
      env({ AIGENCY_REVIEW_LENSES_TOKEN: undefined, GITHUB_TOKEN: '' }),
      NO_FILES,
    );

    expect(missingOf(result).map((setting) => setting.name)).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
    ]);
  });

  // The laptop run. Demanding a token to read a file off disk would make
  // reviewing against a checked-out copy impossible for no reason.
  it('needs no token when the lens source is a file path', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({
          AIGENCY_REVIEW_LENSES: './review/lenses.json',
          AIGENCY_REVIEW_LENSES_TOKEN: undefined,
        }),
        NO_FILES,
      ),
    );

    expect(settings.lensSource).toBe('./review/lenses.json');
    // Absent, not present-and-undefined: a bearer header built from `undefined`
    // would be sent as the string "Bearer undefined".
    expect('lensToken' in settings).toBe(false);
  });
});

describe('resolveSettings, falling back to defaults', () => {
  it('uses the exported defaults for model, maxTokens and lens source', async () => {
    const settings = readyOf(await resolveSettings(env(), NO_FILES));

    expect(settings.model).toBe(DEFAULT_MODEL);
    expect(settings.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(settings.lensSource).toBe(DEFAULT_LENS_SOURCE);
  });

  // A change-detector, deliberately, and the only one in this file. The three
  // constants must not move without someone deciding to move them — a judge
  // that changes because a default drifted is a bar that moved with nobody
  // choosing it. Every other assertion about defaults compares against these
  // same constants, so those hold whatever the constants say; this is the one
  // that would notice. It tests a decision, not a behaviour, and that is why
  // it exists rather than an oversight.
  it('pins the defaults to specific values, not merely to itself', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
    expect(DEFAULT_MAX_TOKENS).toBe(65536);
    expect(DEFAULT_LENS_SOURCE).toBe(
      'https://raw.githubusercontent.com/verevoir/aigency-governance/main/review/lenses.json',
    );
  });

  it('takes an override for the model', async () => {
    const settings = readyOf(
      await resolveSettings(env({ AIGENCY_REVIEW_MODEL: 'claude-haiku-3' }), NO_FILES),
    );

    expect(settings.model).toBe('claude-haiku-3');
  });

  it('takes an override for maxTokens, as a number', async () => {
    const settings = readyOf(
      await resolveSettings(env({ AIGENCY_REVIEW_MAX_TOKENS: '12000' }), NO_FILES),
    );

    expect(settings.maxTokens).toBe(12000);
  });

  it('takes an override for the lens source', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ AIGENCY_REVIEW_LENSES: 'https://lenses.test/other.json' }),
        NO_FILES,
      ),
    );

    expect(settings.lensSource).toBe('https://lenses.test/other.json');
  });
});

describe('resolveSettings, given a maxTokens it cannot use', () => {
  // Each of these is a value someone deliberately typed. Falling back to the
  // default would run the review against a configuration its own environment
  // contradicts, and report nothing.
  for (const raw of ['abc', '0', '-1', '1.5', '1e400']) {
    it(`refuses ${raw} rather than quietly defaulting`, async () => {
      const result = await resolveSettings(env({ AIGENCY_REVIEW_MAX_TOKENS: raw }), NO_FILES);

      // `invalid` carries no settings at all, so this is also the assertion
      // that DEFAULT_MAX_TOKENS was not substituted behind the caller's back.
      expect(result.kind).toBe('invalid');
      const problems = problemsOf(result);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('AIGENCY_REVIEW_MAX_TOKENS');
      expect(problems[0]).toContain(raw);
    });
  }

  // Every accepted value here is distinct from DEFAULT_MAX_TOKENS, so a
  // parse branch that had been deleted in favour of the default would fail
  // each of them rather than passing one by coincidence.
  for (const raw of ['1', '8192', '200000']) {
    it(`accepts ${raw}`, async () => {
      expect(
        readyOf(await resolveSettings(env({ AIGENCY_REVIEW_MAX_TOKENS: raw }), NO_FILES)).maxTokens,
      ).toBe(Number(raw));
    });
  }

  // Someone who has set nothing needs the list of what to set as the
  // PRIMARY message — that is what decides `kind` here. But the value they
  // did type, and typed wrong, is not thereby lost: it rides along in
  // `problems` regardless of which `kind` won, because dropping it there is
  // exactly the shape of the bug the panel's first review caught in the
  // key-file case (see the `carries both` describe block below).
  it('reports what is missing first, but keeps what is also invalid, when both are true', async () => {
    const result = await resolveSettings({ AIGENCY_REVIEW_MAX_TOKENS: 'abc' }, NO_FILES);

    expect(result.kind).toBe('incomplete');
    expect(
      missingOf(result)
        .map((setting) => setting.name)
        .sort(),
    ).toEqual(['AIGENCY_REVIEW_LENSES_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(
      problemsOf(result).some((problem) => problem.includes('AIGENCY_REVIEW_MAX_TOKENS')),
    ).toBe(true);
  });
});

describe('renderMissing', () => {
  it('names every missing setting, with what it is for and where it goes', async () => {
    const result = await resolveSettings({}, NO_FILES);
    const rendered = renderMissing(missingOf(result), problemsOf(result));

    for (const setting of missingOf(result)) {
      expect(rendered).toContain(setting.name);
      expect(rendered).toContain(setting.why);
      expect(rendered).toContain(setting.where);
    }
  });

  it('says how many settings are unconfigured', async () => {
    const result = await resolveSettings({}, NO_FILES);

    expect(renderMissing(missingOf(result), problemsOf(result))).toContain('2 setting(s)');
  });

  // A run that reviewed nothing is not a run that found nothing wrong. Without
  // this line the log reads like a clean result to anyone skimming it.
  it('says the result is red and that nothing was reviewed', async () => {
    const result = await resolveSettings({}, NO_FILES);

    const rendered = renderMissing(missingOf(result), problemsOf(result));
    expect(rendered).toContain('red result, not a passing one');
    expect(rendered).toContain('Nothing was reviewed');
  });

  it('says nothing about problems when there are none', async () => {
    const result = await resolveSettings({}, NO_FILES);

    // The empty case matters as its own assertion: a rendering that always
    // printed the 'Also present and wrong' heading, empty or not, would pass
    // every test above while cluttering the common case — nothing missing
    // AND nothing broken — with a heading over nothing.
    expect(renderMissing(missingOf(result), problemsOf(result))).not.toContain(
      'Also present and wrong',
    );
  });

  // The rendering half of the fix: a problem that survives resolution must
  // actually reach the text a person reads, under a heading of its own so it
  // is not mistaken for one of the missing settings above it.
  it('names a problem found alongside a missing setting, under its own heading', async () => {
    const unreadable = filesystem({
      '/keys/anthropic': { kind: 'unreadable', reason: 'EACCES: permission denied' },
    });
    const result = await resolveSettings(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        AIGENCY_REVIEW_LENSES_TOKEN: undefined,
      },
      unreadable.read,
    );

    const rendered = renderMissing(missingOf(result), problemsOf(result));

    expect(rendered).toContain('Also present and wrong');
    expect(rendered).toContain('/keys/anthropic');
    expect(rendered).toContain('EACCES');
  });
});
