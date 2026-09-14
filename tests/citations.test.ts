import { describe, expect, it } from 'vitest';

import {
  buildCitedContext,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  extractCitations,
  renderCitedContext,
  type Citation,
  type CitationFileReader,
} from '../src/review/citations.js';

function diffOf(...addedLines: string[]): string {
  return ['--- a/docs/x.md', '+++ b/docs/x.md', '@@ -1,0 +1,10 @@', ...addedLines].join('\n');
}

function fakeReader(files: Record<string, string>): CitationFileReader {
  return (path) =>
    Promise.resolve(
      path in files
        ? { kind: 'text', text: files[path] ?? '' }
        : { kind: 'missing', reason: 'ENOENT: no such file' },
    );
}

describe('extractCitations', () => {
  it('extracts a bare path:line citation', () => {
    const diff = diffOf('+See `src/review/settings.ts:120` for the resolution order.');
    const citations = extractCitations(diff);
    expect(citations).toEqual([
      { raw: '`src/review/settings.ts:120`', path: 'src/review/settings.ts', line: 120 },
    ]);
  });

  it('extracts a path:line-line range citation', () => {
    const diff = diffOf('+`src/review/settings.ts:200-240` covers the three sources.');
    const citations = extractCitations(diff);
    expect(citations).toEqual([
      {
        raw: '`src/review/settings.ts:200-240`',
        path: 'src/review/settings.ts',
        line: 200,
        endLine: 240,
      },
    ]);
  });

  // The exact shape verevoir/aigency-harness#118 uses throughout its own
  // two files — see this repository's commit message for the citation.
  it("extracts a path's `Symbol` citation, the form #118 actually uses", () => {
    const diff = diffOf(
      "+**No construction-time credential check** — see `clients/mcp/belt.ts`'s `DEFAULT_LIVENESS_CHECKS`.",
    );
    const citations = extractCitations(diff);
    expect(citations).toEqual([
      {
        raw: "`clients/mcp/belt.ts`'s `DEFAULT_LIVENESS_CHECKS`",
        path: 'clients/mcp/belt.ts',
        symbol: 'DEFAULT_LIVENESS_CHECKS',
      },
    ]);
  });

  it('extracts a bare path citation with no line or symbol', () => {
    const diff = diffOf('+See `docs/adapters/model-anthropic.md` for the caching route.');
    const citations = extractCitations(diff);
    expect(citations).toEqual([
      { raw: '`docs/adapters/model-anthropic.md`', path: 'docs/adapters/model-anthropic.md' },
    ]);
  });

  it('does not treat a bare backtick-quoted word with no extension as a citation', () => {
    const diff = diffOf('+The adapter reports `refused` when `claude-cli` declines.');
    expect(extractCitations(diff)).toEqual([]);
  });

  it('ignores citations on removed lines', () => {
    const diff = diffOf('-See `src/review/settings.ts:120` for the resolution order.');
    expect(extractCitations(diff)).toEqual([]);
  });

  it('ignores citations on unchanged context lines', () => {
    const diff = diffOf(' See `src/review/settings.ts:120` for the resolution order.');
    expect(extractCitations(diff)).toEqual([]);
  });

  // A `+++ b/path` diff header also starts with `+` — it names the file a
  // hunk touches, not a claim inside the document, and must never be read
  // as a citation.
  //
  // THE DISCRIMINATING VERSION, replacing one that could not fail: the old
  // header line (`+++ b/docs/x.md:1`) carries no backtick span at all, so
  // `backtickSpans` finds nothing on it regardless of whether the `+++`
  // guard exists — the assertion passed even with the guard deleted. This
  // version embeds a real, citation-shaped backtick span INSIDE the `+++`
  // line itself, so the guard is the only thing standing between it and an
  // extracted citation. Mutation-tested by hand (see this commit's own
  // message): with `rawLine.startsWith('+++')` removed from
  // `extractCitations`'s skip condition, this failed — `citation-in-header.
  // ts:1` was extracted, `toEqual([])` did not hold; restored, it passes.
  it('ignores the +++ diff header line itself, even when it carries a citation-shaped span', () => {
    const diff = [
      '--- a/docs/x.md',
      '+++ b/docs/x.md `citation-in-header.ts:1`',
      '@@ -1,0 +1,1 @@',
      '+ordinary text',
    ].join('\n');
    expect(extractCitations(diff)).toEqual([]);
  });

  it('deduplicates an identical citation repeated across lines', () => {
    const diff = diffOf(
      '+First: `src/review/settings.ts:120`.',
      '+Again: `src/review/settings.ts:120`.',
    );
    expect(extractCitations(diff)).toHaveLength(1);
  });

  it('extracts every distinct citation on the same line', () => {
    const diff = diffOf('+See `src/review/settings.ts:120` and also `src/review/panel.ts:40-50`.');
    const citations = extractCitations(diff);
    expect(citations.map((c) => c.path)).toEqual(['src/review/settings.ts', 'src/review/panel.ts']);
  });

  it("does not fuse a path's `Symbol` across two unrelated sentences", () => {
    // 's is not glued directly to the closing backtick here — a real "'s"
    // sits well after, so this must read as two separate bare citations.
    const diff = diffOf("+`docs/a.md` is one doc. `docs/b.md`'s companion is elsewhere.");
    const citations = extractCitations(diff);
    expect(citations).toEqual([
      { raw: '`docs/a.md`', path: 'docs/a.md' },
      { raw: '`docs/b.md`', path: 'docs/b.md' },
    ]);
  });

  // A sharper version of the case above: the text between the two spans
  // CONTAINS the substring "'s" (inside "figure's") without being adjacent
  // to the closing backtick. A looser guard checking `.includes("'s")`
  // rather than `=== "'s "` would wrongly attempt to fuse this — the
  // strict-equality check must reject it and leave the path bare.
  it('does not fuse when the text between spans merely contains "\'s" as a substring', () => {
    const diff = diffOf("+`docs/a.md` figure's `Something` is unrelated.");
    const citations = extractCitations(diff);
    expect(citations).toEqual([{ raw: '`docs/a.md`', path: 'docs/a.md' }]);
  });
});

