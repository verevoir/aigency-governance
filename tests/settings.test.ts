// The environment is passed in, so none of this touches `process.env` and no
// test can leak configuration into another.
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

function problemsOf(result: SettingsResult): readonly string[] {
  if (result.kind !== 'invalid') {
    throw new Error(`expected invalid, got ${JSON.stringify(result)}`);
  }
  return result.problems;
}

function named(missing: readonly MissingSetting[], name: string): MissingSetting {
  const found = missing.find((setting) => setting.name === name);
  if (found === undefined) {
    throw new Error(`no entry for ${name} in ${JSON.stringify(missing.map((s) => s.name))}`);
  }
  return found;
}

describe('resolveSettings, given everything it needs', () => {
  it('returns ready with every field taken from the environment', () => {
    const settings = readyOf(
      resolveSettings({
        ANTHROPIC_API_KEY: 'sk-ant-complete',
        AIGENCY_REVIEW_MODEL: 'claude-opus-9',
        AIGENCY_REVIEW_MAX_TOKENS: '8192',
        AIGENCY_REVIEW_LENSES: 'https://lenses.test/set.json',
        AIGENCY_REVIEW_LENSES_TOKEN: 'lens-token',
      }),
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
  it('reports it as incomplete, naming the variable and what it is for', () => {
    const missing = missingOf(resolveSettings(env({ ANTHROPIC_API_KEY: undefined })));
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
  it('names both the GitHub place and the local place to put it', () => {
    const missing = missingOf(resolveSettings(env({ ANTHROPIC_API_KEY: undefined })));
    const entry = named(missing, 'ANTHROPIC_API_KEY');

    expect(entry.where).toContain('Secrets and variables');
    expect(entry.where).toContain('export ANTHROPIC_API_KEY=');
  });

  // This is the real GitHub Actions failure, not a hypothetical one: an unset
  // secret interpolates to '' rather than disappearing, so the empty case is
  // the case that actually reaches production. Asserted as its own test, and
  // then compared against the absent case so the two cannot drift apart.
  it('treats an empty-string key exactly as an absent one', () => {
    const result = resolveSettings(env({ ANTHROPIC_API_KEY: '' }));

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result)).toEqual(
      missingOf(resolveSettings(env({ ANTHROPIC_API_KEY: undefined }))),
    );
  });

  it('treats a whitespace-only key as absent', () => {
    const result = resolveSettings(env({ ANTHROPIC_API_KEY: '  \t\n ' }));

    expect(result.kind).toBe('incomplete');
    expect(missingOf(result)).toEqual(
      missingOf(resolveSettings(env({ ANTHROPIC_API_KEY: undefined }))),
    );
  });
});

describe('resolveSettings, given an empty environment', () => {
  // The defect this shape exists to avoid: one missing value per CI round,
  // discovered by the person least able to guess what the next one will be.
  // Asserting the length as well as the names is what makes "reports the first
  // and stops" a failure here rather than a passing subset.
  it('reports both missing settings together rather than one at a time', () => {
    const missing = missingOf(resolveSettings({}));

    expect(missing).toHaveLength(2);
    expect(missing.map((setting) => setting.name).sort()).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
      'ANTHROPIC_API_KEY',
    ]);
  });

  it('says where the lens token comes from in Actions and on a laptop', () => {
    const entry = named(missingOf(resolveSettings({})), 'AIGENCY_REVIEW_LENSES_TOKEN');

    expect(entry.where).toContain('secrets.GITHUB_TOKEN');
    expect(entry.where).toContain('AIGENCY_REVIEW_LENSES');
    expect(entry.why).toContain('private');
  });
});

describe('resolveSettings, resolving the lens token', () => {
  it('accepts GITHUB_TOKEN when no dedicated token is set', () => {
    const settings = readyOf(
      resolveSettings(
        env({ AIGENCY_REVIEW_LENSES_TOKEN: undefined, GITHUB_TOKEN: 'gh-actions-token' }),
      ),
    );

    expect(settings.lensToken).toBe('gh-actions-token');
  });

  // The dedicated variable exists precisely so a token with wider access can
  // override the one Actions injects. If GITHUB_TOKEN won, setting it would do
  // nothing and nothing would say so.
  it('prefers AIGENCY_REVIEW_LENSES_TOKEN over GITHUB_TOKEN when both are set', () => {
    const settings = readyOf(
      resolveSettings(
        env({ AIGENCY_REVIEW_LENSES_TOKEN: 'dedicated', GITHUB_TOKEN: 'gh-actions-token' }),
      ),
    );

    expect(settings.lensToken).toBe('dedicated');
  });

  it('treats an empty GITHUB_TOKEN as no token at all', () => {
    const result = resolveSettings(
      env({ AIGENCY_REVIEW_LENSES_TOKEN: undefined, GITHUB_TOKEN: '' }),
    );

    expect(missingOf(result).map((setting) => setting.name)).toEqual([
      'AIGENCY_REVIEW_LENSES_TOKEN',
    ]);
  });

  // The laptop run. Demanding a token to read a file off disk would make
  // reviewing against a checked-out copy impossible for no reason.
  it('needs no token when the lens source is a file path', () => {
    const settings = readyOf(
      resolveSettings(
        env({
          AIGENCY_REVIEW_LENSES: './review/lenses.json',
          AIGENCY_REVIEW_LENSES_TOKEN: undefined,
        }),
      ),
    );

    expect(settings.lensSource).toBe('./review/lenses.json');
    // Absent, not present-and-undefined: a bearer header built from `undefined`
    // would be sent as the string "Bearer undefined".
    expect('lensToken' in settings).toBe(false);
  });
});

describe('resolveSettings, falling back to defaults', () => {
  it('uses the exported defaults for model, maxTokens and lens source', () => {
    const settings = readyOf(resolveSettings(env()));

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
    expect(DEFAULT_MAX_TOKENS).toBe(4096);
    expect(DEFAULT_LENS_SOURCE).toBe(
      'https://raw.githubusercontent.com/verevoir/aigency-governance/main/review/lenses.json',
    );
  });

  it('takes an override for the model', () => {
    const settings = readyOf(resolveSettings(env({ AIGENCY_REVIEW_MODEL: 'claude-haiku-3' })));

    expect(settings.model).toBe('claude-haiku-3');
  });

  it('takes an override for maxTokens, as a number', () => {
    const settings = readyOf(resolveSettings(env({ AIGENCY_REVIEW_MAX_TOKENS: '12000' })));

    expect(settings.maxTokens).toBe(12000);
  });

  it('takes an override for the lens source', () => {
    const settings = readyOf(
      resolveSettings(env({ AIGENCY_REVIEW_LENSES: 'https://lenses.test/other.json' })),
    );

    expect(settings.lensSource).toBe('https://lenses.test/other.json');
  });
});

describe('resolveSettings, given a maxTokens it cannot use', () => {
  // Each of these is a value someone deliberately typed. Falling back to the
  // default would run the review against a configuration its own environment
  // contradicts, and report nothing.
  for (const raw of ['abc', '0', '-1', '1.5', '1e400']) {
    it(`refuses ${raw} rather than quietly defaulting`, () => {
      const result = resolveSettings(env({ AIGENCY_REVIEW_MAX_TOKENS: raw }));

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
    it(`accepts ${raw}`, () => {
      expect(readyOf(resolveSettings(env({ AIGENCY_REVIEW_MAX_TOKENS: raw }))).maxTokens).toBe(
        Number(raw),
      );
    });
  }

  // Someone who has set nothing needs the list of what to set. Complaining
  // about a token count they never supplied, while saying nothing about the
  // key, would send them to fix the one thing that is not their problem.
  it('reports what is missing first, when something is both missing and invalid', () => {
    const result = resolveSettings({ AIGENCY_REVIEW_MAX_TOKENS: 'abc' });

    expect(result.kind).toBe('incomplete');
    expect(
      missingOf(result)
        .map((setting) => setting.name)
        .sort(),
    ).toEqual(['AIGENCY_REVIEW_LENSES_TOKEN', 'ANTHROPIC_API_KEY']);
  });
});

describe('renderMissing', () => {
  const missing = missingOf(resolveSettings({}));
  const rendered = renderMissing(missing);

  it('names every missing setting, with what it is for and where it goes', () => {
    for (const setting of missing) {
      expect(rendered).toContain(setting.name);
      expect(rendered).toContain(setting.why);
      expect(rendered).toContain(setting.where);
    }
  });

  it('says how many settings are unconfigured', () => {
    expect(rendered).toContain('2 setting(s)');
  });

  // A run that reviewed nothing is not a run that found nothing wrong. Without
  // this line the log reads like a clean result to anyone skimming it.
  it('says the result is red and that nothing was reviewed', () => {
    expect(rendered).toContain('red result, not a passing one');
    expect(rendered).toContain('Nothing was reviewed');
  });
});
