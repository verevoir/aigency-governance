// Pins the SHAPE of .github/workflows/review.yml: the properties that make it
// safe to call from other repositories. Text-level on purpose (no YAML
// dependency): it catches the regressions that matter, not every possible one.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(text.match(/@verevoir\/review@\d+\.\d+\.\d+/g)).toEqual(['@verevoir/review@0.3.5']);
    expect(text).toContain("REVIEWER_PACKAGE: '@verevoir/review@0.3.5'");
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
    // The Could not run heading is never matched: anything but a positive
    // Rejected falls to the could-not-run branch.
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
    expect(secretBlock('governance-token')).toMatch(/^ {8}required: true$/m);
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

// The two events a caller may trigger the review with. Steps gated by
// `if: github.event_name == '<event>'` run under that event only; every other
// step runs under both.
const EVENTS = ['pull_request', 'pull_request_target'] as const;
type ReviewEvent = (typeof EVENTS)[number];

const allSteps = text.split(/\n {6}- /).slice(1);

function stepsUnder(event: ReviewEvent): string[] {
  return allSteps.filter((step) => {
    const gate = /^ {8}if: .*github\.event_name == '([a-z_]+)'/m.exec(step);
    return gate === null || gate[1] === event;
  });
}

const isCheckout = (step: string): boolean => /uses: actions\/checkout@/.test(step);
const isCorpusCheckout = (step: string): boolean =>
  step.includes('repository: verevoir/aigency-guardrails');

function stepNamed(name: string): string {
  const step = allSteps.find((s) => s.startsWith(`name: ${name}\n`));
  expect(step, name).toBeDefined();
  return step as string;
}

/**
 * Runs one step's `run:` body the way GitHub's default shell does
 * (`bash --noprofile --norc -eo pipefail`), with only PATH and the given env.
 */
function runStep(name: string, env: Record<string, string>, cwd?: string) {
  const body = runBodies(stepNamed(name))[0] as string;
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', body], {
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
}

