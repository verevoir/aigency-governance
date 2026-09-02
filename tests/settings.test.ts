// The environment is passed in, so none of this touches `process.env`, and
// the key file reader is passed in too, so none of this touches a real
// filesystem — no test can leak configuration, or a real key file on the
// machine running the suite, into another.
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
 * quietly also a test about a missing key. Overriding with `undefined` removes
 * a variable, which is what an unset one looks like to `process.env`.
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

/** No file exists anywhere. The default for tests that are not about the
 * file source at all, so they stay tests of one thing. */
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
      apiKey: 'sk-ant-complete',
      model: 'claude-opus-9',
      maxTokens: 8192,
      lensSource: 'https://lenses.test/set.json',
      lensToken: 'lens-token',
    });
  });
});

describe('resolveSettings, given no API key', () => {
  it('reports it as incomplete, naming the variable and what it is for', async () => {
    const missing = missingOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES),
    );
    const entry = named(missing, 'ANTHROPIC_API_KEY');

    expect(entry.why).toContain('key');
    // No assertion on `why`. A length threshold passes for any prose of
    // roughly the right size, including prose that says the wrong thing, and
    // asserting the exact sentence would pin wording rather than behaviour.
    // What is checkable is that the field is populated and that the branch was
    // taken, and the `where` assertions below do that.
  });

  // Two audiences, two answers. A log that gives only the GitHub route leaves
  // someone reproducing the failure locally with nothing to type, and one that
  // gives only the export leaves the CI failure unfixed.
  it('names the GitHub place and both local places to put it', async () => {
    const missing = missingOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES),
    );
    const entry = named(missing, 'ANTHROPIC_API_KEY');

    expect(entry.where).toContain('Secrets and variables');
    expect(entry.where).toContain('export ANTHROPIC_API_KEY=');
    // The two file sources, so a reader who cannot set a repository secret,
    // or is not the one exporting the CI variable, still has a way to fix it.
    expect(entry.where).toContain('ANTHROPIC_API_KEY_FILE');
    expect(entry.where).toContain('.config/verevoir/anthropic.key');
  });

  // This is the real GitHub Actions failure, not a hypothetical one: an unset
  // secret interpolates to '' rather than disappearing, so the empty case is
  // the case that actually reaches production. Asserted as its own test, and
  // then compared against the absent case so the two cannot drift apart.
  it('treats an empty-string key exactly as an absent one', async () => {
    const result = await resolveSettings(env({ ANTHROPIC_API_KEY: '' }), NO_FILES);

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result)).toEqual(
      missingOf(await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES)),
    );
  });

  it('treats a whitespace-only key as absent', async () => {
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

describe('resolveSettings, given only a Claude subscription OAuth token', () => {
  it('is ready, with no apiKey field at all, rather than incomplete', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value' }),
      NO_FILES,
    );

    expect(result.kind).toBe('ready');
    const settings = readyOf(result);
    // Not merely `undefined` — actually absent as a key, so a caller
    // spreading these settings into a call never sends an explicit
    // `apiKey: undefined`, which this project's `exactOptionalPropertyTypes`
    // treats as different from omitting the key entirely.
    expect('apiKey' in settings).toBe(false);
  });

  it('still reports ANTHROPIC_API_KEY missing when neither credential is set', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }),
      NO_FILES,
    );

    expect(result.kind).toBe('incomplete');
    expect(named(missingOf(result), 'ANTHROPIC_API_KEY')).toBeDefined();
  });

  it('treats a blank CLAUDE_CODE_OAUTH_TOKEN as absent, same as a blank ANTHROPIC_API_KEY', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: '   ' }),
      NO_FILES,
    );

    expect(result.kind).toBe('incomplete');
    expect(named(missingOf(result), 'ANTHROPIC_API_KEY')).toBeDefined();
  });

  it('mentions CLAUDE_CODE_OAUTH_TOKEN in the missing-key guidance, alongside the other sources', async () => {
    const missing = missingOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES),
    );
    const entry = named(missing, 'ANTHROPIC_API_KEY');

    expect(entry.where).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(entry.where).toContain('claude setup-token');
  });

  // The precedence stays what it was: a resolved metered key is still used
  // even when a subscription token also happens to be sitting in the same
  // environment — the OAuth source is checked only once the first three
  // sources have all come up empty.
  it('still prefers a resolved ANTHROPIC_API_KEY over an also-present OAuth token', async () => {
    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: 'sk-from-env', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value' }),
        NO_FILES,
      ),
    );

    expect(settings.apiKey).toBe('sk-from-env');
  });

  // The panel's second review caught the first version of this test as
  // vacuous: it called resolveSettings with NO_FILES and never configured
  // ANTHROPIC_API_KEY_FILE at all, so `apiKeyLookup.blankPaths` was empty
  // regardless of what the implementation actually did with a genuinely
  // blank file — the assertion passed for a reason that had nothing to do
  // with what the test's name and comment claimed to pin. This version
  // actually configures a blank file and proves, via `fs.asked`, that it was
  // read — so `result.kind === 'ready'` below is pinning real behaviour, not
  // an artefact of nothing having been exercised. It also caught a real bug
  // in the first cut of this branch: pushing the blank path into `problems`
  // unconditionally flipped a working OAuth-resolved run to `invalid`,
  // which is fixed in settings.ts alongside this test — see its own comment
  // there for why that would have been wrong.
  it('is silent about a blank explicit key file when the OAuth token still makes the run ready', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: '   \n' } });

    const result = await resolveSettings(
      env({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value',
      }),
      fs.read,
    );

    // The blank file really was read — proof this test exercises the path
    // it claims to, unlike the vacuous version it replaces.
    expect(fs.asked).toEqual(['/keys/anthropic']);
    // No `problems` field exists on a `ready` result at all — readyOf()
    // itself is the assertion that this is a clean ready result and nothing
    // else, matching the equivalent boundary already pinned for the file
    // sources further down this file.
    readyOf(result);
    expect(result.kind).toBe('ready');
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

    expect(settings.apiKey).toBe('sk-from-env');
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

    expect(settings.apiKey).toBe('sk-from-file');
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

    expect(settings.apiKey).toBe('sk-from-explicit-file');
  });

  it('falls back to the default path when neither the environment nor ANTHROPIC_API_KEY_FILE supply a key', async () => {
    const fs = filesystem({
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }), fs.read),
    );

    expect(settings.apiKey).toBe('sk-from-default-path');
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

    expect(settings.apiKey).toBe('sk-from-xdg');
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

  // There WAS a test here asserting the joined problems string did not
  // contain 'sk-', driven by a mock whose `reason` was the hardcoded string
  // 'EACCES: permission denied'. That string can never contain 'sk-'
  // regardless of what resolveSettings does with it, so the assertion could
  // not fail — it held vacuously, and would not have caught an actual
  // key-leaking implementation. That is the same shape of defect this very
  // change fixed elsewhere, caught here by the panel's first real review.
  //
  // The honest state of the property "a key's value never reaches a
  // problem" is that it CANNOT be violated at this layer, and that is worth
  // stating rather than faking a test for. On the unreadable-file path,
  // `resolveSettings` never has a key value in scope to leak: `apiKey` is
  // assigned only in the `found` branch (see `resolveSettings` above), and
  // `KeyFileResult`'s `unreadable` variant carries only `reason` — there is
  // no `text` field for a reader to have put a key into even by mistake. The
  // type system is what enforces this, not a runtime check, so no test
  // belongs here. What CAN leak a key is a reader or a provider client that
  // reads it successfully and then fails to redact it before it reaches an
  // error or a log — a different bug, in a different place, and it is
  // covered where it is real: `redact()` in tests/anthropic.test.ts, tested
  // against a value that actually is the key.

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

    expect(settings.apiKey).toBe('sk-from-default-path');
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

    expect(settings.apiKey).toBe('sk-from-default-path');
  });

  // The gap the panel found: falling through past a blank file must not
  // erase that it WAS blank, if nothing further on ever supplies a key.
  // Before this fix, this case reported only "ANTHROPIC_API_KEY is not
  // configured" — identical to a person who had configured nothing at all,
  // with no trace that the file they specifically pointed at was found and
  // empty.
  it('names the blank explicit key file as a problem when nothing else supplies a key either', async () => {
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
  // resolveApiKey threads blankPaths through both branches, and this proves
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
  // DOES supply a key despite the explicit one being blank, the result is
  // `ready`, which carries no `problems` field at all — so the blank-file
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

    expect(settings.apiKey).toBe('sk-from-default-path');
  });

  // The asymmetry that matters most in this feature: a file is trimmed, the
  // environment is not. Both asserted here, together, so a future edit that
  // "fixes" one to match the other fails immediately rather than passing a
  // suite that only ever checked one direction.
  it('trims a trailing newline from a key read from a file', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: 'sk-from-file\n' } });

    const settings = readyOf(
      await resolveSettings(
        env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
        fs.read,
      ),
    );

    expect(settings.apiKey).toBe('sk-from-file');
  });

  it('does not trim whitespace from a key read from the environment', async () => {
    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: 'sk-from-env\n' }), NO_FILES),
    );

    // Not "absent" and not "trimmed" — the value the environment handed over,
    // byte for byte, because whitespace arriving through an env var is a
    // broken pipeline that should fail loudly against the provider rather
    // than be quietly repaired here.
    expect(settings.apiKey).toBe('sk-from-env\n');
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
