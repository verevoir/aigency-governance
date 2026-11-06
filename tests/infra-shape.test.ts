// Pins the SHAPE of the keyless-corpus installation: infra.yml and the
// OpenTofu module. Text-level, no cloud, no tofu, no YAML or HCL dependency.
//
// One behaviour per test, so a red suite names exactly what broke. Checks that
// repeat across a set (each job, each variable) use it.each, so each member
// fails on its own. HCL is compared with alignment padding collapsed, so a
// behaviour-preserving `tofu fmt` realignment does not break a test.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/** Collapse alignment padding after a token (not indentation): `a   = 1` -> `a = 1`. */
const squash = (source: string): string => source.replace(/(\S)[ \t]{2,}/g, '$1 ');

const workflow = read('.github/workflows/infra.yml');
const install = read('infra/INSTALL.md');
const iamSource = read('infra/modules/review-corpus/iam.tf');
const moduleDir = new URL('infra/modules/review-corpus/', root);
const moduleFiles = readdirSync(moduleDir).filter((f) => f.endsWith('.tf'));
const moduleText = squash(
  moduleFiles.map((f) => readFileSync(new URL(f, moduleDir), 'utf8')).join('\n'),
);
const installation = squash(read('infra/installations/verevoir/main.tf'));

/** Strip comment-only lines so prose in comments cannot satisfy or break a check. */
const code = (source: string): string =>
  source
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n');

/** The bodies of every `run:` (block or single-line). */
function runBodies(source: string): string[] {
  const lines = source.split('\n');
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i] as string);
    if (m === null) continue;
    const indent = (m[1] as string).length;
    const body: string[] = [];
    if (!['|', '>-', '>'].includes(m[2] as string)) body.push(m[2] as string);
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    bodies.push(body.join('\n'));
  }
  return bodies;
}

/** The text of one job under `jobs:`. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const entries = (block: string | undefined): string[] =>
  (block ?? '')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l !== '')
    .sort();

const jobNames = ['check', 'plan', 'apply', 'drift'];
/** The jobs that authenticate to the cloud, and so use state. */
const cloudJobs = ['plan', 'apply', 'drift'];
/** Every (name, token) pair, so each pair is its own test. */
const pairs = (names: string[], tokens: string[]): { name: string; token: string }[] =>
  names.flatMap((name) => tokens.map((token) => ({ name, token })));

describe('infra.yml pins', () => {
  it.each([
    {
      action: 'google-github-actions/auth',
      pin: '7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0',
    },
    { action: 'opentofu/setup-opentofu', pin: 'a1320f892987e89d278cc92dc5adc984fb93aca4 # v2.0.2' },
  ])('pins $action by full SHA with a version comment', ({ action, pin }) => {
    expect(workflow).toContain(`${action}@${pin}`);
  });

  const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(.+)$/gm)].map((m) => m[1] as string);

  it('uses enough actions for the pin check to mean something', () => {
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });

  it.each(uses)('pins %s by 40-hex SHA with a version comment', (u) => {
    expect(u).toMatch(/^\S+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});

describe('infra.yml permissions', () => {
  const perms = (name: string): string[] =>
    entries(/^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(job(name))?.[1]);

  it('is read-only at the top level', () => {
    expect(entries(/^permissions:\n((?: {2}.+\n)+)/m.exec(workflow)?.[1])).toEqual([
      'contents: read',
    ]);
  });

  it('gives the check job contents: read and nothing else', () => {
    expect(perms('check')).toEqual(['contents: read']);
  });

  it.each(cloudJobs)('gives the %s job only contents: read and id-token: write', (name) => {
    expect(perms(name)).toEqual(['contents: read', 'id-token: write']);
  });
});

describe('infra.yml hygiene', () => {
  it('has run bodies to check', () => {
    expect(runBodies(workflow).length).toBeGreaterThanOrEqual(8);
  });

  it('never expands ${{ }} inside a run: body', () => {
    expect(runBodies(workflow).filter((b) => b.includes('${{'))).toEqual([]);
  });

  it.each(jobNames)('checks out exactly once in %s', (name) => {
    expect(job(name).match(/uses: actions\/checkout@/g)).toHaveLength(1);
  });

  it.each(jobNames)('checks out with persist-credentials: false in %s', (name) => {
    expect(job(name)).toContain('persist-credentials: false');
  });

  it('keeps the whole workflow free of secrets', () => {
    expect(code(workflow)).not.toContain('secrets.');
  });
});

describe('infra.yml check job (pull requests)', () => {
  const check = (): string => job('check');

  it('runs on pull requests', () => {
    expect(check()).toContain("github.event_name == 'pull_request'");
  });

  it.each(['google-github-actions/auth', 'id-token', 'secrets.', 'vars.'])(
    'carries no credentials: no %s',
    (token) => {
      expect(check()).not.toContain(token);
    },
  );

  it.each(['tofu fmt -check -recursive', 'tofu validate', 'tofu init -backend=false'])(
    'runs %s',
    (command) => {
      expect(check()).toContain(command);
    },
  );

  it('never applies', () => {
    expect(check()).not.toContain('tofu apply');
  });
});

describe('infra.yml plan job (push to main)', () => {
  const plan = (): string => job('plan');

  it('is triggered by pushes to main only', () => {
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]/);
  });

  it('runs on push only', () => {
    expect(plan()).toContain("github.event_name == 'push'");
  });

  it('takes the provider from a variable', () => {
    expect(plan()).toContain('workload_identity_provider: ${{ vars.INFRA_WIF_PROVIDER }}');
  });

  it('authenticates as the read-only planner, from a variable', () => {
    expect(plan()).toContain('service_account: ${{ vars.INFRA_PLANNER_SA }}');
  });

  it('prints a plan without locking the state', () => {
    expect(plan()).toContain('tofu plan -input=false -lock=false');
  });

  it('never applies', () => {
    expect(plan()).not.toContain('tofu apply');
  });

  it('never holds the deployer', () => {
    expect(plan()).not.toContain('INFRA_DEPLOYER_SA');
  });
});