describe('buildCitedContext — resolving a path:line citation', () => {
  const FILE = Array.from({ length: 50 }, (_, i) => `line ${String(i + 1)}`).join('\n');

  it('resolves the region, padded around the cited line', async () => {
    const citation: Citation = { raw: '`f.ts:20`', path: 'f.ts', line: 20 };
    const result = await buildCitedContext([citation], fakeReader({ 'f.ts': FILE }));
    expect(result.unresolved).toEqual([]);
    expect(result.omitted).toEqual([]);
    expect(result.regions).toHaveLength(1);
    const [region] = result.regions;
    expect(region?.startLine).toBe(12); // 20 - 8
    expect(region?.endLine).toBe(28); // 20 + 8
    expect(region?.text).toContain('line 20');
    expect(region?.text).toContain('line 12');
    expect(region?.text).not.toContain('line 11');
  });

  it('resolves a line range, padding around both ends', async () => {
    const citation: Citation = { raw: '`f.ts:20-22`', path: 'f.ts', line: 20, endLine: 22 };
    const result = await buildCitedContext([citation], fakeReader({ 'f.ts': FILE }));
    expect(result.regions[0]?.startLine).toBe(12);
    expect(result.regions[0]?.endLine).toBe(30); // 22 + 8
  });

  it('clips the padded window to the file bounds rather than going out of range', async () => {
    const citation: Citation = { raw: '`f.ts:2`', path: 'f.ts', line: 2 };
    const result = await buildCitedContext([citation], fakeReader({ 'f.ts': FILE }));
    expect(result.regions[0]?.startLine).toBe(1);
  });

  it('reports a cited line outside the file as unresolved, naming why', async () => {
    const citation: Citation = { raw: '`f.ts:999`', path: 'f.ts', line: 999 };
    const result = await buildCitedContext([citation], fakeReader({ 'f.ts': FILE }));
    expect(result.regions).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toContain('outside the file');
  });
});

describe('buildCitedContext — resolving a symbol citation', () => {
  const FILE = [
    'export const A = 1;',
    '',
    'function unrelated() {}',
    '',
    'export const DEFAULT_LIVENESS_CHECKS = {',
    '  model: checkModel,',
    '};',
  ].join('\n');

  it('locates the symbol and pads around its first occurrence', async () => {
    const citation: Citation = {
      raw: "`f.ts`'s `DEFAULT_LIVENESS_CHECKS`",
      path: 'f.ts',
      symbol: 'DEFAULT_LIVENESS_CHECKS',
    };
    const result = await buildCitedContext([citation], fakeReader({ 'f.ts': FILE }));
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.text).toContain('DEFAULT_LIVENESS_CHECKS');
    expect(result.regions[0]?.startLine).toBe(1); // padded window hits the top of the file
  });

  it('does not match a symbol name that is only a substring of another identifier', async () => {
    const file = 'const DEFAULT_LIVENESS_CHECKS_EXTRA = 1;\nconst other = 2;';
    const citation: Citation = {
      raw: "`f.ts`'s `CHECKS`",
      path: 'f.ts',
      symbol: 'CHECKS',
    };
    const result = await buildCitedContext([citation], fakeReader({ 'f.ts': file }));
    // \bCHECKS\b does not match inside `..._CHECKS_EXTRA` because `_` is a
    // word character on both sides, so this must report unresolved, not a
    // false-positive match on the longer identifier.
    expect(result.regions).toEqual([]);
    expect(result.unresolved[0]?.reason).toContain('was not found');
  });

  it('reports a symbol not present in the file as unresolved', async () => {
    const citation: Citation = { raw: "`f.ts`'s `Nope`", path: 'f.ts', symbol: 'Nope' };
    const result = await buildCitedContext([citation], fakeReader({ 'f.ts': FILE }));
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toContain('was not found');
  });
});

