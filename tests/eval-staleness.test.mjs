import { describe, expect, it } from 'vitest';

import { checkStaleness } from '../eval/staleness.mjs';

function resultsFile(name, fields) {
  return { name, text: JSON.stringify(fields) };
}

describe('checkStaleness', () => {
  it('reports no-derivation when resultsFiles is empty', () => {
    const result = checkStaleness({ configuredModel: 'claude-sonnet-5', resultsFiles: [] });
    expect(result.kind).toBe('no-derivation');
    expect(result.configuredModel).toBe('claude-sonnet-5');
    expect(result.filesConsidered).toBe(0);
    expect(result.malformed).toEqual([]);
  });

  it('reports no-derivation when the directory holds only a non-json placeholder (.gitkeep)', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [{ name: '.gitkeep', text: 'Keeps this directory in git.' }],
    });
    expect(result.kind).toBe('no-derivation');
    // .gitkeep is not a results file at all — dropped silently, not reported
    // as malformed, and still counted in filesConsidered because it was a
    // real entry in the directory.
    expect(result.filesConsidered).toBe(1);
    expect(result.malformed).toEqual([]);
  });

  it('reports current when the newest derivation matches the configured model', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [
        resultsFile('2026-08-20-claude-sonnet-5.json', {
          model: 'claude-sonnet-5',
          generatedAt: '2026-08-20T10:00:00.000Z',
        }),
      ],
    });
    expect(result.kind).toBe('current');
    expect(result.derivedModel).toBe('claude-sonnet-5');
    expect(result.configuredModel).toBe('claude-sonnet-5');
    expect(result.sourceFile).toBe('2026-08-20-claude-sonnet-5.json');
    expect(result.derivedAt).toBe('2026-08-20T10:00:00.000Z');
    expect('warning' in result).toBe(false);
  });

  it('reports stale when the newest derivation was made against a different model, and names the source', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-6',
      resultsFiles: [
        resultsFile('2026-08-20-claude-sonnet-5.json', {
          model: 'claude-sonnet-5',
          generatedAt: '2026-08-20T10:00:00.000Z',
        }),
      ],
    });
    expect(result.kind).toBe('stale');
    expect(result.derivedModel).toBe('claude-sonnet-5');
    expect(result.configuredModel).toBe('claude-sonnet-6');
    expect(result.sourceFile).toBe('2026-08-20-claude-sonnet-5.json');
    expect(result.derivedAt).toBe('2026-08-20T10:00:00.000Z');
    // H88: the warning names the number's source, not just that it is stale.
    expect(result.warning).toContain('2026-08-20-claude-sonnet-5.json');
    expect(result.warning).toContain('claude-sonnet-5');
    expect(result.warning).toContain('claude-sonnet-6');
    expect(result.warning).toContain('2026-08-20T10:00:00.000Z');
  });

  it('compares against the newest file by generatedAt, not by array order or file name', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-6',
      resultsFiles: [
        // Listed first, but it is the OLDER of the two by generatedAt —
        // the file name alone does not say which is newer once more than
        // one run happens on the same day or the directory is resumed out
        // of order.
        resultsFile('2026-08-19-claude-sonnet-6.json', {
          model: 'claude-sonnet-6',
          generatedAt: '2026-08-19T09:00:00.000Z',
        }),
        resultsFile('2026-08-20-claude-sonnet-5.json', {
          model: 'claude-sonnet-5',
          generatedAt: '2026-08-20T10:00:00.000Z',
        }),
      ],
    });
    expect(result.kind).toBe('stale');
    expect(result.sourceFile).toBe('2026-08-20-claude-sonnet-5.json');
  });

  it('breaks a tie in generatedAt deterministically, by file name', () => {
    const tiedAt = '2026-08-20T10:00:00.000Z';
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [
        resultsFile('2026-08-20-a-claude-sonnet-5.json', {
          model: 'claude-sonnet-5',
          generatedAt: tiedAt,
        }),
        resultsFile('2026-08-20-b-claude-sonnet-6.json', {
          model: 'claude-sonnet-6',
          generatedAt: tiedAt,
        }),
      ],
    });
    // 'b' sorts after 'a' — the tie-break picks the lexicographically later
    // name, and does so the same way on every call (see the next test).
    expect(result.sourceFile).toBe('2026-08-20-b-claude-sonnet-6.json');
  });

  it('is deterministic: the tie-break does not depend on input order', () => {
    const tiedAt = '2026-08-20T10:00:00.000Z';
    const files = [
      resultsFile('2026-08-20-a-claude-sonnet-5.json', {
        model: 'claude-sonnet-5',
        generatedAt: tiedAt,
      }),
      resultsFile('2026-08-20-b-claude-sonnet-6.json', {
        model: 'claude-sonnet-6',
        generatedAt: tiedAt,
      }),
    ];
    const forwards = checkStaleness({ configuredModel: 'claude-sonnet-5', resultsFiles: files });
    const backwards = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [...files].reverse(),
    });
    expect(forwards.sourceFile).toBe(backwards.sourceFile);
  });

  it('records a malformed file (invalid JSON) without crashing, and still judges usable files', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [
        { name: '2026-08-20-broken.json', text: '{ not json' },
        resultsFile('2026-08-20-claude-sonnet-5.json', {
          model: 'claude-sonnet-5',
          generatedAt: '2026-08-20T10:00:00.000Z',
        }),
      ],
    });
    expect(result.kind).toBe('current');
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].name).toBe('2026-08-20-broken.json');
    expect(result.malformed[0].reason).toContain('not valid JSON');
  });

  it('records a malformed file (missing model field) without crashing', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [resultsFile('no-model.json', { generatedAt: '2026-08-20T10:00:00.000Z' })],
    });
    expect(result.kind).toBe('no-derivation');
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].reason).toContain('model');
  });

  it('records a malformed file (missing generatedAt field) without crashing', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [resultsFile('no-date.json', { model: 'claude-sonnet-5' })],
    });
    expect(result.kind).toBe('no-derivation');
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].reason).toContain('generatedAt');
  });

  it('treats an unparseable generatedAt as malformed', () => {
    const result = checkStaleness({
      configuredModel: 'claude-sonnet-5',
      resultsFiles: [
        resultsFile('bad-date.json', { model: 'claude-sonnet-5', generatedAt: 'not-a-date' }),
      ],
    });
    expect(result.kind).toBe('no-derivation');
    expect(result.malformed[0].reason).toContain('generatedAt');
  });

  it('is pure: calling it twice on the same inputs gives the same result', () => {
    const input = {
      configuredModel: 'claude-sonnet-6',
      resultsFiles: [
        resultsFile('2026-08-20-claude-sonnet-5.json', {
          model: 'claude-sonnet-5',
          generatedAt: '2026-08-20T10:00:00.000Z',
        }),
      ],
    };
    expect(checkStaleness(input)).toEqual(checkStaleness(input));
  });

  it('throws for a missing configuredModel', () => {
    expect(() => checkStaleness({ resultsFiles: [] })).toThrow(/configuredModel/);
  });

  it('throws for a blank configuredModel', () => {
    expect(() => checkStaleness({ configuredModel: '   ', resultsFiles: [] })).toThrow(
      /configuredModel/,
    );
  });

  it('throws when resultsFiles is not an array', () => {
    expect(() =>
      checkStaleness({ configuredModel: 'claude-sonnet-5', resultsFiles: undefined }),
    ).toThrow(/resultsFiles/);
  });
});
