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
    expect(text.match(/@verevoir\/review@\d+\.\d+\.\d+/g)).toEqual(['@verevoir/review@0.3.1']);
    expect(text).toContain("REVIEWER_PACKAGE: '@verevoir/review@0.3.1'");
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

  it('the filter regex matches review checks and spares unrelated ones', () => {
    // The regex jq receives, after YAML/shell/jq unescaping.
    const re = /^(review|review \/ review|antagonistic[- ]review.*|review \(.*\))$/i;
    for (const name of ['antagonistic-review', 'review (correctness)', 'Antagonistic review']) {
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

  it('treats an empty or missing report as could-not-run, with the same -s test in both steps', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    const note = steps.find((s) => s.includes('Note a missing report'));
    const verdict = steps.find((s) => s.includes('Take the verdict'));
    expect(note).toBeDefined();
    expect(verdict).toBeDefined();
    expect(note).toContain('[ ! -s "${RUNNER_TEMP}/review.md" ]');
    expect(verdict).toContain('[ ! -s "${RUNNER_TEMP}/review.md" ]');
    expect(verdict).not.toContain('-f ');
    expect(verdict).toContain('could not run');
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
    expect(text).toMatch(/anthropic-api-key:\n(?:.*\n)*?\s+required: true/);
    expect(text).toMatch(/governance-token:/);
    expect(text).toMatch(/guardrails-ref:/);
    expect(text).not.toContain('corpus-token');
  });

  it('fails fast on an empty governance-token, through env:, naming "repository secret"', () => {
    const steps = text.split(/\n {6}- /).slice(1);
    const step = steps.find((s) => s.includes('Confirm the key is available'));
    expect(step).toBeDefined();
    expect(step).toMatch(/\n {10}GOVERNANCE_TOKEN: \$\{\{ secrets\.governance-token \}\}\n/);
    expect(step).toContain('[ -z "${GOVERNANCE_TOKEN}" ]');
    expect(step).toContain('governance-token is empty');
    expect(step).toContain('repository secret');
    // The value is never printed.
    expect(step).not.toMatch(/echo[^\n]*\$\{?GOVERNANCE_TOKEN[^\n]*\n/);
    expect(step).not.toContain('${#GOVERNANCE_TOKEN');
  });

  it('reads the guardrails corpus with governance-token', () => {
    const step = /repository: verevoir\/aigency-guardrails\n(?: {10}.+\n)+/.exec(text);
    expect(step).not.toBeNull();
    expect(step?.[0]).toContain('token: ${{ secrets.governance-token }}');
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