describe('buildCitedContext — citations that never reach a read at all', () => {
  it('reports a bare path (no line, no symbol) as unresolved, without reading it', async () => {
    let readCalled = false;
    const reader: CitationFileReader = () => {
      readCalled = true;
      return Promise.resolve({ kind: 'text', text: 'irrelevant' });
    };
    const citation: Citation = { raw: '`docs/x.md`', path: 'docs/x.md' };
    const result = await buildCitedContext([citation], reader);
    expect(result.regions).toEqual([]);
    expect(result.unresolved[0]?.reason).toContain('no line or symbol');
    expect(readCalled).toBe(false);
  });

  it('refuses an absolute path without reading it, naming the specific cause', async () => {
    let readCalled = false;
    const reader: CitationFileReader = () => {
      readCalled = true;
      return Promise.resolve({ kind: 'text', text: 'irrelevant' });
    };
    // .ts so this exercises the absolute-path check specifically, not the
    // extension check that would also refuse an extensionless path.
    const citation: Citation = { raw: '`/etc/x.ts:1`', path: '/etc/x.ts', line: 1 };
    const result = await buildCitedContext([citation], reader);
    expect(result.unresolved[0]?.reason).toContain('absolute');
    expect(readCalled).toBe(false);
  });

  it('refuses a path containing a .. segment without reading it, naming the specific cause', async () => {
    let readCalled = false;
    const reader: CitationFileReader = () => {
      readCalled = true;
      return Promise.resolve({ kind: 'text', text: 'irrelevant' });
    };
    const citation: Citation = {
      raw: '`../../etc/x.ts:1`',
      path: '../../etc/x.ts',
      line: 1,
    };
    const result = await buildCitedContext([citation], reader);
    expect(result.unresolved[0]?.reason).toContain('traversal');
    expect(readCalled).toBe(false);
  });

  // The vulnerability this module was found to have (PR #20's own review,
  // blast-radius lens, blocking): neither absolute nor a traversal segment,
  // so the old check let it straight through to the reader.
  it('refuses a path whose extension is not in the allowlist, without reading it', async () => {
    let readCalled = false;
    const reader: CitationFileReader = () => {
      readCalled = true;
      return Promise.resolve({ kind: 'text', text: 'SECRET=abc123' });
    };
    const citation: Citation = { raw: '`config/.env:1`', path: 'config/.env', line: 1 };
    const result = await buildCitedContext([citation], reader);
    expect(result.regions).toEqual([]);
    expect(result.unresolved[0]?.reason).toContain('refused');
    expect(readCalled).toBe(false);
  });

  it('refuses a path with no extension at all, without reading it', async () => {
    let readCalled = false;
    const reader: CitationFileReader = () => {
      readCalled = true;
      return Promise.resolve({ kind: 'text', text: 'irrelevant' });
    };
    const citation: Citation = { raw: '`id_rsa:1`', path: 'id_rsa', line: 1 };
    const result = await buildCitedContext([citation], reader);
    expect(result.unresolved[0]?.reason).toContain('refused');
    expect(readCalled).toBe(false);
  });

  // End to end: the extraction grammar itself, then the refusal, on the
  // exact shape the vulnerability report described (a dotfile nested under
  // a directory, cited with a line number).
  it('extracts but then refuses a citation of a dotfile with a disallowed extension, end to end', async () => {
    const diff = diffOf('+See `config/.env:3` for the value used in production.');
    const citations = extractCitations(diff);
    expect(citations).toHaveLength(1);
    const result = await buildCitedContext(
      citations,
      fakeReader({ 'config/.env': 'SECRET=abc123' }),
    );
    expect(result.regions).toEqual([]);
    expect(result.unresolved[0]?.reason).toContain('refused');
  });

  // A `refused` result from the READER (layers 2/3, readers.ts -- untracked
  // or a symlink escape) must be passed through to `unresolved` verbatim,
  // exactly like a layer-1 refusal from this module's own pathSafety.
  it('passes a reader-level refusal (layers 2/3) through to unresolved verbatim, without reading further', async () => {
    const reader: CitationFileReader = () =>
      Promise.resolve({
        kind: 'refused',
        reason: 'refused — this path is not tracked in the repository’s git index',
      });
    const citation: Citation = { raw: '`f.ts:1`', path: 'f.ts', line: 1 };
    const result = await buildCitedContext([citation], reader);
    expect(result.regions).toEqual([]);
    expect(result.unresolved).toEqual([
      { citation, reason: 'refused — this path is not tracked in the repository’s git index' },
    ]);
  });

  it('reports a missing file as unresolved, naming the reason', async () => {
    const citation: Citation = { raw: '`gone.ts:1`', path: 'gone.ts', line: 1 };
    const result = await buildCitedContext([citation], fakeReader({}));
    expect(result.unresolved[0]?.reason).toContain('ENOENT');
  });
});

