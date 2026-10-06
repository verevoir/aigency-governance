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

/** The `apiKey` half of a `ready`/`billed` result, narrowed with the same
 * throw-with-context discipline as `readyOf` — a test that expected the
 * billed route and got the keyless one names the whole settings object
 * rather than failing on a property that TypeScript already knows is not
 * there. */
function apiKeyOf(settings: ReviewSettings): string {
  if (settings.route !== 'billed') {
    throw new Error(`expected route 'billed', got ${JSON.stringify(settings)}`);
  }
  return settings.apiKey;
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
  it('returns ready, billed, with every field taken from the environment', async () => {
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
      route: 'billed',
      apiKey: 'sk-ant-complete',
      model: 'claude-opus-9',
      maxTokens: 8192,
      lensSource: 'https://lenses.test/set.json',
      lensToken: 'lens-token',
    });
  });
});

describe('resolveSettings, given no API key from any source', () => {
  // The reversal this module exists to make: an absent key used to be
  // `incomplete` and block the run. The operator's billed credits are
  // reserved for GitHub Actions, and a laptop run should default to the
  // keyless claude-cli transport instead of demanding a key it was never
  // meant to spend locally — so this now resolves to `ready`, not
  // `incomplete`, and carries no `apiKey` field at all.
  it('resolves to ready, keyless, rather than incomplete', async () => {
    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES),
    );

    expect(settings.route).toBe('keyless');
    expect('apiKey' in settings).toBe(false);
  });

  it('never names ANTHROPIC_API_KEY as missing', async () => {
    const result = await resolveSettings(env({ ANTHROPIC_API_KEY: undefined }), NO_FILES);

    // `ready` carries no `missing` at all — asserted via `kind` rather than
    // reaching for a field that would not type-check on this branch, which
    // is itself part of what this test pins: the absent-key case is not an
    // `incomplete` wearing a passing assertion.
    expect(result.kind).toBe('ready');
  });

  // The real GitHub Actions failure shape stays covered on the keyless side
  // too: an unset secret interpolates to '' rather than disappearing, and
  // both must be treated identically to a key that was never set at all —
  // keyless, not an error.
  it('treats an empty-string key exactly as an absent one', async () => {
    const result = await resolveSettings(env({ ANTHROPIC_API_KEY: '' }), NO_FILES);

    expect(readyOf(result).route).toBe('keyless');
  });

  it('treats a whitespace-only key as absent', async () => {
    const result = await resolveSettings(env({ ANTHROPIC_API_KEY: '  \t\n ' }), NO_FILES);

    expect(readyOf(result).route).toBe('keyless');
  });
});

