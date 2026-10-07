// Making a documentation-only diff reviewable, by including the code its
// claims cite. See this commit's own message for the motivating case
// (verevoir/aigency-harness#118) and why the citation forms below were read
// from real documents rather than invented.
//
// SCOPE, DELIBERATELY NARROW. This reads citations out of a diff's own
// ADDED lines and resolves them against the working tree the reviewer
// process is running in (the reviewed repository's checkout — see
// citationFileReader in readers.ts and cli/review.ts for where that is
// wired). It does NOT generalise to "what calls this" or "what depends on
// this" for an ordinary code diff — that direction was scoped, not built:
// a citation is something a document's own prose names explicitly, and
// resolving it needs nothing more than reading a path (and, at most, a
// string search for a symbol name) — no call graph, no dependency
// analysis. Generalising to callers/dependents is a real, separate piece
// of work with its own risk of pulling in far more than "err small" would
// allow, and is out of scope here.
//
// A NOTE ON PATH SAFETY — THREE LAYERS, NOT ONE, AFTER A REAL FINDING.
// `path` comes from the diff — attacker-controlled on any repository taking
// outside pull requests, the same trust boundary `redact` in anthropic.ts
// exists for. An earlier version of this module refused only an absolute
// path or a `..` segment, which a review of this PR's own diff (the
// blast-radius lens, blocking) found insufficient: a documentation-only
// pull request could cite `.env`, a checked-in key file, or `.git/config`
// — none of which is absolute or contains `..` — and have its contents
// read and forwarded to the external model call. Fixed with an ALLOWLIST,
// not a wider denylist, on the operator's explicit instruction: a denylist
// fails open on the first pattern nobody thought of.
//
//   1. EXTENSION ALLOWLIST (`pathSafety`, here — pure, synchronous, no I/O).
//      `path` must end in one of `ALLOWED_EXTENSIONS`: the file types a
//      documentation claim could sensibly be about. This alone stops most
//      secret files outright — `.git/config` has no extension at all, and
//      a nested `.env` (`config/.env`) resolves to extension `env`, not in
//      the list.
//   2. TRACKED-IN-GIT (`citationFileReader`, readers.ts — needs real I/O).
//      `path` must be a member of the repository's own `git ls-files`
//      output, computed once per run and passed in. A file that exists on
//      disk but is (correctly) gitignored is refused here even if some
//      future extension addition happened to let it past layer 1.
//   3. NO SYMLINK ESCAPE (`citationFileReader`, readers.ts — needs real
//      I/O). `path`'s real, symlink-resolved target must sit inside the
//      checkout's own real root. A tracked symlink pointing outside the
//      checkout is refused even though the symlink file itself passed
//      layers 1 and 2.
//
// All three layers report a refusal with a reason beginning "refused —",
// never silently — so a reader of the rendered context can always tell
// "we would not fetch this" from "this was not there" (a `missing` reason).

/**
 * One citation, extracted from a diff's added lines. `line`/`endLine` and
 * `symbol` are mutually exclusive by construction — see `extractCitations`
 * — and both may be absent, which is the bare-path case: a file was named
 * and no region was.
 */
export interface Citation {
  /** The citation exactly as it appeared, backticks and all — what a
   * reader of the rendered context needs to find it again in the document. */
  readonly raw: string;
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly symbol?: string;
}

