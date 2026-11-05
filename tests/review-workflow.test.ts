// Pins the SHAPE of .github/workflows/review.yml: the properties that make it
// safe to call from other repositories. Text-level on purpose (no YAML
// dependency): it catches the regressions that matter, not every possible one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');

/** The bodies of every `run: |` block (and single-line `run:`), comments excluded. */
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

  it('pins the reviewer exactly, once, and installs it safely outside the repo', () => {
    expect(text.match(/@verevoir\/review@\d+\.\d+\.\d+/g)).toEqual(['@verevoir/review@0.3.0']);
    expect(text).toContain("REVIEWER_PACKAGE: '@verevoir/review@0.3.0'");
    const install = runBodies(text).find((b) => b.includes('npm install'));
    expect(install).toBeDefined();
    expect(install).toContain('--ignore-scripts');
    expect(install).toContain('--no-save');
    expect(install).toContain('--no-package-lock');
    expect(install).toContain('--prefix "${RUNNER_TEMP}/aigency-review"');
  });

  it('runs nothing from the pull request tree', () => {
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

  it('ends the checks file with the deliberate-omission line', () => {
    expect(text).toContain(
      'Omitted deliberately: review checks are not listed here, because this file is input to a review.',
    );
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
});