describe('infra.yml apply job (push to main)', () => {
  const apply = (): string => job('apply');

  it('runs on push only', () => {
    expect(apply()).toContain("github.event_name == 'push'");
  });

  it('waits for the plan job', () => {
    expect(apply()).toMatch(/\n {4}needs: plan\n/);
  });

  it('waits for the infra-apply environment, where reviewers approve', () => {
    expect(apply()).toMatch(/\n {4}environment: infra-apply\n/);
  });

  it('takes the provider from a variable', () => {
    expect(apply()).toContain('workload_identity_provider: ${{ vars.INFRA_WIF_PROVIDER }}');
  });

  it('authenticates as the deployer, from a variable', () => {
    expect(apply()).toContain('service_account: ${{ vars.INFRA_DEPLOYER_SA }}');
  });

  it('saves its plan', () => {
    expect(apply()).toContain('tofu plan -input=false -out=tfplan');
  });

  it('applies the saved plan and nothing else', () => {
    expect(apply()).toContain('tofu apply -input=false tfplan');
  });

  it('does not auto-approve', () => {
    expect(apply()).not.toContain('-auto-approve');
  });

  it('uses no secrets', () => {
    expect(apply()).not.toContain('secrets.');
  });

  it('serialises applies', () => {
    expect(apply()).toMatch(/concurrency:\n {6}group: \S+\n {6}cancel-in-progress: false/);
  });
});

describe('infra.yml drift job (schedule and dispatch)', () => {
  const drift = (): string => job('drift');

  it('runs weekly', () => {
    expect(workflow).toMatch(/schedule:\n\s+- cron: '\d+ \d+ \* \* [0-6]'/);
  });

  it('can be run on demand', () => {
    expect(workflow).toMatch(/\n {2}workflow_dispatch:\n/);
  });

  it('runs only on schedule or dispatch', () => {
    expect(drift()).toContain(
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    );
  });

  it('fails on drift: plan with -detailed-exitcode', () => {
    expect(drift()).toContain('tofu plan -input=false -lock=false -detailed-exitcode');
  });

  it('never applies', () => {
    expect(drift()).not.toContain('tofu apply');
  });

  it('never auto-approves', () => {
    expect(drift()).not.toContain('-auto-approve');
  });

  it('authenticates as the read-only planner', () => {
    expect(drift()).toContain('service_account: ${{ vars.INFRA_PLANNER_SA }}');
  });

  it('never holds the deployer', () => {
    expect(drift()).not.toContain('INFRA_DEPLOYER_SA');
  });
});

describe('infra.yml remote state', () => {
  const stateVars = ['TF_STATE_BUCKET', 'TF_STATE_PREFIX'];
  const requireBody = (name: string): string =>
    runBodies(job(name)).find((b) => b.includes('TF_STATE_BUCKET}')) ?? '';

  it.each(pairs(cloudJobs, stateVars))(
    '$name reads $token from a repository variable',
    ({ name, token }) => {
      expect(job(name)).toContain(`${token}: \${{ vars.${token} }}`);
    },
  );

  it.each(pairs(cloudJobs, stateVars))(
    '$name fails closed when $token is unset',
    ({ name, token }) => {
      expect(requireBody(name)).toContain(`[ -z "\${${token}}" ]`);
    },
  );

  it.each(cloudJobs)('%s exits non-zero when the state location is unset', (name) => {
    expect(requireBody(name)).toContain('exit 1');
  });

  it.each(cloudJobs)('%s has the Require remote state step', (name) => {
    expect(job(name)).toContain('- name: Require remote state');
  });

  it.each(cloudJobs)('checks the state location before %s authenticates', (name) => {
    const text = job(name);
    expect(text.indexOf('Require remote state')).toBeLessThan(
      text.indexOf('google-github-actions/auth'),
    );
  });

  it.each(cloudJobs)('passes the bucket and prefix to tofu init in %s', (name) => {
    expect(job(name)).toContain(
      'tofu init -input=false -backend-config="bucket=${TF_STATE_BUCKET}" -backend-config="prefix=${TF_STATE_PREFIX}"',
    );
  });
});