interface RawSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function backtickSpans(line: string): RawSpan[] {
  const spans: RawSpan[] = [];
  const pattern = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    spans.push({ text: match[1] ?? '', start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

// A path token: word characters, dot, slash, dash — deliberately not
// unicode-aware or exhaustive, matched against what real paths in this
// estate's repositories actually look like. Requires an extension (at
// least one dot followed by 1–10 alphanumerics) so an ordinary inline-code
// WORD in backticks — `refused`, `claude-cli` — never matches: neither
// carries a dot, so neither is mistaken for a path.
const PATH_WITH_LINE = /^([\w./-]+\.[A-Za-z0-9]{1,10}):(\d+)(?:-(\d+))?$/;
const PATH_ONLY = /^([\w./-]+\.[A-Za-z0-9]{1,10})$/;
const SYMBOL_ONLY = /^[A-Za-z_$][\w$]*$/;

/**
 * The only file types a citation may resolve to reading — layer 1 of the
 * path-safety defence, see the file header. Deliberately an ALLOWLIST, not
 * a denylist that tries to name every secret-shaped file: source code and
 * documentation types a claim about "the code" could plausibly cite.
 * Conspicuously absent, and deliberately so: anything with no extension at
 * all (`.env` at the top of a path, most credential files, `Dockerfile`),
 * and credential/config extensions (`.pem`, `.key`, `.crt`, `.p12`, `.pfx`,
 * `.ini`, `.cfg`, `.conf`, `.env`) this project has no legitimate reason to
 * quote into a review prompt.
 */
const ALLOWED_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'md',
  'mdx',
  'yml',
  'yaml',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cxx',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'sql',
  'proto',
  'graphql',
  'gql',
  'toml',
  'xml',
]);

function extensionOf(path: string): string | undefined {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(path);
  return match?.[1]?.toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract every citation from a diff's ADDED lines — never from removed or
 * unchanged context lines, and never from a `+++ b/path` diff header,
 * which also starts with `+` but names the file the hunk touches, not a
 * claim inside it.
 *
 * Deduplicated by the exact citation text (`raw`): the same citation
 * repeated across several new lines is one region to fetch, not several.
 * Order is first-seen, so `renderCitedContext`'s output reads in the order
 * a reviewer would meet the citations in the document.
 */
export function extractCitations(diff: string): readonly Citation[] {
  const seen = new Map<string, Citation>();

  for (const rawLine of diff.split('\n')) {
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) {
      continue;
    }
    const content = rawLine.slice(1);
    const spans = backtickSpans(content);

    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      if (span === undefined) {
        continue;
      }

      const lineMatch = PATH_WITH_LINE.exec(span.text);
      if (lineMatch) {
        const path = lineMatch[1] ?? '';
        const line = Number(lineMatch[2]);
        const endLine = lineMatch[3] !== undefined ? Number(lineMatch[3]) : undefined;
        const citation: Citation = {
          raw: `\`${span.text}\``,
          path,
          line,
          ...(endLine !== undefined ? { endLine } : {}),
        };
        if (!seen.has(citation.raw)) {
          seen.set(citation.raw, citation);
        }
        continue;
      }

      const pathOnlyMatch = PATH_ONLY.exec(span.text);
      if (!pathOnlyMatch) {
        continue;
      }
      const path = pathOnlyMatch[1] ?? '';

      // Look for the `'s `Symbol`` form immediately following this span —
      // the one #118 actually uses throughout. Only recognised when the
      // apostrophe-s sits directly against the closing backtick with no
      // other text between the two spans, so this cannot mismatch two
      // citations that merely happen to sit near each other in the same
      // sentence.
      const next = spans[i + 1];
      const between = content.slice(span.end, next?.start ?? span.end);
      if (next !== undefined && between === "'s " && SYMBOL_ONLY.test(next.text)) {
        const citation: Citation = {
          raw: `\`${span.text}\`'s \`${next.text}\``,
          path,
          symbol: next.text,
        };
        if (!seen.has(citation.raw)) {
          seen.set(citation.raw, citation);
        }
        i += 1; // the symbol span belongs to this citation, not its own
        continue;
      }

      const citation: Citation = { raw: `\`${span.text}\``, path };
      if (!seen.has(citation.raw)) {
        seen.set(citation.raw, citation);
      }
    }
  }

  return [...seen.values()];
}

/**
 * Layer 1 of the path-safety defence — see the file header. Pure and
 * synchronous: no filesystem access, so this cannot itself be fooled by a
 * symlink or an untracked file — those are layers 2 and 3, enforced in
 * readers.ts's `citationFileReader`, which is the only place with the I/O
 * to check them.
 *
 * Returns the specific reason for a refusal rather than a bare boolean: an
 * earlier version collapsed "absolute path" and "traversal segment" into
 * one fixed message, and a review of this file found that collapse itself
 * a defect — a reader of the unresolved list could not tell which check
 * had actually failed for a given citation.
 */
function pathSafety(
  path: string,
): { readonly safe: true } | { readonly safe: false; readonly reason: string } {
  if (path.startsWith('/')) {
    return {
      safe: false,
      reason:
        'refused — absolute paths are not permitted; a citation must name a path inside the ' +
        'reviewed repository',
    };
  }
  if (path.split('/').some((segment) => segment === '..')) {
    return { safe: false, reason: 'refused — path traversal ("..") is not permitted' };
  }
  const extension = extensionOf(path);
  if (extension === undefined || !ALLOWED_EXTENSIONS.has(extension)) {
    return {
      safe: false,
      reason:
        `refused — ${extension === undefined ? 'this path has no recognised file extension' : `".${extension}" is not one of the file types this mechanism will read`} ` +
        '(see ALLOWED_EXTENSIONS in citations.ts); this refusal is independent of whether the ' +
        'file exists or what it contains',
    };
  }
  return { safe: true };
}

