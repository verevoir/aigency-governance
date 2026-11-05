// Pins the SHAPE of .github/workflows/review.yml: the properties that make it
// safe to call from other repositories. Text-level on purpose (no YAML
// dependency): it catches the regressions that matter, not every possible one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');

/** The bodies of every `run: |` block (and single-line `run:`). Shell comment lines inside them are included. */
function runBodies(source: string): string[] {
  const lines = source.split('\n');
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i] as string);
    if (m === null) continue;
    const indent = (m[1] as string).length;
    const body: string[] = [];
    if ((m[2] as string) !== '|' && (m[2] as string) !== '>-' && (m[2] as string) !== '>') {
      body.push(m[2] as string);
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    bodies.push(body.join('\n'));
  }
  return bodies;
}

describe('review.yml shape', () => {
  it('has run: blocks to check', () => {
    expect(runBodies(text).length).toBeGreaterThan(3);
  });

  it('never expands a github.event value inside run:', () => {
    for (const body of runBodies(text)) {
      expect(body).not.toMatch(/\$\{\{\s*github\.event/);
    }
  });

  it('never expands any ${{ }} inside run:', () => {
    for (const body of runBodies(text)) {
      expect(body).not.toContain('${{');
    }
  });

  it('routes the title and body through env:', () => {
    expect(text).toMatch(/PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
    expect(text).toMatch(/PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  });

  it('pins the reviewer exactly, once', () => {
    expect(text.match(/@verevoir\/review@\d+\.\d+\.\d+/g)).toEqual(['@verevoir/review@0.3.2']);
    expect(text).toContain("REVIEWER_PACKAGE: '@verevoir/review@0.3.2'");
  });

  it('installs the reviewer with no scripts, no save, no lockfile, under --prefix', () => {
    const install = runBodies(text).find((b) => b.includes('npm install'));
    expect(install).toBeDefined();
    expect(install).toContain('--ignore-scripts');
    expect(install).toContain('--no-save');
    expect(install).toContain('--no-package-lock');
    expect(install).toContain('--prefix "${RUNNER_TEMP}/aigency-review"');
  });

  it('has exactly one npm invocation, and it installs under --prefix', () => {
    const npmBodies = runBodies(text).filter((b) => /\bnpm\b/.test(b));
    expect(npmBodies).toHaveLength(1);
    expect(npmBodies[0]).toContain('--prefix');
  });

  it('runs the install and the reviewer with cwd outside the PR checkout', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    for (const marker of ['npm install', 'aigency-review/node_modules/.bin/aigency-review']) {
      const step = steps.find((s) => s.includes(marker));
      expect(step, marker).toBeDefined();
      expect(step).toMatch(/\n {8}working-directory: \$\{\{ runner\.temp \}\}\n/);
      expect(step).not.toMatch(/working-directory:.*(github\.workspace|GITHUB_WORKSPACE)/);
    }
    // No step may point its cwd at the workspace.
    expect(text).not.toMatch(/working-directory:.*workspace/i);
  });

  it('pins every third-party action to a 40-hex commit SHA', () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1] as string);
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const u of uses) {
      if (u.startsWith('./')) continue;
      const ref = u.split('@')[1];
      expect(ref, u).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('has a 20 minute timeout', () => {
    expect(text).toMatch(/^ {4}timeout-minutes: 20$/m);
  });

  it('declares exactly contents: read and checks: read', () => {
    const block = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(text);
    expect(block).not.toBeNull();
    const entries = (block?.[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter((l) => l !== '');
    expect(entries.sort()).toEqual(['checks: read', 'contents: read']);
  });

  it('appends the deliberate-omission line to the checks file, last', () => {
    const body = runBodies(text).find((b) => b.includes('check-runs'));
    expect(body).toBeDefined();
    const line =
      'Omitted deliberately: review checks are not listed here, because this file is input to a review.';
    expect(body).toContain(`echo "${line}"`);
    // Order: the gh api write (`> checks.txt`) comes first, then the omission
    // line's append (`>> checks.txt`) after it, and no write follows that.
    const script = body as string;
    const writes = [...script.matchAll(/(>>?) "\$\{RUNNER_TEMP\}\/checks\.txt"/g)];
    expect(writes.map((w) => w[1])).toEqual(['>', '>>']);
    const ghWrite = (writes[0]?.index ?? -1) as number;
    const omissionWrite = (writes[1]?.index ?? -1) as number;
    expect(script.indexOf('check-runs')).toBeLessThan(ghWrite);
    expect(script.indexOf(line)).toBeGreaterThan(ghWrite);
    expect(script.indexOf(line)).toBeLessThan(omissionWrite);
  });

  it('filters only the review checks themselves, with an anchored pattern', () => {
    expect(text).toContain(
      'test("^(review|review / review|antagonistic[- ]review.*|review \\\\(.*\\\\))$"; "i")',
    );
    expect(text).not.toContain('test("review"; "i")');
  });

  it('a COPY of the filter regex (tied to the workflow by the text pin above) matches review checks and spares unrelated ones', () => {
    // The regex jq receives, after YAML/shell/jq unescaping.
    const re = /^(review|review \/ review|antagonistic[- ]review.*|review \(.*\))$/i;
    for (const name of [
      'review',
      'review / review',
      'antagonistic-review',
      'review (correctness)',
      'Antagonistic review',
    ]) {
      expect(re.test(name), name).toBe(true);
    }
    for (const name of ['verify', 'preview-deploy', 'code review lint']) {
      expect(re.test(name), name).toBe(false);
    }
  });

  it('lists the checks file in the job summary under its heading', () => {
    expect(text).toContain('### Checks given to the reviewer');
    expect(text).toContain('cat "${RUNNER_TEMP}/checks.txt"');
  });

  it('also prints the checks file to the job log, inside a group', () => {
    const body = runBodies(text).find((b) => b.includes('### Checks given to the reviewer'));
    expect(body).toBeDefined();
    const script = body as string;
    const start = script.indexOf('::group::Checks given to the reviewer');
    const end = script.indexOf('::endgroup::');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(script.slice(start, end)).toContain('cat "${RUNNER_TEMP}/checks.txt"');
  });

  it('header words SHA pinning as a requirement ("should") and says the PR tree is only read', () => {
    // Whitespace-insensitive, and comment markers ignored, so a rewrap is safe.
    const flat = text.replace(/\n\s*#/g, ' ').replace(/\s+/g, ' ');
    expect(flat).toContain('Callers should pin this workflow');
    expect(flat).not.toContain('Callers pin this workflow');
    expect(flat).toContain("The pull request's tree is only READ");
    expect(flat).not.toContain('nothing from the pull request');
  });

  it('Note a missing report uses -s; Take the verdict treats anything but a positive Rejected as could-not-run', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    const note = steps.find((s) => s.includes('Note a missing report'));
    const verdict = steps.find((s) => s.includes('Take the verdict'));
    expect(note).toBeDefined();
    expect(verdict).toBeDefined();
    expect(note).toContain('[ ! -s "${RUNNER_TEMP}/review.md" ]');
    expect(verdict).toContain('[ -s "${RUNNER_TEMP}/review.md" ]');
    expect(verdict).not.toContain('-f ');
    expect(verdict).toContain('could not run');
  });

  it('Take the verdict reports did-not-approve only for a positive Rejected heading', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    const verdict = steps.find((s) => s.includes('Take the verdict')) as string;
    expect(verdict).toBeDefined();
    const script = verdict
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(script).toMatch(
      /if \[ -s "\$\{RUNNER_TEMP\}\/review\.md" \] && grep -q '\^## Review: Rejected' /,
    );
    // The positive branch says "did not approve"; the else branch (anything
    // else, including Could not run, empty, unrecognised) says "could not run".
    const thenPart = script.slice(script.indexOf('then'), script.indexOf('else'));
    const elsePart = script.slice(script.indexOf('else'));
    expect(thenPart).toContain('did not approve');
    expect(thenPart).not.toContain('could not run');
    expect(elsePart).toContain('could not run');
    expect(elsePart).not.toContain('did not approve');
    // Every path exits 1.
    expect(script).toMatch(/fi\n\s+exit 1/);
    // No negative match on the Could not run heading any more.
    expect(script).not.toContain('Could not run');
  });

  it('passes the derived-lens inputs to the CLI', () => {
    expect(text).toContain('--practices');
    expect(text).toContain('corpus/practices');
    expect(text).toContain('--checks-file');
    expect(text).toContain('--description-file');
    expect(text).toContain('--context-root "${GITHUB_WORKSPACE}"');
  });

  it('stays callable by existing callers', () => {
    expect(text).toMatch(/governance-ref:/);
    expect(text).toMatch(/\bmodel:/);
    // Each secret's own block, so one secret's `required: true` can't satisfy another.
    const secretBlock = (name: string): string =>
      new RegExp(`^ {6}${name}:\\n((?: {8}.*\\n)+)`, 'm').exec(text)?.[1] ?? '';
    expect(secretBlock('anthropic-api-key')).toMatch(/^ {8}required: true$/m);
    // Optional, so a missing one fails fast by name rather than as a startup failure.
    expect(secretBlock('guardrails-app-private-key')).toMatch(/^ {8}required: false$/m);
    // Still accepted, but unused.
    expect(secretBlock('governance-token')).toMatch(/^ {8}required: false$/m);
    expect(secretBlock('governance-token')).toContain('No longer used');
    expect(text).toMatch(/guardrails-ref:/);
  });

  it('defaults guardrails-app-client-id to the App Client ID', () => {
    const block = /^ {6}guardrails-app-client-id:\n((?: {8}.*\n)+)/m.exec(text)?.[1] ?? '';
    expect(block).toMatch(/^ {8}type: string$/m);
    expect(block).toMatch(/^ {8}default: 'Iv23lid18mHn32QW1lbL'$/m);
  });

  it('references no secrets.governance-token anywhere', () => {
    expect(text).not.toMatch(/secrets\.governance-token/);
    expect(text).not.toContain('GOVERNANCE_TOKEN');
  });

  it('fails fast on an empty guardrails-app-private-key, through env:, naming the secret to map', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    const step = steps.find((s) => s.includes('Confirm the key is available'));
    expect(step).toBeDefined();
    expect(step).toMatch(
      /\n {10}GUARDRAILS_APP_PRIVATE_KEY: \$\{\{ secrets\.guardrails-app-private-key \}\}\n/,
    );
    expect(step).toContain('[ -z "${GUARDRAILS_APP_PRIVATE_KEY}" ]');
    expect(step).toContain('guardrails-app-private-key is empty');
    expect(step).toContain('GUARDRAILS_APP_PRIVATE_KEY');
    expect(step).toContain('governance-token is no longer used');
    // The value is never printed.
    expect(step).not.toMatch(/echo[^\n]*\$\{?GUARDRAILS_APP_PRIVATE_KEY[^\n]*\n/);
    expect(step).not.toContain('${#GUARDRAILS_APP_PRIVATE_KEY');
  });

  it('pins create-github-app-token by a full SHA with a version comment', () => {
    expect(text).toMatch(/uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
  });

  it('mints the corpus token with exactly the expected inputs', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    const step = steps.find((s) => s.includes('create-github-app-token')) as string;
    expect(step).toBeDefined();
    expect(step).toMatch(/\n {8}id: corpus-token\n/);
    const withBlock = /\n {8}with:\n((?: {10}.+\n?)+)/.exec(step)?.[1] ?? '';
    const entries = withBlock
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.trim());
    expect(entries.sort()).toEqual(
      [
        'client-id: ${{ inputs.guardrails-app-client-id }}',
        'owner: verevoir',
        'permission-contents: read',
        'private-key: ${{ secrets.guardrails-app-private-key }}',
        'repositories: aigency-guardrails',
      ].sort(),
    );
    // Revoked when the job ends: never opted out.
    expect(step).not.toContain('skip-token-revoke');
  });

  it('mints the token immediately before the corpus checkout', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    const mint = steps.findIndex((s) => s.includes('create-github-app-token'));
    const fetch = steps.findIndex((s) => s.includes('repository: verevoir/aigency-guardrails'));
    expect(mint).toBeGreaterThan(-1);
    expect(fetch).toBe(mint + 1);
  });

  it('reads the guardrails corpus with the App token, without persisting it', () => {
    const step = /repository: verevoir\/aigency-guardrails\n(?: {10}.+\n)+/.exec(text);
    expect(step).not.toBeNull();
    expect(step?.[0]).toContain('token: ${{ steps.corpus-token.outputs.token }}');
    expect(step?.[0]).toMatch(/^ {10}persist-credentials: false$/m);
  });

  it('gives the App token to no other step', () => {
    expect(text.match(/steps\.corpus-token/g)).toHaveLength(1);
    expect(text.match(/secrets\.guardrails-app-private-key/g)).toHaveLength(2);
  });
});

describe('review-pr.yml wiring', () => {
  const caller = readFileSync(
    new URL('../.github/workflows/review-pr.yml', import.meta.url),
    'utf8',
  );

  it('passes secrets.GOVERNANCE_TOKEN, not GITHUB_TOKEN, as governance-token', () => {
    expect(caller).toMatch(/^ {6}governance-token: \$\{\{ secrets\.GOVERNANCE_TOKEN \}\}$/m);
    expect(caller).not.toMatch(/governance-token: \$\{\{ secrets\.GITHUB_TOKEN/);
  });

  it('calls review.yml from main, not from the PR commit', () => {
    expect(caller).toMatch(
      /^ {4}uses: verevoir\/aigency-governance\/\.github\/workflows\/review\.yml@main$/m,
    );
    expect(caller).not.toContain('./.github/workflows/review.yml');
  });

  it('passes no governance-ref and no PR-derived head expression', () => {
    const code = caller
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/^\s*with:/m);
    expect(code).not.toContain('governance-ref');
    expect(code).not.toContain('github.event.pull_request.head');
  });

  it('grants every permission review.yml requests, at the same or higher level', () => {
    const rank: Record<string, number> = { none: 0, read: 1, write: 2 };
    const parse = (source: string, indent: number): Record<string, string> => {
      const pad = ' '.repeat(indent);
      const re = new RegExp(`^${pad}permissions:\\n((?:${pad}  .+\\n)+)`, 'm');
      const block = re.exec(source);
      const out: Record<string, string> = {};
      for (const line of (block?.[1] ?? '').split('\n')) {
        const m = /^\s*([a-z-]+):\s*([a-z]+)\s*(?:#.*)?$/.exec(line);
        if (m !== null) out[m[1] as string] = m[2] as string;
      }
      return out;
    };
    const required = parse(text, 4);
    const granted = parse(caller, 4);
    expect(Object.keys(required).length).toBeGreaterThan(0);
    const missing = Object.entries(required)
      .filter(([name, level]) => (rank[granted[name] ?? 'none'] ?? 0) < (rank[level] ?? 0))
      .map(([name, level]) => `${name}: ${level} (caller grants ${granted[name] ?? 'nothing'})`);
    expect(missing, `review-pr.yml's review job is missing: ${missing.join(', ')}`).toEqual([]);
  });
});