describe('resolveSettings, given an empty environment', () => {
  // With the API key no longer counted as missing, the lens token is the
  // only setting that can still be. Asserting the length as well as the name
  // is what makes "reports the first and stops" a failure here rather than a
  // passing subset — the one remaining case of the property this module has
  // always held.
  it('reports the lens token as the only missing setting', async () => {
    const missing = missingOf(await resolveSettings({}, NO_FILES));

    expect(missing).toHaveLength(1);
    expect(missing[0]?.name).toBe('AIGENCY_REVIEW_LENSES_TOKEN');
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

    expect(apiKeyOf(settings)).toBe('sk-from-env');
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

    expect(apiKeyOf(settings)).toBe('sk-from-file');
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

    expect(apiKeyOf(settings)).toBe('sk-from-explicit-file');
  });

  it('falls back to the default path when neither the environment nor ANTHROPIC_API_KEY_FILE supply a key', async () => {
    const fs = filesystem({
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }), fs.read),
    );

    expect(apiKeyOf(settings)).toBe('sk-from-default-path');
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

    expect(apiKeyOf(settings)).toBe('sk-from-xdg');
  });

  // A missing default path is not an error — it is simply that source
  // contributing nothing, same as any other absent file, and now resolves
  // all the way through to the keyless route rather than to an error. This
  // is the case that actually matters most: most environments have not set
  // any of this up, and the review must still resolve to a clear, runnable
  // `ready`/`keyless` result rather than a thrown exception or a block.
  it('resolves to ready, keyless, when the default path does not exist either', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }),
      NO_FILES,
    );

    expect(readyOf(result).route).toBe('keyless');
  });

  // A file that exists and cannot be read is a different problem from a file
  // that was never created, and must be reported differently: `invalid`
  // rather than falling through to the keyless route, because it is present
  // and broken — someone already tried to set up the billed path — rather
  // than simply absent.
  it('reports a file that cannot be read differently from a default path that is merely untouched', async () => {
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

    // Compared against the CONVENTIONAL DEFAULT path being absent — not
    // against the same named path being absent, which now also blocks (see
    // 'blocks on a named-but-missing explicit key file...' above). The
    // default path, never named by anyone, is the one case that still runs
    // keyless: this is what keeps the two from collapsing into the same
    // outcome by accident.
    const defaultAbsent = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }),
      NO_FILES,
    );
    expect(readyOf(defaultAbsent).route).toBe('keyless');
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

  // Reviewed and reversed: a blank file someone pointed at used to be folded
  // into `absent` and fall through to whatever the next source supplied —
  // here, a WORKING default-path key — so this exact setup used to resolve
  // to a clean, silent `ready`/`billed` result. That is precisely the
  // failure named in the file header: a broken billed setup silently
  // rescued by a route it never asked for, with no trace left anywhere that
  // the file the caller actually pointed at was empty. It now blocks
  // instead — the default path is never even consulted.
  it('blocks on a blank explicit key file rather than falling through to a working default path', async () => {
    const fs = filesystem({
      '/keys/anthropic': { kind: 'text', text: '' },
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const result = await resolveSettings(
      env({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        HOME: '/home/it',
      }),
      fs.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
    expect(problems.some((problem) => problem.includes('blank'))).toBe(true);
    // The default path was never even asked for — resolution stopped at the
    // blank explicit file, exactly as it does for an unreadable one.
    expect(fs.asked).toEqual(['/keys/anthropic']);
  });

  it('blocks on whitespace-only explicit file contents the same way, not merely on a literally empty file', async () => {
    const fs = filesystem({
      '/keys/anthropic': { kind: 'text', text: '  \n\t  \n' },
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const result = await resolveSettings(
      env({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        HOME: '/home/it',
      }),
      fs.read,
    );

    expect(result.kind).toBe('invalid');
    expect(problemsOf(result).some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
  });

  it('blocks (invalid) when the explicit key file is blank and nothing else would have supplied a key either', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: '   \n' } });

    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      fs.read,
    );

    expect(result.kind).toBe('invalid');
    expect(problemsOf(result).some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
  });

  // The same case at the default path rather than the explicit one —
  // resolveApiKey threads both branches through the same `keyFromPath`, and
  // this proves the second one independently rather than assuming symmetry.
  it('blocks (invalid) when the default key file is blank, even though no explicit path was ever set', async () => {
    const fs = filesystem({
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: '' },
    });

    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }),
      fs.read,
    );

    expect(result.kind).toBe('invalid');
    expect(
      problemsOf(result).some((problem) =>
        problem.includes('/home/it/.config/verevoir/anthropic.key'),
      ),
    ).toBe(true);
  });

  // The distinguishing case for this whole finding: a path someone actually
  // NAMED, with nothing at it, must block — unlike the default path (tested
  // above), which is allowed to be absent and fall through to keyless. Before
  // this fix, both were folded into the same `absent` outcome and this exact
  // setup resolved to a clean, silent `ready`/`billed`-turned-keyless result.
  it('blocks on a named-but-missing explicit key file rather than falling through to a working default path', async () => {
    const fs = filesystem({
      '/home/it/.config/verevoir/anthropic.key': { kind: 'text', text: 'sk-from-default-path' },
    });

    const result = await resolveSettings(
      env({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        HOME: '/home/it',
      }),
      fs.read,
    );

    expect(result.kind).toBe('invalid');
    const problems = problemsOf(result);
    expect(problems.some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
    // The default path was never even asked for — resolution stopped at the
    // named-but-missing explicit file, exactly as it does for a blank or
    // unreadable one.
    expect(fs.asked).toEqual(['/keys/anthropic']);
  });

  // The direct contrast: naming a path that turns out empty is a
  // configuration error and blocks; the DEFAULT path never having been
  // touched is ordinary and runs keyless. Both driven from the same
  // (otherwise-identical) environment so the only variable is which one was
  // named.
  it('treats a missing default path and a missing named path differently', async () => {
    const defaultAbsent = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, HOME: '/home/it' }),
      NO_FILES,
    );
    expect(readyOf(defaultAbsent).route).toBe('keyless');

    const namedAbsent = await resolveSettings(
      env({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        HOME: '/home/it',
      }),
      NO_FILES,
    );
    expect(namedAbsent.kind).toBe('invalid');
  });

  it('keeps the named-but-missing problem even though something else is also missing', async () => {
    const result = await resolveSettings(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        AIGENCY_REVIEW_LENSES_TOKEN: undefined,
      },
      NO_FILES,
    );

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
    ]);
    expect(problemsOf(result).some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
  });

  it('names the missing path in the rendered message', async () => {
    const result = await resolveSettings(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      NO_FILES,
    );

    const rendered = renderMissing(
      result.kind === 'incomplete' ? result.missing : [],
      problemsOf(result),
    );
    expect(rendered).toContain('/keys/anthropic');
    expect(rendered).toContain('ANTHROPIC_API_KEY_FILE');
  });

  // The same "a problem survives alongside a missing setting" property
  // already pinned for an unreadable file, restated for a blank one — the
  // two block through the same code path but are distinct facts, and a
  // rewrite that collapsed them back together should fail this.
  it('keeps the blank-file problem even though something else is also missing', async () => {
    const fs = filesystem({ '/keys/anthropic': { kind: 'text', text: '' } });

    const result = await resolveSettings(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_API_KEY_FILE: '/keys/anthropic',
        AIGENCY_REVIEW_LENSES_TOKEN: undefined,
      },
      fs.read,
    );

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
    ]);
    expect(problemsOf(result).some((problem) => problem.includes('/keys/anthropic'))).toBe(true);
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

    expect(apiKeyOf(settings)).toBe('sk-from-file');
  });

  it('does not trim whitespace from a key read from the environment', async () => {
    const settings = readyOf(
      await resolveSettings(env({ ANTHROPIC_API_KEY: 'sk-from-env\n' }), NO_FILES),
    );

    // Not "absent" and not "trimmed" — the value the environment handed over,
    // byte for byte, because whitespace arriving through an env var is a
    // broken pipeline that should fail loudly against the provider rather
    // than be quietly repaired here.
    expect(apiKeyOf(settings)).toBe('sk-from-env\n');
  });
});