/**
 * Reads one file's full text for citation resolution. `missing` covers
 * every reason a read failed for a path that passed layer 1 — not found,
 * unreadable, a directory. `refused` covers layers 2 and 3, which need
 * real I/O this module deliberately stays free of — see the file header
 * and readers.ts's `citationFileReader` for what those check.
 */
export type CitationFileReader = (
  path: string,
) => Promise<
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
>;

/** One citation, resolved to an actual region of a real file. */
export interface CitedRegion {
  readonly citation: Citation;
  /** 1-based, inclusive — the padded window actually included, not merely
   * the line(s) the citation named. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  /** True when the padded window was cut down to fit MAX_REGION_LINES —
   * see the file header's budget rule: a clip is always disclosed, never
   * silent. */
  readonly clipped: boolean;
  /** Present only when `clipped` — how many lines the padded window would
   * have been before clipping. */
  readonly totalLinesInCitedRange?: number;
}

/** A citation that named no fetchable region, or named one this module
 * could not resolve — always with a reason, never silently dropped. */
export interface UnresolvedCitation {
  readonly citation: Citation;
  readonly reason: string;
}

export interface CitedContextResult {
  readonly regions: readonly CitedRegion[];
  readonly unresolved: readonly UnresolvedCitation[];
  /** Would have resolved, but including it would have exceeded the budget.
   * Kept apart from `unresolved`: this is a real citation this module chose
   * not to include, not one it could not read. */
  readonly omitted: readonly Citation[];
}

/** Lines of context padded around a cited line or a located symbol. Small
 * on purpose — "err small": this buys a reader enough to see the shape of
 * the code, not a whole function or file. */
const CONTEXT_PAD_LINES = 8;

/** The most one region will ever contribute, regardless of how large the
 * cited range was — a citation of `file.ts:10-800` does not get to spend
 * the whole budget on one region. Clipping past this is always disclosed;
 * see `CitedRegion.clipped`. */
const MAX_REGION_LINES = 120;

/** Total characters this module will include across every region in one
 * run. A lens panel sends this once, in the shared half (prompt.ts),
 * so this budget is paid once per review, not once per lens — but it is
 * still a real cost added on top of the diff and the bar, and "err small"
 * applies to the total as much as to any one region. */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 20_000;

/**
 * Resolve every citation to a region, respecting the budget.
 *
 * Never throws for a PER-CITATION failure: a read failure, a refused path,
 * a missing symbol, an out-of-range line, or a budget miss all land in
 * `unresolved` or `omitted` rather than aborting the run — the
 * documentation case this exists for is exactly the case where "could not
 * ground one citation" must not mean "could not review at all".
 *
 * THIS DOES NOT MEAN THE FUNCTION NEVER THROWS — an earlier version of this
 * comment claimed exactly that, unqualified, which a review found false:
 * `readFile` is awaited directly below with no try/catch around the call
 * itself, so a SYSTEMIC failure from the injected reader propagates
 * straight through. `citationFileReader`'s own resolved repository root is
 * exactly this case (see readers.ts's `TrackedFilesUnavailableError` and
 * `resolveRealRoot` comments): when the checkout's own root cannot be
 * resolved, that is not "this one file is unreadable" — it is "nothing
 * here could be checked for any citation" — and it deliberately reaches
 * this function's caller as a thrown error rather than being silently
 * absorbed into every citation's own `unresolved` entry as though each had
 * failed independently.
 */