describe('buildCitedContext — the budget, and never truncating silently', () => {
  it('omits a region, naming it, when including it would exceed the budget', async () => {
    const file = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const citations: Citation[] = [
      { raw: '`a.ts:10`', path: 'a.ts', line: 10 },
      { raw: '`b.ts:10`', path: 'b.ts', line: 10 },
    ];
    const reader = fakeReader({ 'a.ts': file, 'b.ts': file });
    // A budget large enough for exactly one region's text, not two.
    const firstRegionSize = (await buildCitedContext([citations[0] as Citation], reader)).regions[0]
      ?.text.length;
    const budget = (firstRegionSize ?? 0) + 5;

    const result = await buildCitedContext(citations, reader, budget);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.citation.raw).toBe('`a.ts:10`');
    expect(result.omitted).toEqual([citations[1]]);
  });

  it('clips a cited range too large to include whole, and says so', async () => {
    const file = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const citation: Citation = { raw: '`a.ts:1-300`', path: 'a.ts', line: 1, endLine: 300 };
    const result = await buildCitedContext([citation], fakeReader({ 'a.ts': file }));
    expect(result.regions).toHaveLength(1);
    const [region] = result.regions;
    expect(region?.clipped).toBe(true);
    expect(region?.totalLinesInCitedRange).toBe(300); // 1..300, already at file bounds
    expect((region?.endLine ?? 0) - (region?.startLine ?? 0) + 1).toBe(120);
  });

  it('exports a default budget large enough to hold several full-sized regions, not merely a positive number', async () => {
    const file = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const citation: Citation = { raw: '`a.ts:1-300`', path: 'a.ts', line: 1, endLine: 300 };
    const oneMaxRegion = (await buildCitedContext([citation], fakeReader({ 'a.ts': file })))
      .regions[0]?.text.length;
    // A budget that could not fit even a handful of maximally-clipped
    // regions would defeat the feature's purpose (a documentation change
    // typically cites several places). `toBeGreaterThan(0)` alone would pass
    // for a budget of 1 character, which would too.
    expect(DEFAULT_CONTEXT_BUDGET_CHARS).toBeGreaterThan((oneMaxRegion ?? 0) * 5);
  });
});

describe('renderCitedContext', () => {
  it('returns an empty string when there is nothing to report', () => {
    expect(renderCitedContext({ regions: [], unresolved: [], omitted: [] })).toBe('');
  });

  it('renders an included region with its citation and its code', async () => {
    const file = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const citation: Citation = { raw: '`a.ts:10`', path: 'a.ts', line: 10 };
    const result = await buildCitedContext([citation], fakeReader({ 'a.ts': file }));
    const rendered = renderCitedContext(result);
    expect(rendered).toContain('a.ts:');
    expect(rendered).toContain('Cited as `a.ts:10`.');
    expect(rendered).toContain('line 10');
  });

  it('lists an unresolved citation with its reason, not silently', () => {
    const rendered = renderCitedContext({
      regions: [],
      unresolved: [
        { citation: { raw: '`docs/x.md`', path: 'docs/x.md' }, reason: 'no line or symbol' },
      ],
      omitted: [],
    });
    expect(rendered).toContain('docs/x.md');
    expect(rendered).toContain('no line or symbol');
    expect(rendered).toContain('1 citation(s) with no region');
  });

  it('lists an omitted citation by name, distinctly from unresolved', () => {
    const rendered = renderCitedContext({
      regions: [],
      unresolved: [],
      omitted: [{ raw: '`b.ts:10`', path: 'b.ts', line: 10 }],
    });
    expect(rendered).toContain('1 region(s) omitted');
    expect(rendered).toContain('budget');
    expect(rendered).toContain('`b.ts:10`');
  });
});