describe('review.yml under each event', () => {
  it('fails the first step by name for an event it cannot review', () => {
    expect(allSteps[0]).toMatch(/^name: Refuse an event this workflow cannot review\n/);
    expect(allSteps[0]).not.toMatch(/^ {8}if:/m);
    const result = runStep('Refuse an event this workflow cannot review', { EVENT_NAME: 'push' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("triggered by 'push'");
  });

  it.each(EVENTS)('lets %s through the event check', (event) => {
    const result = runStep('Refuse an event this workflow cannot review', { EVENT_NAME: event });
    expect(result.status, result.stdout).toBe(0);
  });

  it.each(EVENTS)('checks out the repository under review exactly once under %s', (event) => {
    const own = stepsUnder(event).filter((s) => isCheckout(s) && !isCorpusCheckout(s));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/^ {10}fetch-depth: 0$/m);
  });

  it('under pull_request, checks out the default ref (the merge commit)', () => {
    const [own] = stepsUnder('pull_request').filter((s) => isCheckout(s) && !isCorpusCheckout(s));
    expect(own).not.toMatch(/^ {10}ref:/m);
  });

  it("under pull_request_target, checks out the pull request's merge ref, not the base", () => {
    const [own] = stepsUnder('pull_request_target').filter(
      (s) => isCheckout(s) && !isCorpusCheckout(s),
    );
    expect(own).toMatch(
      /^ {10}ref: refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge$/m,
    );
  });

  it.each(EVENTS)('sets persist-credentials: false on every checkout under %s', (event) => {
    const checkouts = stepsUnder(event).filter(isCheckout);
    expect(checkouts.length).toBeGreaterThanOrEqual(2);
    for (const step of checkouts) {
      expect(step).toMatch(/^ {10}persist-credentials: false$/m);
    }
  });

  it.each(EVENTS)('executes nothing from the checkout under %s', (event) => {
    // The only ways the workspace may appear: as data handed to programs that
    // do not come from it.
    const allowed = [
      '--practices "${GITHUB_WORKSPACE}/.aigency-guardrails/corpus/practices"',
      '--context-root "${GITHUB_WORKSPACE}"',
      'git -C "${GITHUB_WORKSPACE}/.aigency-guardrails" rev-parse HEAD',
    ];
    for (const step of stepsUnder(event)) {
      // No local action: `uses: ./...` would run code from the checkout.
      expect(step).not.toMatch(/uses:\s*\.\//);
      for (const body of runBodies(step)) {
        const code = body
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n');
        let rest = code;
        for (const a of allowed) rest = rest.split(a).join('');
        expect(rest, step).not.toMatch(/GITHUB_WORKSPACE|github\.workspace/);
        // No relative executable, and nothing that would load a project
        // file from the cwd or source a script.
        expect(rest, step).not.toMatch(/(^|[\s;&|("'])\.\.?\//m);
        expect(rest, step).not.toMatch(
          /\b(npx|node|yarn|pnpm|bun|deno|make|python3?|ruby|perl|source)\b/,
        );
        expect(rest, step).not.toMatch(/(^\s*|[;&|]\s*)\.\s+\S/m);
        expect(rest, step).not.toMatch(/\b(ba)?sh\s+[^-\s]/);
        // The one executable invoked by path lives in RUNNER_TEMP.
        for (const m of rest.matchAll(/\/\.bin\/[\w-]+/g)) {
          const at = m.index ?? 0;
          const line = rest.slice(rest.lastIndexOf('\n', at) + 1, at);
          expect(line).toContain('${RUNNER_TEMP}/aigency-review/node_modules');
        }
      }
    }
  });

  it.each(EVENTS)('computes the diff against the base and HEAD under %s', (event) => {
    const diff = stepsUnder(event).find((s) => s.startsWith('name: Work out what changed\n'));
    expect(diff).toBeDefined();
    expect(diff).toContain('BASE_REF: ${{ github.base_ref }}');
    expect(diff).toContain('git diff --merge-base "origin/${BASE_REF}" HEAD');
  });

  it.each(EVENTS)("lists the checks of the pull request's head commit under %s", (event) => {
    const step = stepsUnder(event).find((s) => s.includes('check-runs'));
    expect(step).toContain('HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
  });

  it('uses neither github.sha nor github.ref, which name the base branch under pull_request_target', () => {
    const code = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/github\.(sha|ref|head_ref)\b/);
    expect(code).not.toMatch(/GITHUB_(SHA|REF)\b/);
  });

  describe('under pull_request_target, the merge ref must be built on the event head', () => {
    const name = "Confirm the merge ref is built on this event's head";

    it('runs only under pull_request_target, after the checkout', () => {
      expect(stepsUnder('pull_request').some((s) => s.startsWith(`name: ${name}\n`))).toBe(false);
      const prt = stepsUnder('pull_request_target');
      const at = prt.findIndex((s) => s.startsWith(`name: ${name}\n`));
      const checkoutAt = prt.findIndex((s) => isCheckout(s) && !isCorpusCheckout(s));
      expect(at).toBeGreaterThan(checkoutAt);
      expect(stepNamed(name)).toContain('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
    });

    // A real merge commit in a throwaway repository: second parent = head.
    function mergeRepo(): { dir: string; head: string; base: string } {
      const dir = mkdtempSync(join(tmpdir(), 'review-merge-ref-'));
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
        GIT_MERGE_AUTOEDIT: 'no',
      };
      const git = (...args: string[]): string =>
        execFileSync('git', args, {
          cwd: dir,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'head');
      git('commit', '-q', '--allow-empty', '-m', 'head');
      const head = git('rev-parse', 'HEAD');
      git('checkout', '-q', '--detach', base);
      git('merge', '-q', '--no-ff', '-m', 'merge', head);
      return { dir, head, base };
    }

    it("passes when the merge commit's second parent is the event head", () => {
      const { dir, head } = mergeRepo();
      try {
        const result = runStep(name, { PR_HEAD_SHA: head }, dir);
        expect(result.status, result.stdout).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails, naming both commits, when the merge ref is built on another head', () => {
      const { dir, head, base } = mergeRepo();
      try {
        const result = runStep(name, { PR_HEAD_SHA: base }, dir);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(base);
        expect(result.stdout).toContain(head);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('under pull_request_target, an outside author is reviewed only when a maintainer acts', () => {
  const gate = 'Admit the author before spending anything';
  const message = (association: string): string =>
    `review not run: outside author ${association}; a maintainer adds label review:run to run it`;

  it('declares the opt-in label input, default review:run, and reads it through env:', () => {
    const input = /^ {6}outside-author-label:\n((?: {8}.*\n)+)/m.exec(text)?.[1] ?? '';
    expect(input).toMatch(/^ {8}required: false$/m);
    expect(input).toMatch(/^ {8}default: review:run$/m);
    const step = stepNamed(gate);
    expect(step).toContain('RUN_LABEL: ${{ inputs.outside-author-label }}');
    expect(step).toContain(
      'AUTHOR_ASSOCIATION: ${{ github.event.pull_request.author_association }}',
    );
    expect(step).toContain('EVENT_ACTION: ${{ github.event.action }}');
    expect(step).toContain('ADDED_LABEL: ${{ github.event.label.name }}');
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
    'admits a %s author on any action',
    (association) => {
      const result = runStep(gate, {
        AUTHOR_ASSOCIATION: association,
        EVENT_ACTION: 'synchronize',
        ADDED_LABEL: '',
        RUN_LABEL: 'review:run',
      });
      expect(result.status, result.stdout).toBe(0);
    },
  );

  it('admits an outside author on the event of the opt-in label being added', () => {
    const result = runStep(gate, {
      AUTHOR_ASSOCIATION: 'CONTRIBUTOR',
      EVENT_ACTION: 'labeled',
      ADDED_LABEL: 'review:run',
      RUN_LABEL: 'review:run',
    });
    expect(result.status, result.stdout).toBe(0);
  });

  it.each([
    ['NONE', 'opened', ''],
    ['FIRST_TIME_CONTRIBUTOR', 'synchronize', ''],
    ['FIRST_TIMER', 'reopened', ''],
    ['CONTRIBUTOR', 'labeled', 'some-other-label'],
    // The label already on the pull request does not admit a later push.
    ['CONTRIBUTOR', 'synchronize', 'review:run'],
  ])('fails by name for a %s author on %s (label added: %j)', (association, action, added) => {
    const result = runStep(gate, {
      AUTHOR_ASSOCIATION: association,
      EVENT_ACTION: action,
      ADDED_LABEL: added,
      RUN_LABEL: 'review:run',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message(association));
  });

  it('fails closed when the label input is blank, even on a labeled event with a blank label', () => {
    const result = runStep(gate, {
      AUTHOR_ASSOCIATION: 'CONTRIBUTOR',
      EVENT_ACTION: 'labeled',
      ADDED_LABEL: '',
      RUN_LABEL: '',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('review not run: outside author CONTRIBUTOR');
  });

  it('fails closed when the author association is blank', () => {
    const result = runStep(gate, {
      AUTHOR_ASSOCIATION: '',
      EVENT_ACTION: 'opened',
      ADDED_LABEL: '',
      RUN_LABEL: 'review:run',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('review not run: outside author (none)');
  });

  it('runs under pull_request_target only, before any step that uses a secret, the token, an action or the model', () => {
    expect(stepsUnder('pull_request').some((s) => s.startsWith(`name: ${gate}\n`))).toBe(false);
    const prt = stepsUnder('pull_request_target');
    const at = prt.findIndex((s) => s.startsWith(`name: ${gate}\n`));
    expect(at).toBeGreaterThan(-1);
    const spends = (step: string): boolean => {
      const code = step
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      return /secrets\.|github\.token|uses:|\.bin\/aigency-review/.test(code);
    };
    for (const step of prt.slice(0, at + 1)) expect(spends(step), step).toBe(false);
    // The check is not vacuous: the steps after it do spend.
    expect(prt.slice(at + 1).some(spends)).toBe(true);
  });
});

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// What the stand-in reviewer prints on stderr: a line setup-node's tsc
// matcher would turn into an annotation.
const FORGED_STDERR = 'a.ts(1,1): error TS1: forged on stderr';

// Stand-in openssl for the token-minting failure modes.
const BROKEN_OPENSSL = {
  'exits non-zero': '#!/bin/sh\nexit 1\n',
  'prints nothing': '#!/bin/sh\nexit 0\n',
  // Pins the `!` half of the guard: the token is there, the status is not.
  'exits non-zero after printing a token': `#!/bin/sh\necho ${'ab'.repeat(32)}\nexit 1\n`,
} as const;

/**
 * A throwaway RUNNER_TEMP holding a stand-in reviewer and a stand-in gh, each
 * printing forged workflow commands, as a model echoing pull request text, or
 * a fork's job named to look like a command, could. `openssl` replaces the
 * real one when given. Returns the env to run a step with.
 */
function stageRunnerTemp(options: { reviewerExit?: number; openssl?: string } = {}): {
  temp: string;
  env: Record<string, string>;
} {
  const temp = mkdtempSync(join(tmpdir(), 'review-stop-commands-'));
  const reviewerBin = join(temp, 'aigency-review', 'node_modules', '.bin');
  mkdirSync(reviewerBin, { recursive: true });
  writeExecutable(
    join(reviewerBin, 'aigency-review'),
    `#!/bin/sh\ncat >/dev/null\necho '## Review: Rejected'\necho '::error title=Review::forged by the model'\necho '${FORGED_STDERR}' >&2\nexit ${options.reviewerExit ?? 0}\n`,
  );
  const tools = join(temp, 'tools');
  mkdirSync(tools);
  writeExecutable(
    join(tools, 'gh'),
    "#!/bin/sh\necho '::add-mask::forged'\necho '::error title=Review::forged check name: completed/success'\n",
  );
  if (options.openssl !== undefined) writeExecutable(join(tools, 'openssl'), options.openssl);
  writeFileSync(join(temp, 'review.diff'), 'diff --git a/x b/x\n');
  writeFileSync(join(temp, 'checks.txt'), '');
  return {
    temp,
    env: {
      PATH: `${tools}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: temp,
      GITHUB_WORKSPACE: join(temp, 'workspace'),
      GITHUB_STEP_SUMMARY: join(temp, 'summary.md'),
      GH_TOKEN: 'not-a-token',
      REPO: 'owner/repo',
      HEAD_SHA: '0000000000000000000000000000000000000000',
      PR_TITLE: 'a title',
      PR_BODY: '',
    },
  };
}

function runStaged(name: string, options: { reviewerExit?: number; openssl?: string } = {}) {
  const { temp, env } = stageRunnerTemp(options);
  try {
    return runStep(name, env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('nothing the pull request or the model controls reaches the log as a workflow command', () => {
  // Text a pull request or the model controls: the check names, the report,
  // the title, the description and the diff, and the reviewer that prints the
  // report.
  const DERIVED =
    /checks\.txt|review\.md|review\.stderr|description\.md|review\.diff|PR_TITLE|PR_BODY|ADDED_LABEL/;
  const PRINTS = /\b(cat|echo|printf|tee|head|tail|sed|awk)\b|\bgrep\b(?![^\n]*\s-q\b)/;
  // `> "file"` or `>> "file"`. `>&2` is not a file: stderr reaches the log too.
  const TO_FILE = /(^|[^&\d])>>?\s*"/;

  interface Site {
    readonly step: string;
    readonly line: string;
    readonly bracketed: boolean;
  }

  function outputSites(): { sites: Site[]; unclosed: string[] } {
    const sites: Site[] = [];
    const unclosed: string[] = [];
    for (const step of allSteps) {
      const name = /^name: (.*)$/m.exec(step)?.[1] ?? step.split('\n')[0] ?? '';
      for (const body of runBodies(step)) {
        const lines = body.split('\n');
        // Lines inside a { ... } group redirected to a file print nothing to the log.
        const toFile = new Set<number>();
        const open: number[] = [];
        lines.forEach((l, i) => {
          const t = l.trim();
          if (t === '{') open.push(i);
          else if (t.startsWith('}')) {
            const from = open.pop() ?? i;
            if (TO_FILE.test(t)) for (let k = from; k <= i; k++) toFile.add(k);
          }
        });
        let token: string | undefined;
        lines.forEach((l, i) => {
          const t = l.trim();
          if (t.startsWith('#')) return;
          const start = /^echo "::stop-commands::\$\{(\w+)\}"$/.exec(t);
          if (start !== null) {
            token = start[1];
            return;
          }
          if (token !== undefined && t === `echo "::\${${token}}::"`) {
            token = undefined;
            return;
          }
          const prints = DERIVED.test(t) && PRINTS.test(t);
          const runsReviewer = t.includes('/.bin/aigency-review');
          if (!(prints || runsReviewer) || TO_FILE.test(t) || toFile.has(i)) return;
          sites.push({ step: name, line: t, bracketed: token !== undefined });
        });
        if (token !== undefined) unclosed.push(name);
      }
    }
    return { sites, unclosed };
  }

  it('finds the sites that print check names and the report to the log', () => {
    const { sites } = outputSites();
    const lines = sites.map((s) => s.line);
    expect(lines).toContain('cat "${RUNNER_TEMP}/checks.txt"');
    expect(lines.some((l) => l.includes('/.bin/aigency-review'))).toBe(true);
    expect(lines.some((l) => l.includes('tee "${RUNNER_TEMP}/review.md"'))).toBe(true);
    expect(lines.some((l) => l.startsWith('cat "${RUNNER_TEMP}/review.stderr"'))).toBe(true);
  });

  it('prints every one of them inside a stop-commands bracket that is closed again', () => {
    const { sites, unclosed } = outputSites();
    expect(sites.filter((s) => !s.bracketed)).toEqual([]);
    expect(unclosed).toEqual([]);
  });

  it('prints the check names to the log inside the group, with commands suspended', () => {
    const result = runStaged('Collect the other checks');
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('::group::Checks given to the reviewer');
    const start = /^::stop-commands::([0-9a-f]{64})$/.exec(lines[1] as string);
    expect(start, result.stdout).not.toBeNull();
    expect(lines[lines.length - 2]).toBe(`::${start?.[1]}::`);
    expect(lines[lines.length - 1]).toBe('::endgroup::');
    for (const forged of [
      '::add-mask::forged',
      '::error title=Review::forged check name: completed/success',
    ]) {
      const at = lines.indexOf(forged);
      expect(at, forged).toBeGreaterThan(1);
      expect(at, forged).toBeLessThan(lines.length - 2);
    }
  });

  it.each(
    ['Collect the other checks', 'Review'].flatMap((step) =>
      (Object.keys(BROKEN_OPENSSL) as (keyof typeof BROKEN_OPENSSL)[]).map(
        (mode) => [step, mode] as const,
      ),
    ),
  )('%s fails by name, printing nothing it was given, when openssl %s', (step, mode) => {
    const result = runStaged(step, { openssl: BROKEN_OPENSSL[mode] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '::error title=Review::Could not generate a stop-commands token',
    );
    expect(result.stdout).not.toContain('::stop-commands::');
    expect(result.stdout).not.toContain('forged');
    expect(result.stdout).not.toContain('## Review');
  });
});

describe('the Review step suspends workflow commands around the reviewer', () => {
  function runReview(exitStatus: number) {
    return runStaged('Review', { reviewerExit: exitStatus });
  }

  it.each([0, 1])(
    'brackets everything the reviewer prints, and keeps its exit status %i',
    (exitStatus) => {
      const result = runReview(exitStatus);
      expect(result.status, result.stderr).toBe(exitStatus);
      const lines = result.stdout.trimEnd().split('\n');
      const start = /^::stop-commands::([0-9a-f]{64})$/.exec(lines[0] as string);
      expect(start, result.stdout).not.toBeNull();
      expect(lines[lines.length - 1]).toBe(`::${start?.[1]}::`);
      const forged = lines.indexOf('::error title=Review::forged by the model');
      expect(forged).toBeGreaterThan(0);
      expect(forged).toBeLessThan(lines.length - 1);
    },
  );

  it("prints the reviewer's stderr inside the bracket, and keeps it out of review.md", () => {
    const { temp, env } = stageRunnerTemp({ reviewerExit: 1 });
    try {
      const result = runStep('Review', env);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(FORGED_STDERR);
      const lines = result.stdout.trimEnd().split('\n');
      const at = lines.indexOf(FORGED_STDERR);
      expect(at, result.stdout).toBeGreaterThan(0);
      expect(at).toBeLessThan(lines.length - 1);
      expect(lines[lines.length - 1]).toMatch(/^::[0-9a-f]{64}::$/);
      expect(readFileSync(join(temp, 'review.md'), 'utf8')).not.toContain(FORGED_STDERR);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('makes a fresh token for each run', () => {
    const token = (stdout: string): string =>
      /^::stop-commands::([0-9a-f]+)$/m.exec(stdout)?.[1] ?? '';
    const first = token(runReview(0).stdout);
    const second = token(runReview(0).stdout);
    expect(first).not.toBe('');
    expect(first).not.toBe(second);
  });
});

describe("setup-node's problem matchers are gone before anything the pull request controls is printed", () => {
  // Problem matchers ignore ::stop-commands::. These owners are those in
  // actions/setup-node's .github/tsc.json, eslint-stylish.json and
  // eslint-compact.json at this sha, all registered by its src/main.ts.
  const SETUP_NODE = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
  const OWNERS = ['tsc', 'eslint-stylish', 'eslint-compact'];
  const removal = "Remove setup-node's problem matchers";
  const at = (steps: string[], name: string): number =>
    steps.findIndex((s) => s.startsWith(`name: ${name}\n`));
  const code = (step: string): string =>
    step
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');

  it('removes every owner the pinned setup-node registers, and the pin is the one checked', () => {
    expect(text).toMatch(new RegExp(`^ {6}- uses: ${SETUP_NODE.replace(/[/.]/g, '\\$&')} `, 'm'));
    const result = runStep(removal, {});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual(
      OWNERS.map((owner) => `::remove-matcher owner=${owner}::`),
    );
  });

  it.each(EVENTS)(
    'under %s, runs after every action and before the check names and the report are printed',
    (event) => {
      const steps = stepsUnder(event);
      const removedAt = at(steps, removal);
      expect(removedAt).toBeGreaterThan(-1);
      expect(steps[removedAt]).not.toMatch(/^ {8}if:/m);
      const lastAction = steps.map((s) => /\buses:/.test(code(s))).lastIndexOf(true);
      expect(lastAction).toBeGreaterThan(-1);
      expect(removedAt).toBeGreaterThan(lastAction);
      expect(removedAt).toBeLessThan(at(steps, 'Collect the other checks'));
      expect(removedAt).toBeLessThan(at(steps, 'Review'));
    },
  );

  it('registers no matcher of its own', () => {
    expect(code(text)).not.toContain('add-matcher');
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