export async function buildCitedContext(
  citations: readonly Citation[],
  readFile: CitationFileReader,
  budgetChars: number = DEFAULT_CONTEXT_BUDGET_CHARS,
): Promise<CitedContextResult> {
  const regions: CitedRegion[] = [];
  const unresolved: UnresolvedCitation[] = [];
  const omitted: Citation[] = [];
  let used = 0;

  for (const citation of citations) {
    const safety = pathSafety(citation.path);
    if (!safety.safe) {
      unresolved.push({ citation, reason: safety.reason });
      continue;
    }

    if (citation.line === undefined && citation.symbol === undefined) {
      unresolved.push({
        citation,
        reason: 'cited with no line or symbol — no specific region to include',
      });
      continue;
    }

    const found = await readFile(citation.path);
    if (found.kind === 'refused') {
      // Layer 2/3 refusal from the real reader (readers.ts) — untracked, or
      // resolves outside the checkout via a symlink. Passed straight
      // through: it already carries its own "refused —" reason, and this
      // module has nothing to add to it.
      unresolved.push({ citation, reason: found.reason });
      continue;
    }
    if (found.kind === 'missing') {
      // Not necessarily "not found" — EISDIR and ENOTDIR land here too (see
      // citationFileReader's own doc comment in readers.ts). The reason
      // names the real failure code either way, so this prefix stays
      // neutral rather than asserting the specific cause "not found" for
      // every case that reaches it.
      unresolved.push({
        citation,
        reason: `could not read the cited file: ${found.reason}`,
      });
      continue;
    }

    const lines = found.text.split('\n');
    let targetStart: number;
    let targetEnd: number;

    if (citation.line !== undefined) {
      targetStart = citation.line;
      targetEnd = citation.endLine ?? citation.line;
      if (targetStart < 1 || targetStart > lines.length) {
        unresolved.push({
          citation,
          reason: `cited line ${String(targetStart)} is outside the file (${String(lines.length)} line(s) long)`,
        });
        continue;
      }
    } else {
      // citation.symbol is defined here — the branch above ruled out both
      // being absent, and PATH_WITH_LINE citations always set `line`.
      const symbol = citation.symbol ?? '';
      const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
      const index = lines.findIndex((candidate) => pattern.test(candidate));
      if (index === -1) {
        unresolved.push({
          citation,
          reason:
            `symbol "${symbol}" was not found in the cited file — a string search, not a ` +
            'parse, so a symbol split across lines or reached only via a re-export will miss',
        });
        continue;
      }
      targetStart = index + 1;
      targetEnd = index + 1;
    }

    const paddedStart = Math.max(1, targetStart - CONTEXT_PAD_LINES);
    const paddedEnd = Math.min(lines.length, targetEnd + CONTEXT_PAD_LINES);
    const totalLines = paddedEnd - paddedStart + 1;
    const clipped = totalLines > MAX_REGION_LINES;
    const includedEnd = clipped ? paddedStart + MAX_REGION_LINES - 1 : paddedEnd;
    const text = lines.slice(paddedStart - 1, includedEnd).join('\n');

    if (used + text.length > budgetChars) {
      omitted.push(citation);
      continue;
    }
    used += text.length;

    regions.push({
      citation,
      startLine: paddedStart,
      endLine: includedEnd,
      text,
      clipped,
      ...(clipped ? { totalLinesInCitedRange: totalLines } : {}),
    });
  }

  return { regions, unresolved, omitted };
}

/**
 * Render a `CitedContextResult` as the section a lens actually reads.
 * Returns `''` — not a heading over nothing — when there was nothing to
 * say at all, so `buildPrompt` (prompt.ts) can skip the section entirely
 * on an ordinary code diff with no citations, the common case this must
 * not clutter.
 *
 * Each of the three lists gets its own section WHEN IT HAS SOMETHING TO
 * SAY — an earlier version of this comment claimed all three "are
 * rendered, always," which a review found false: `unresolved` and
 * `omitted` are each gated on `.length > 0`, so a run with nothing
 * unresolved and nothing omitted produces neither section, correctly,
 * rather than an empty one. The property that actually holds: a reader
 * never sees ONLY the included regions while something was silently
 * dropped — if anything was omitted or left unresolved, its section says
 * so.
 */
export function renderCitedContext(result: CitedContextResult): string {
  const { regions, unresolved, omitted } = result;
  if (regions.length === 0 && unresolved.length === 0 && omitted.length === 0) {
    return '';
  }

  const lines: string[] = [
    'This change cites the code below. A claim about code the reviewer cannot ' +
      'see cannot be checked, so every citation the diff makes — in its own ' +
      'added lines — is resolved here against the actual file, where a ' +
      'specific region was named. Judge each cited claim against what the code ' +
      'below actually does, not against the prose alone.',
    '',
  ];

  for (const region of regions) {
    const where =
      region.citation.line !== undefined
        ? `${region.citation.path}:${String(region.startLine)}-${String(region.endLine)}`
        : `${region.citation.path}:${String(region.startLine)}-${String(region.endLine)} ` +
          `(located by symbol, not cited with a line)`;
    lines.push(`### ${where}`, '', `Cited as ${region.citation.raw}.`);
    if (region.clipped) {
      lines.push(
        `Clipped to ${String(region.endLine - region.startLine + 1)} of ` +
          `${String(region.totalLinesInCitedRange ?? 0)} line(s) in the cited range plus padding — ` +
          'too large to include in full.',
      );
    }
    lines.push('', '```', region.text, '```', '');
  }

  if (unresolved.length > 0) {
    lines.push(
      `${String(unresolved.length)} citation(s) with no region included below:`,
      '',
      ...unresolved.map((u) => `- ${u.citation.raw} — ${u.reason}`),
      '',
    );
  }

  if (omitted.length > 0) {
    lines.push(
      `${String(omitted.length)} region(s) omitted — the context budget was exceeded before ` +
        'they could be included:',
      '',
      ...omitted.map((c) => `- ${c.raw}`),
      '',
    );
  }

  return lines.join('\n');
}