describe('review-corpus module: files and naming', () => {
  it('has the module files', () => {
    expect(moduleFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(['verevoir', 'ai-gency'])('contains no hard-coded %s, comments included', (word) => {
    expect(moduleText.toLowerCase()).not.toContain(word);
  });
});

describe('review-corpus module: versions', () => {
  it('pins OpenTofu ~> 1.12', () => {
    expect(moduleText).toContain('required_version = "~> 1.12"');
  });

  it('uses the hashicorp google provider', () => {
    expect(moduleText).toMatch(/source\s*=\s*"hashicorp\/google"/);
  });

  it('pins a specific google provider minor', () => {
    expect(moduleText).toMatch(/version\s*=\s*"~> \d+\.\d+\.0"/);
  });
});

describe('review-corpus module: buckets', () => {
  it.each([
    { name: 'uniform bucket-level access', re: /uniform_bucket_level_access = true/g },
    { name: 'public access prevention enforced', re: /public_access_prevention = "enforced"/g },
    { name: 'versioning', re: /versioning \{\n\s+enabled = true/g },
  ])('sets $name on both buckets', ({ re }) => {
    expect(moduleText.match(re)).toHaveLength(2);
  });

  it('deletes noncurrent versions after 30 days', () => {
    expect(moduleText).toContain('days_since_noncurrent_time = 30');
  });

  it('protects the state bucket from destroy', () => {
    expect(moduleText).toContain('prevent_destroy = true');
  });
});

describe('review-corpus module: roles and APIs', () => {
  it('uses no owner or editor role', () => {
    expect(moduleText).not.toMatch(/roles\/(owner|editor)/);
  });

  it('uses no project IAM admin, IAM admin or security admin role', () => {
    expect(moduleText).not.toMatch(
      /roles\/(resourcemanager\.projectIamAdmin|iam\.securityAdmin|iam\.admin)"/,
    );
  });

  it('never disables an API on destroy', () => {
    expect(moduleText).toMatch(/disable_on_destroy = false/);
  });

  it('enables exactly the five APIs it needs', () => {
    const services = [...moduleText.matchAll(/"([a-z]+\.googleapis\.com)"/g)].map((m) => m[1]);
    expect(services.sort()).toEqual([
      'cloudresourcemanager.googleapis.com',
      'iam.googleapis.com',
      'iamcredentials.googleapis.com',
      'storage.googleapis.com',
      'sts.googleapis.com',
    ]);
  });

  it('binds the deployer only through the governance repo workflow identity', () => {
    expect(moduleText).toContain(
      '${local.pool_principal}/attribute.repo_id_workflow/${local.deployer_identity}"',
    );
  });

  it('exposes exactly the seven outputs', () => {
    const outputs = [...moduleText.matchAll(/^output "([a-z_]+)"/gm)].map((m) => m[1]);
    expect(outputs.sort()).toEqual([
      'corpus_bucket',
      'deployer_sa',
      'planner_sa',
      'publisher_sa',
      'reader_sa',
      'state_bucket',
      'wif_provider',
    ]);
  });
});

describe('verevoir installation: inputs', () => {
  const variableNames = (): string[] =>
    moduleText
      .split(/^variable "/m)
      .slice(1)
      .map((b) => /^([a-z_]+)"/.exec(b)?.[1] as string);
  const required = moduleText
    .split(/^variable "/m)
    .slice(1)
    .filter((b) => !/^ {2}default\b/m.test(b))
    .map((b) => /^([a-z_]+)"/.exec(b)?.[1] as string);
  const call = /module "review_corpus" \{\n([\s\S]*?)\n\}/.exec(installation)?.[1] ?? '';
  const passed = [...code(call).matchAll(/^\s*([a-z_]+)\s*=/gm)].map((m) => m[1] as string);

  it('requires exactly the eight installation inputs', () => {
    expect([...required].sort()).toEqual([
      'corpus_repo',
      'corpus_repo_id',
      'github_owner',
      'github_owner_id',
      'governance_repo',
      'governance_repo_id',
      'project_id',
      'region',
    ]);
  });

  it.each(required)('passes the required input %s', (name) => {
    expect(passed).toContain(name);
  });

  it('passes no input the module does not declare', () => {
    const unknown = passed.filter((n) => n !== 'source' && !variableNames().includes(n));
    expect(unknown).toEqual([]);
  });
});

describe('verevoir installation: values', () => {
  it.each([
    'project_id = "ai-gency"',
    'region = "europe-west2"',
    'github_owner = "verevoir"',
    'github_owner_id = "266172281"',
    'corpus_repo = "verevoir/aigency-guardrails"',
    'corpus_repo_id = "1238645336"',
    'governance_repo = "verevoir/aigency-governance"',
    'governance_repo_id = "1334340199"',
  ])('sets %s', (line) => {
    expect(installation).toContain(line);
  });
});

describe('verevoir installation: remote state backend', () => {
  it('declares a partial gcs backend', () => {
    expect(code(installation)).toMatch(/backend "gcs" \{\s*\}/);
  });

  it('bakes no bucket or prefix into the backend or anywhere else in code', () => {
    expect(code(installation)).not.toMatch(/\b(bucket|prefix)\s*=/);
  });

  it.each(['-backend-config', 'TF_STATE_BUCKET', 'TF_STATE_PREFIX'])(
    'explains, in a comment, how %s reaches init',
    (token) => {
      expect(installation).toContain(token);
    },
  );

  it('no longer asks for the backend block to be commented out or migrated', () => {
    expect(installation).not.toContain('-migrate-state');
    expect(installation).not.toContain('BOOTSTRAP');
  });
});

describe('review-corpus module: input rules', () => {
  const variableBlock = (name: string): string =>
    moduleText
      .split(/^variable "/m)
      .slice(1)
      .find((b) => b.startsWith(`${name}"`)) ?? '';
  /** The first regex() of a variable's validation, as a JS RegExp (a never-match if absent). */
  const ruleOf = (name: string): RegExp =>
    new RegExp(/regex\("([^"]+)"/.exec(variableBlock(name))?.[1] ?? '(?!)');
  const idVars = ['github_owner_id', 'corpus_repo_id', 'governance_repo_id'];
  const repoVars = ['corpus_repo', 'governance_repo'];
  const pathVars = ['publish_workflow_path', 'deploy_workflow_path'];

  it.each(idVars)('%s accepts a numeric id', (name) => {
    expect(ruleOf(name).test('266172281')).toBe(true);
  });

  it.each(pairs(idVars, ['', 'verevoir', '12a', '-1', '1 2']))(
    '$name rejects "$token"',
    ({ name, token }) => {
      expect(ruleOf(name).test(token)).toBe(false);
    },
  );

  it.each(repoVars)('%s accepts owner/name', (name) => {
    expect(ruleOf(name).test('verevoir/aigency-governance')).toBe(true);
  });

  it.each(pairs(repoVars, ['', 'noslash', 'a/b/c', 'a b/c', '/x']))(
    '$name rejects "$token"',
    ({ name, token }) => {
      expect(ruleOf(name).test(token)).toBe(false);
    },
  );

  it.each(['review', 'rvw-corp', 'abcdefghij'])('name_prefix accepts "%s"', (ok) => {
    expect(ruleOf('name_prefix').test(ok)).toBe(true);
  });

  it.each(['', 'a', 'Review', '1abc', 'a_b', 'abcdefghijk'])('name_prefix rejects "%s"', (bad) => {
    expect(ruleOf('name_prefix').test(bad)).toBe(false);
  });

  it.each(['', 'r2', 'abc-123'])('pool_suffix accepts "%s"', (ok) => {
    expect(ruleOf('pool_suffix').test(ok)).toBe(true);
  });

  it.each(['R2', 'a_b', 'abcdefghijklm'])('pool_suffix rejects "%s"', (bad) => {
    expect(ruleOf('pool_suffix').test(bad)).toBe(false);
  });

  it.each(pathVars)('%s accepts a workflow file path', (name) => {
    expect(ruleOf(name).test('.github/workflows/infra.yml')).toBe(true);
  });

  it.each(pairs(pathVars, ['', 'a b', 'x?y', 'a;b']))(
    '$name rejects "$token"',
    ({ name, token }) => {
      expect(ruleOf(name).test(token)).toBe(false);
    },
  );

  it.each(pathVars)('%s rejects an absolute path', (name) => {
    expect(variableBlock(name)).toContain(`!startswith(var.${name}, "/")`);
  });
});

describe('shared-project guards', () => {
  const moduleCode = code(moduleText);
  const blocks = moduleCode.split(/^resource "/m).slice(1);
  const header = (b: string): string => b.split('{')[0] as string;
  /** One resource block by its name, optionally by its type prefix (names repeat across types). */
  const block = (name: string, type = ''): string =>
    blocks.find((b) => b.startsWith(type) && b.includes(`" "${name}" {`)) ?? '';
  const firstLines = (b: string): string => b.split('\n').slice(0, 2).join('\n');
  const gate = /(count|for_each)\s*=\s*var\.create_deployer \?/;
  const grantsOnly = (b: string): string[] =>
    [...b.matchAll(/role\s*=\s*"([^"]+)"/g)].map((m) => m[1] as string);

  describe('additive IAM', () => {
    it('uses no iam_binding anywhere in the module', () => {
      expect(moduleText).not.toContain('_iam_binding');
    });

    it('uses no iam_policy anywhere in the module', () => {
      expect(moduleText).not.toContain('_iam_policy');
    });

    it('declares no iam_binding or iam_policy resource', () => {
      const bad = blocks.map(header).filter((h) => /_iam_(binding|policy)"/.test(h));
      expect(bad).toEqual([]);
    });

    it('makes every IAM grant a single-member or custom-role resource', () => {
      const grants = blocks.filter((b) =>
        /^google_(project|storage_bucket|service_account)_iam_\w+"/.test(header(b)),
      );
      expect(grants.length).toBeGreaterThan(0);
      const bad = grants.map(header).filter((h) => !/_iam_(member|custom_role)"/.test(h));
      expect(bad).toEqual([]);
    });
  });

  describe('manage_apis', () => {
    const api = (): string => blocks.find((b) => b.startsWith('google_project_service')) as string;

    it('creates no project service when false', () => {
      expect(api()).toMatch(/for_each\s*=\s*var\.manage_apis \?/);
    });

    it('never disables the API on destroy', () => {
      expect(api()).toContain('disable_on_destroy = false');
    });

    it('never disables dependent services', () => {
      expect(api()).toContain('disable_dependent_services = false');
    });

    it('defaults to true', () => {
      expect(moduleText).toMatch(/variable "manage_apis" \{[\s\S]*?default\s+= true/);
    });
  });

  describe('create_deployer', () => {
    const family = blocks.filter(
      (b) => /deployer|planner/.test(header(b)) || /^google_project_iam/.test(b),
    );

    it('defaults to true', () => {
      expect(moduleText).toMatch(/variable "create_deployer" \{[\s\S]*?default\s+= true/);
    });

    it('covers the deployer, planner and project IAM resources', () => {
      expect(family.length).toBeGreaterThanOrEqual(10);
    });

    it('gates every deployer, planner and project IAM resource on create_deployer', () => {
      const ungated = family.filter((b) => !gate.test(firstLines(b))).map(header);
      expect(ungated).toEqual([]);
    });

    it('makes every project-level IAM resource a deployer or planner one', () => {
      const others = blocks
        .filter((b) => /^google_project_iam/.test(b))
        .map(header)
        .filter((h) => !/deployer|planner/.test(h));
      expect(others).toEqual([]);
    });
  });

  describe('publisher binding', () => {
    it('binds the publisher through the corpus repo workflow identity', () => {
      expect(moduleText).toContain(
        '${local.pool_principal}/attribute.repo_id_workflow/${local.publisher_identity}"',
      );
    });

    it.each(['attribute.repository/', 'attribute.repo_ref', 'attribute.repo_id_ref'])(
      'never uses the weaker %s',
      (weaker) => {
        expect(moduleText).not.toContain(weaker);
      },
    );
  });

  describe('exact repo id, ref and workflow file', () => {
    const defaults = (name: string): string | undefined =>
      new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s+= "([^"]+)"`).exec(moduleText)?.[1];
    const members = [
      ...moduleCode.matchAll(/^\s*member\s*=\s*"(\$\{local\.pool_principal\}[^"]*)"/gm),
    ].map((m) => m[1] as string);
    const wf = members.filter((p) => p.includes('attribute.repo_id_workflow/'));
    const identities = [
      ...moduleCode.matchAll(/^\s*(publisher|deployer)_identity\s*=\s*"([^"]*)"/gm),
    ].map((m) => m[2] as string);

    it('builds the publisher identity from the corpus repo id, name and publish workflow', () => {
      expect(moduleText).toContain(
        'publisher_identity = "${var.corpus_repo_id}@refs/heads/main|${var.corpus_repo}/${var.publish_workflow_path}@refs/heads/main"',
      );
    });

    it('builds the deployer identity from the governance repo id, name and deploy workflow', () => {
      expect(moduleText).toContain(
        'deployer_identity = "${var.governance_repo_id}@refs/heads/main|${var.governance_repo}/${var.deploy_workflow_path}@refs/heads/main"',
      );
    });

    it('maps repo_id_workflow to repository id, ref and workflow ref', () => {
      expect(moduleText).toContain(
        '"attribute.repo_id_workflow" = "assertion.repository_id + \'@\' + assertion.ref + \'|\' + assertion.job_workflow_ref"',
      );
    });

    it('maps job_workflow_ref', () => {
      expect(moduleText).toContain('"attribute.job_workflow_ref" = "assertion.job_workflow_ref"');
    });

    it('defaults the publish workflow path', () => {
      expect(defaults('publish_workflow_path')).toBe('.github/workflows/publish-corpus.yml');
    });

    it('defaults the deploy workflow path', () => {
      expect(defaults('deploy_workflow_path')).toBe('.github/workflows/infra.yml');
    });

    it('binds only the publisher and the deployer workflow identities', () => {
      expect([...new Set(wf)].sort()).toEqual([
        '${local.pool_principal}/attribute.repo_id_workflow/${local.deployer_identity}',
        '${local.pool_principal}/attribute.repo_id_workflow/${local.publisher_identity}',
      ]);
    });

    it('binds the publisher once', () => {
      expect(wf.filter((p) => p.endsWith('${local.publisher_identity}'))).toHaveLength(1);
    });

    it('binds the deployer identity to the deployer and to the read-only planner', () => {
      expect(wf.filter((p) => p.endsWith('${local.deployer_identity}'))).toHaveLength(2);
    });

    it.each(['*', 'startsWith'])('has no %s in any workflow principal', (bad) => {
      expect(wf.filter((p) => p.includes(bad))).toEqual([]);
    });

    it('has exactly two identities', () => {
      expect(identities).toHaveLength(2);
    });

    it('ends every identity exactly in @refs/heads/main', () => {
      expect(identities.filter((v) => !v.endsWith('@refs/heads/main'))).toEqual([]);
    });

    it('has a ref and a workflow in every identity', () => {
      expect(identities.filter((v) => !v.includes('@refs/heads/main|'))).toEqual([]);
    });

    it.each(['*', 'startsWith'])('has no %s in any identity', (bad) => {
      expect(identities.filter((v) => v.includes(bad))).toEqual([]);
    });

    it('puts the corpus repo id first in the publisher identity', () => {
      expect(identities[0]).toContain('${var.corpus_repo_id}@');
    });

    it('puts the governance repo id first in the deployer identity', () => {
      expect(identities[1]).toContain('${var.governance_repo_id}@');
    });

    it('has no binding on a repo and ref without the workflow file', () => {
      expect(moduleText).not.toMatch(/attribute\.repo_id_ref|attribute\.ref\//);
    });
  });

  describe('numeric ids', () => {
    it('requires the owner id in the provider condition', () => {
      expect(moduleText).toContain("assertion.repository_owner_id == '${var.github_owner_id}'");
    });

    it('maps the repository id', () => {
      expect(moduleText).toContain('"attribute.repository_id" = "assertion.repository_id"');
    });

    it('maps the owner id', () => {
      expect(moduleText).toContain('= "assertion.repository_owner_id"');
    });

    it('scopes the reader to the owner id', () => {
      expect(moduleText).toContain(
        '${local.pool_principal}/attribute.repository_owner_id/${var.github_owner_id}"',
      );
    });

    it('never trusts the owner name', () => {
      expect(moduleText).not.toContain('var.github_owner}');
    });

    it.each(['corpus_repo', 'governance_repo'])(
      'uses the %s name only inside the identity, after its numeric id',
      (name) => {
        const after = new RegExp(
          `_identity\\s+= "\\$\\{var\\.${name}_id\\}@refs/heads/main\\|\\$\\{var\\.${name}\\}/`,
        );
        const uses = moduleCode.split('\n').filter((l) => l.includes(`var.${name}}`));
        expect(uses.filter((l) => !after.test(l))).toEqual([]);
      },
    );

    it.each(['corpus_repo', 'governance_repo'])(
      'still uses the %s name in its identity',
      (name) => {
        expect(moduleCode).toContain(`var.${name}}/`);
      },
    );

    it('builds the provider condition from the owner id local', () => {
      expect(moduleCode).toMatch(/attribute_condition\s+=.*local\.owner_id_condition/);
    });
  });

  describe('the deployer reach (it can widen access, so the module says so)', () => {
    const projectGrant = (): string => block('deployer', 'google_project_iam_member');
    const customRoles = blocks.filter((b) =>
      header(b).startsWith('google_project_iam_custom_role'),
    );

    it('holds exactly two project-wide predefined roles', () => {
      expect([...projectGrant().matchAll(/"(roles\/[^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
        'roles/iam.workloadIdentityPoolAdmin',
        'roles/serviceusage.serviceUsageAdmin',
      ]);
    });

    it('never grants serviceAccountAdmin at project level', () => {
      const projectLevel = blocks.filter((b) => /^google_project_iam_member/.test(b));
      const bad = projectLevel.filter((b) => b.includes('serviceAccountAdmin')).map(header);
      expect(bad).toEqual([]);
    });

    it('grants serviceAccountAdmin', () => {
      expect(block('deployer_sa_admin')).toContain('role = "roles/iam.serviceAccountAdmin"');
    });

    it('grants serviceAccountAdmin on service accounts, not the project', () => {
      expect(header(block('deployer_sa_admin'))).toContain('google_service_account_iam_member');
    });

    it.each(['publisher', 'reader', 'deployer', 'planner'])(
      'scopes serviceAccountAdmin to the module %s account',
      (name) => {
        expect(block('deployer_sa_admin')).toMatch(
          new RegExp(`${name} = google_service_account\\.${name}`),
        );
      },
    );

    it('has three custom roles', () => {
      expect(customRoles).toHaveLength(3);
    });

    it('gives no custom role a permission that sets a policy', () => {
      expect(customRoles.filter((b) => b.includes('setIamPolicy')).map(header)).toEqual([]);
    });

    it('lets the deployer create service accounts through a custom role only', () => {
      const role = block('deployer_project', 'google_project_iam_custom_role');
      expect(role).toContain('"iam.serviceAccounts.create"');
    });

    it('states the residual risk in iam.tf', () => {
      expect(iamSource).toMatch(/accepted residual risk/);
    });

    it('requires a dedicated project in iam.tf', () => {
      expect(iamSource).toContain('DEDICATED project');
    });

    it('no longer claims in iam.tf that the deployer cannot grant roles', () => {
      expect(iamSource).not.toContain('no role that can grant roles');
    });
  });

  describe('the planner is read-only', () => {
    const plannerBlocks = blocks.filter((b) => /planner/.test(header(b)));
    const plannerRoles = blocks.filter(
      (b) => /planner/.test(header(b)) && header(b).startsWith('google_project_iam_custom_role'),
    );
    const permissions = plannerRoles.flatMap((b) =>
      [...(/permissions = \[([\s\S]*?)\]/.exec(b)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(
        (m) => m[1] as string,
      ),
    );

    it('has two custom roles', () => {
      expect(plannerRoles).toHaveLength(2);
    });

    it('has permissions to check', () => {
      expect(permissions.length).toBeGreaterThan(0);
    });

    it('holds only get, list and getIamPolicy permissions', () => {
      expect(permissions.filter((p) => !/\.(get|list|getIamPolicy)$/.test(p))).toEqual([]);
    });

    it('is granted no role but object viewing on state and impersonation of itself', () => {
      const roles = plannerBlocks.flatMap(grantsOnly);
      const bad = roles.filter(
        (r) => !['roles/storage.objectViewer', 'roles/iam.workloadIdentityUser'].includes(r),
      );
      expect(bad).toEqual([]);
    });

    it('is bound to the same workflow identity as the deployer', () => {
      expect(block('planner_wif')).toContain('${local.deployer_identity}');
    });
  });

  describe('the reader', () => {
    const reader = blocks.filter((b) => /^google_[a-z_]+"\s*"reader(_wif)?"/.test(b));
    const grants = blocks.filter((b) => /^google_storage_bucket_iam_member"\s*"reader"/.test(b));

    it('has exactly three resources', () => {
      expect(reader.length).toBe(3);
    });

    it('has one bucket grant', () => {
      expect(grants).toHaveLength(1);
    });

    it('is given objectViewer on the corpus bucket', () => {
      expect(grants[0]).toContain('role = "roles/storage.objectViewer"');
    });

    it('is granted only objectViewer or workloadIdentityUser on its own account', () => {
      const roles = reader.flatMap(grantsOnly);
      const bad = roles.filter(
        (r) => !['roles/storage.objectViewer', 'roles/iam.workloadIdentityUser'].includes(r),
      );
      expect(bad).toEqual([]);
    });

    it('is granted no write-capable storage role anywhere', () => {
      const mine = blocks.filter((x) => x.includes('google_service_account.reader.email'));
      const bad = mine.filter((b) =>
        /roles\/storage\.(objectCreator|objectUser|objectAdmin|admin|legacy\w*)/.test(b),
      );
      expect(bad).toEqual([]);
    });

    it('is granted no owner or editor role anywhere', () => {
      const mine = blocks.filter((x) => x.includes('google_service_account.reader.email'));
      expect(mine.filter((b) => /roles\/(owner|editor)/.test(b))).toEqual([]);
    });
  });

  describe('the publisher', () => {
    it('is never granted objectAdmin', () => {
      expect(moduleText).not.toContain('roles/storage.objectAdmin');
    });

    it('creates objects with objectCreator', () => {
      expect(block('publisher_create')).toContain('role = "roles/storage.objectCreator"');
    });

    it.each(['corpus/', 'manifests/'])('may create under %s', (prefix) => {
      expect(block('publisher_create')).toContain(`startsWith('\${local.object_prefix}${prefix}')`);
    });

    it('may create refs/main', () => {
      expect(block('publisher_create')).toContain(
        "resource.name == '${local.object_prefix}refs/main'",
      );
    });

    it('overwrites with objectUser', () => {
      expect(block('publisher_overwrite_ref')).toContain('role = "roles/storage.objectUser"');
    });

    it('may overwrite refs/main only', () => {
      expect(block('publisher_overwrite_ref')).toMatch(
        /expression\s+= "resource\.name == '\$\{local\.object_prefix\}refs\/main'"/,
      );
    });

    it('may overwrite by exact name, never by prefix', () => {
      expect(block('publisher_overwrite_ref')).not.toContain('startsWith');
    });

    it('names objects by the corpus bucket path', () => {
      expect(moduleText).toContain(
        'object_prefix = "projects/_/buckets/${google_storage_bucket.corpus.name}/objects/"',
      );
    });
  });

  describe('the provider condition', () => {
    it('never replaces the owner-id check with a custom condition', () => {
      expect(moduleText).not.toContain('coalesce(var.allowed_owner_condition');
    });

    it('defines the owner-id condition', () => {
      expect(moduleText).toContain(
        'owner_id_condition = "assertion.repository_owner_id == \'${var.github_owner_id}\'"',
      );
    });

    it('ANDs a custom condition with the owner-id check', () => {
      expect(moduleText).toContain(
        'attribute_condition = var.allowed_owner_condition == null ? local.owner_id_condition : "(${local.owner_id_condition}) && (${var.allowed_owner_condition})"',
      );
    });

    it('applies the combined condition to the provider', () => {
      expect(moduleText).toMatch(/attribute_condition\s+= local\.attribute_condition/);
    });
  });

  describe('name prefix on every id', () => {
    const ids = [
      ...moduleCode.matchAll(
        /^\s*(account_id|role_id|workload_identity_pool_id|workload_identity_pool_provider_id)\s*=\s*(.+)$/gm,
      ),
    ];

    it('has enough ids to check', () => {
      expect(ids.length).toBeGreaterThanOrEqual(6);
    });

    it('has no fixed id', () => {
      const fixed = ids.filter(
        (m) => !/var\.name_prefix|local\.pool_id|google_/.test(m[2] as string),
      );
      expect(fixed.map((m) => m[0])).toEqual([]);
    });

    it('prefixes the corpus bucket', () => {
      expect(moduleCode).toMatch(/corpus_bucket = "\$\{var\.name_prefix\}-/);
    });

    it('prefixes the state bucket', () => {
      expect(moduleCode).toMatch(/state_bucket = "\$\{var\.name_prefix\}-/);
    });

    it('prefixes the pool', () => {
      expect(moduleCode).toMatch(/pool_id = var\.pool_suffix == "" \? "\$\{var\.name_prefix\}-/);
    });
  });
});

describe('INSTALL.md matches the code', () => {
  it.each([
    'TF_STATE_BUCKET',
    'TF_STATE_PREFIX',
    'INFRA_PLANNER_SA',
    'infra-apply',
    '-backend-config',
    'tofu import',
  ])('documents %s', (token) => {
    expect(install).toContain(token);
  });

  it.each(['--versioning', '--uniform-bucket-level-access'])(
    'documents creating the state bucket with %s',
    (flag) => {
      expect(install).toContain(flag);
    },
  );

  it.each(['migrate-state', 'Uncomment the `backend'])(
    'no longer tells the operator: %s',
    (old) => {
      expect(install).not.toContain(old);
    },
  );

  it('enables the Storage API before creating the state bucket', () => {
    const enable = install.indexOf('gcloud services enable storage.googleapis.com');
    expect(enable).toBeGreaterThan(-1);
    expect(enable).toBeLessThan(install.indexOf('gcloud storage buckets create'));
  });

  it('states the residual risk of the deployer', () => {
    expect(install).toMatch(/accepted\s+residual\s+risk/);
  });

  it('requires a dedicated project', () => {
    expect(install).toContain('**dedicated project**');
  });

  it.each(['cannot widen its own access', 'no role that can grant roles'])(
    'no longer claims: %s',
    (claim) => {
      expect(install).not.toContain(claim);
    },
  );

  it('says the applied plan can differ from the printed one', () => {
    expect(install).toContain('the approval covers the printed plan, not');
  });

  it('puts the ordering guard for refs/main on the publish workflow', () => {
    expect(install).toContain('`refs/main` has no ordering guard');
  });
});