describe('resolveSettings, when a problem and a missing setting are both true', () => {
  // The exact shape the panel's first real review caught: an unreadable key
  // file (a problem) coinciding with an unset lens token (a missing
  // setting). Before this fix, `missing.length > 0` alone decided `kind`
  // and the broken-file problem vanished from the result entirely — a
  // person would see only "you haven't set AIGENCY_REVIEW_LENSES_TOKEN",
  // with no trace that the key file they DID set could not be opened. An
  // unreadable file still blocks even though an absent key no longer does
  // — see the file header.
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
    // A concrete id, not a term — an interim pin until @verevoir/llm exposes
    // its catalog without the SDK (see DEFAULT_MODEL's own header in
    // settings.ts).
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
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

  // With the API key no longer ever `missing`, the only setting left that
  // CAN be missing alongside an invalid maxTokens is the lens token — this
  // is the same "both survive" property the settings.test.ts suite has
  // always pinned for that combination, restated for the one missing
  // setting that still exists.
  it('reports what is missing first, but keeps what is also invalid, when both are true', async () => {
    const result = await resolveSettings({ AIGENCY_REVIEW_MAX_TOKENS: 'abc' }, NO_FILES);

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result).map((setting) => setting.name)).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
    ]);
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

    expect(renderMissing(missingOf(result), problemsOf(result))).toContain('1 setting(s)');
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
