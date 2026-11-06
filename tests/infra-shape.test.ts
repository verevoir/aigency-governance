// Pins the SHAPE of the keyless-corpus installation: infra.yml, the OpenTofu
// module and INSTALL.md. Text-level: no cloud, no tofu, no YAML or HCL library.
//
// The module is tested by WHAT IT GRANTS AND TO WHOM, not by its spelling. The
// HCL is read into (target, role, member, condition) grants, with Terraform
// resource and local names normalised away: a service account is its
// account_id suffix (`publisher`), a bucket its `<name>_bucket` local
// (`corpus`), a custom role its role_id suffix, and locals are expanded. So a
// pure rename of a resource or a local does not fail a test; a change to a
// grant does. One behaviour per test; per-member checks use it.each.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/** Collapse alignment padding after a token, so a `tofu fmt` realignment cannot fail a test. */
const squash = (source: string): string => source.replace(/(\S)[ \t]{2,}/g, '$1 ');
/** Drop comment-only lines, so prose cannot satisfy or break a check. */
const code = (source: string): string =>
  source
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n');

const workflow = read('.github/workflows/infra.yml');
const install = read('infra/INSTALL.md');
const flat = install.replace(/\s+/g, ' ');
/** iam.tf with comment markers and line breaks collapsed, so a wrapped phrase still matches. */
const iamSource = read('infra/modules/review-corpus/iam.tf').replace(/\n#?\s*/g, ' ');
const gitignore = read('.gitignore');
const moduleDir = new URL('infra/modules/review-corpus/', root);
const moduleText = squash(
  readdirSync(moduleDir)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => readFileSync(new URL(f, moduleDir), 'utf8'))
    .join('\n'),
);
const moduleCode = code(moduleText);
const installation = squash(read('infra/installations/verevoir/main.tf'));

const pairs = (names: string[], tokens: string[]): { name: string; token: string }[] =>
  names.flatMap((name) => tokens.map((token) => ({ name, token })));

// ---------------------------------------------------------------- workflow

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
      body.push(line.replace(new RegExp(`^ {${indent + 2}}`), ''));
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

const jobNames = ['scan', 'check', 'plan', 'apply', 'drift'];
/** The jobs that authenticate to the cloud, and so use state. */
const cloudJobs = ['plan', 'apply', 'drift'];
const stateVars = ['TF_STATE_BUCKET', 'TF_STATE_PREFIX'];

/** Run a workflow `run:` body in bash with a fake `tofu` that exits `tofuExit`. */
function execute(
  body: string,
  env: Record<string, string>,
  tofuExit = 0,
): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'infra-shape-'));
  const fake = join(dir, 'tofu');
  writeFileSync(fake, `#!/bin/sh\nexit ${tofuExit}\n`);
  chmodSync(fake, 0o755);
  const r = spawnSync('/bin/bash', ['-e', '-c', body], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('infra.yml pins', () => {
  it.each([
    {
      action: 'google-github-actions/auth',
      pin: '7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0',
    },
    { action: 'opentofu/setup-opentofu', pin: 'a1320f892987e89d278cc92dc5adc984fb93aca4 # v2.0.2' },
    {
      action: 'bridgecrewio/checkov-action',
      pin: '45edc9d8856b664db2ec251f5f8632361f0a67aa # v12.3139.0',
    },
  ])('pins $action to the verified SHA', ({ action, pin }) => {
    expect(workflow).toContain(`${action}@${pin}`);
  });

  const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(.+)$/gm)].map((m) => m[1] as string);

  it('uses enough actions for the pin check to mean something', () => {
    expect(uses.length).toBeGreaterThanOrEqual(10);
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

  it.each(['scan', 'check'])('gives %s contents: read and nothing else', (name) => {
    expect(perms(name)).toEqual(['contents: read']);
  });

  it.each(cloudJobs)('gives %s only contents: read and id-token: write', (name) => {
    expect(perms(name)).toEqual(['contents: read', 'id-token: write']);
  });
});

describe('infra.yml hygiene', () => {
  it('has run bodies to check', () => {
    expect(runBodies(workflow).length).toBeGreaterThanOrEqual(10);
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

  it('uses no secrets', () => {
    expect(code(workflow)).not.toContain('secrets.');
  });

  it('names the installation directory once', () => {
    expect(workflow.match(/infra\/installations\/verevoir/g)).toHaveLength(1);
  });

  it('explains that timeouts are unmeasured ceilings', () => {
    expect(workflow).toContain('ceilings, not measurements');
  });

  it('writes a plan file that .gitignore covers', () => {
    expect(gitignore.split('\n')).toContain('*.tfplan');
    expect(workflow).toContain('-out=plan.tfplan');
  });
});

describe('infra.yml scan job', () => {
  const scan = (): string => job('scan');

  it.each([
    'directory: infra',
    'framework: terraform',
    'soft_fail: false',
    'quiet: true',
    'download_external_modules: false',
  ])('runs checkov with %s', (input) => {
    expect(scan()).toContain(input);
  });

  it('carries no credentials', () => {
    expect(scan()).not.toContain('id-token');
  });

  it('states that the docker image is pulled by tag, outside the SHA pin', () => {
    expect(workflow).toContain('docker image by TAG');
  });

  it('skips no check without a reason', () => {
    expect(code(workflow)).not.toContain('skip_check');
  });

  it('blocks the plan', () => {
    expect(job('plan')).toMatch(/\n {4}needs: scan\n/);
  });
});

describe('infra.yml check job (pull requests)', () => {
  const check = (): string => job('check');

  it('runs on pull requests only', () => {
    expect(check()).toContain("github.event_name == 'pull_request'");
  });

  it.each(['google-github-actions/auth', 'id-token', 'secrets.', 'vars.', 'tofu apply'])(
    'carries no %s',
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
});

describe('infra.yml plan job (push to main)', () => {
  const plan = (): string => job('plan');

  it('is triggered by pushes to main only', () => {
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]/);
  });

  it('runs on push only', () => {
    expect(plan()).toContain("github.event_name == 'push'");
  });

  it('authenticates as the read-only planner', () => {
    expect(plan()).toContain('service_account: ${{ vars.INFRA_PLANNER_SA }}');
  });

  it('never holds the deployer', () => {
    expect(plan()).not.toContain('INFRA_DEPLOYER_SA');
  });

  it('never applies', () => {
    expect(plan()).not.toContain('tofu apply');
  });

  it('plans without locking the state, and saves the plan', () => {
    expect(plan()).toContain('tofu plan -input=false -lock=false -out=plan.tfplan');
  });

  it('prints the plan', () => {
    expect(plan()).toContain('tofu show -no-color plan.tfplan');
  });

  it('uploads the plan and fails if there is none', () => {
    expect(plan()).toContain('if-no-files-found: error');
  });

  it('gives the plan artifact a stated retention', () => {
    expect(plan()).toMatch(/retention-days: \d+/);
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

  it('waits in the environment the deployer is bound to', () => {
    const env = /\n {4}environment: (\S+)\n/.exec(apply())?.[1];
    expect(env).toBe(/default\s*=\s*"([^"]+)"/.exec(variableBlock('deploy_environment'))?.[1]);
  });

  it('authenticates as the deployer', () => {
    expect(apply()).toContain('service_account: ${{ vars.INFRA_DEPLOYER_SA }}');
  });

  it('never holds the planner', () => {
    expect(apply()).not.toContain('INFRA_PLANNER_SA');
  });

  it('downloads the saved plan', () => {
    expect(apply()).toContain('actions/download-artifact@');
  });

  it('applies the saved plan and nothing else', () => {
    expect(apply()).toContain('tofu apply -input=false plan.tfplan');
  });

  it('does not plan again', () => {
    expect(apply()).not.toContain('tofu plan');
  });

  it('does not auto-approve', () => {
    expect(apply()).not.toContain('-auto-approve');
  });

  it('serialises applies without cancelling a running one', () => {
    expect(apply()).toMatch(/concurrency:\n {6}group: \S+\n {6}cancel-in-progress: false/);
  });

  it('says GitHub keeps one pending run, so a newer push replaces it', () => {
    expect(apply()).toContain('ONE pending run per group');
  });
});

describe('infra.yml drift job (schedule and dispatch)', () => {
  const drift = (): string => job('drift');
  const script = (): string =>
    runBodies(drift()).find((b) => b.includes('-detailed-exitcode')) ?? '';

  it('runs weekly', () => {
    expect(workflow).toMatch(/schedule:\n\s+(?:#.*\n\s+)?- cron: '\d+ \d+ \* \* [0-6]'/);
  });

  it('can be run on demand', () => {
    expect(workflow).toMatch(/\n {2}workflow_dispatch:\n/);
  });

  it('runs only on schedule or dispatch', () => {
    expect(drift()).toContain(
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    );
  });

  it('authenticates as the read-only planner', () => {
    expect(drift()).toContain('service_account: ${{ vars.INFRA_PLANNER_SA }}');
  });

  it('never holds the deployer', () => {
    expect(drift()).not.toContain('INFRA_DEPLOYER_SA');
  });

  it('never applies', () => {
    expect(drift()).not.toContain('tofu apply');
  });

  it.each([
    { exit: 0, status: 0, title: '' },
    { exit: 1, status: 1, title: 'Plan failed' },
    { exit: 2, status: 2, title: 'Drift' },
  ])('exits $status with "$title" when tofu plan exits $exit', ({ exit, status, title }) => {
    const r = execute(script(), {}, exit);
    expect(r.status).toBe(status);
    expect(r.out).toContain(title === '' ? '' : `::error title=${title}::`);
  });

  it('does not call an error drift', () => {
    expect(execute(script(), {}, 1).out).not.toContain('title=Drift');
  });
});

describe('infra.yml remote state: the fail-closed step, executed', () => {
  const requireBody = (name: string): string =>
    runBodies(job(name)).find((b) => b.includes('[ -z')) ?? '';
  const both = { TF_STATE_BUCKET: 'bucket', TF_STATE_PREFIX: 'prefix' };

  it.each(pairs(cloudJobs, stateVars))(
    '$name reads $token from a repository variable',
    ({ name, token }) => {
      expect(job(name)).toContain(`${token}: \${{ vars.${token} }}`);
    },
  );

  it.each(cloudJobs)('%s passes when both variables are set', (name) => {
    expect(execute(requireBody(name), both).status).toBe(0);
  });

  it.each(pairs(cloudJobs, stateVars))('$name fails when $token is unset', ({ name, token }) => {
    const env: Record<string, string> = { ...both };
    delete env[token];
    expect(execute(requireBody(name), env).status).toBe(1);
  });

  it.each(pairs(cloudJobs, stateVars))('$name fails when $token is empty', ({ name, token }) => {
    expect(execute(requireBody(name), { ...both, [token]: '' }).status).toBe(1);
  });

  it.each(cloudJobs)('%s checks the state location before it authenticates', (name) => {
    const text = job(name);
    expect(text.indexOf('Require remote state')).toBeGreaterThan(-1);
    expect(text.indexOf('Require remote state')).toBeLessThan(
      text.indexOf('google-github-actions/auth'),
    );
  });

  it.each(cloudJobs)('%s passes the bucket and prefix to tofu init', (name) => {
    expect(job(name)).toContain(
      'tofu init -input=false -backend-config="bucket=${TF_STATE_BUCKET}" -backend-config="prefix=${TF_STATE_PREFIX}"',
    );
  });
});

// ------------------------------------------------------------------ module

type Resource = { type: string; name: string; body: string };
type Grant = {
  target: string;
  role: string;
  member: string;
  condition?: string | undefined;
  gated: boolean;
};

const resources: Resource[] = [
  ...moduleCode.matchAll(/^resource "([a-z_]+)" "(\w+)" \{\n([\s\S]*?)\n\}$/gm),
].map((m) => ({ type: m[1] as string, name: m[2] as string, body: m[3] as string }));

const locals = new Map<string, string>();
for (const block of moduleCode.matchAll(/^locals \{\n([\s\S]*?)\n\}$/gm)) {
  for (const l of (block[1] as string).matchAll(/^ {2}(\w+) = "(.*)"$/gm)) {
    locals.set(l[1] as string, l[2] as string);
  }
}

const resolve = (s: string): string => {
  let out = s;
  for (let i = 0; i < 5; i++) {
    out = out.replace(/\$\{local\.(\w+)\}/g, (_, n: string) => locals.get(n) ?? `<?${n}>`);
  }
  return out;
};
const norm = (s: string): string => s.replace(/\$\{var\.(\w+)\}/g, '<$1>');

/** A resource's identity independent of its Terraform name. */
function tagOf(type: string, name: string): string {
  const r = resources.find((x) => x.type === type && x.name === name);
  if (r === undefined) return `?${type}.${name}`;
  if (type === 'google_service_account') {
    return /account_id = "\$\{var\.name_prefix\}-(\w+)"/.exec(r.body)?.[1] ?? name;
  }
  if (type === 'google_storage_bucket')
    return /name = local\.(\w+)_bucket/.exec(r.body)?.[1] ?? name;
  return /role_id = ".*\}_(\w+)"/.exec(r.body)?.[1] ?? name;
}

const refs = (s: string): string =>
  s
    .replace(
      /google_service_account\.(\w+)(?:\[0\])?\.(?:email|name)/g,
      (_, n: string) => `sa:${tagOf('google_service_account', n)}`,
    )
    .replace(
      /google_storage_bucket\.(\w+)\.name/g,
      (_, n: string) => `bucket:${tagOf('google_storage_bucket', n)}`,
    )
    .replace(
      /google_project_iam_custom_role\.(\w+)(?:\[0\])?\.name/g,
      (_, n: string) => `role:${tagOf('google_project_iam_custom_role', n)}`,
    )
    .replace(/\$\{((?:sa|bucket|role):\w+)\}/g, '$1');

const grants: Grant[] = resources
  .filter((r) => r.type.endsWith('_iam_member'))
  .flatMap((r) => {
    const lines = r.body.split('\n');
    const memberLine = lines.find((l) => /^\s*member = /.test(l)) ?? '';
    const memberRaw = /member = "(.*)"$/.exec(memberLine)?.[1] ?? '';
    const pool = /^\$\{local\.pool_principal\}\/attribute\.(\w+)\/(.*)$/.exec(memberRaw);
    const member = pool
      ? `wif:${pool[1]}=${norm(resolve(pool[2] as string))}`
      : refs(memberRaw).replace(/^serviceAccount:/, '');
    const rest = lines.filter((l) => l !== memberLine).join('\n');
    const resolved = refs(rest);
    const targets =
      r.type === 'google_project_iam_member'
        ? ['project']
        : [...resolved.matchAll(/(?:bucket|sa):\w+/g)].map((m) => m[0]);
    const roles = [...rest.matchAll(/"(roles\/[\w.]+)"/g), ...resolved.matchAll(/(role:\w+)/g)].map(
      (m) => m[1] as string,
    );
    const expression = /expression = "(.*)"$/m.exec(rest)?.[1];
    const condition = expression === undefined ? undefined : refs(resolve(expression));
    const gated = r.body.includes('var.create_deployer');
    return targets.flatMap((target) =>
      roles.map((role) => ({ target, role, member, condition, gated })),
    );
  });

const to = (member: string): string[] =>
  grants
    .filter((g) => g.member === member)
    .map((g) => `${g.target} ${g.role}`)
    .sort();

const variableBlock = (name: string): string =>
  moduleText
    .split(/^variable "/m)
    .slice(1)
    .find((b) => b.startsWith(`${name}"`)) ?? '';
const defaultOf = (name: string): string | undefined =>
  /default\s*=\s*"?([^"\n]+)"?/.exec(variableBlock(name))?.[1];
const ruleOf = (name: string): RegExp =>
  new RegExp(/regex\("([^"]+)"/.exec(variableBlock(name))?.[1] ?? '(?!)');

describe('module: what is granted, and to whom', () => {
  it('parses the grants it asserts on', () => {
    expect(grants.length).toBeGreaterThanOrEqual(15);
  });

  it('gives the publisher only create and overwrite on the corpus bucket', () => {
    expect(to('sa:publisher')).toEqual([
      'bucket:corpus roles/storage.objectCreator',
      'bucket:corpus roles/storage.objectUser',
    ]);
  });

  const publisher = (role: string): Grant | undefined =>
    grants.find((g) => g.member === 'sa:publisher' && g.role === role);

  it.each(['corpus/', 'manifests/', 'refs/main'])('lets the publisher create under %s', (path) => {
    expect(publisher('roles/storage.objectCreator')?.condition).toContain(
      `bucket:corpus/objects/${path}`,
    );
  });

  it('lets the publisher overwrite the refs/main object by exact name, and nothing else', () => {
    expect(publisher('roles/storage.objectUser')?.condition).toBe(
      "resource.name == 'projects/_/buckets/bucket:corpus/objects/refs/main'",
    );
  });

  it('gives the reader only objectViewer on the corpus bucket', () => {
    expect(to('sa:reader')).toEqual(['bucket:corpus roles/storage.objectViewer']);
  });

  it('gives the deployer exactly its stated reach', () => {
    expect(to('sa:deployer')).toEqual(
      [
        'project role:deployer_project',
        'project roles/iam.workloadIdentityPoolAdmin',
        'project roles/serviceusage.serviceUsageAdmin',
        'bucket:corpus roles/storage.admin',
        'bucket:state roles/storage.admin',
        'sa:publisher roles/iam.serviceAccountAdmin',
        'sa:reader roles/iam.serviceAccountAdmin',
        'sa:deployer roles/iam.serviceAccountAdmin',
        'sa:planner roles/iam.serviceAccountAdmin',
      ].sort(),
    );
  });

  it('gives the planner only read roles, custom roles included', () => {
    expect(to('sa:planner')).toEqual([
      'bucket:corpus role:planner_bucket',
      'bucket:state role:planner_bucket',
      'bucket:state roles/storage.objectViewer',
      'project role:planner',
    ]);
  });

  it.each([
    'sa:publisher <- wif:repo_id_workflow=<corpus_repo_id>@refs/heads/main|<corpus_repo>/<publish_workflow_path>@refs/heads/main',
    'sa:reader <- wif:repository_owner_id=<github_owner_id>',
    'sa:planner <- wif:repo_id_workflow=<governance_repo_id>@refs/heads/main|<governance_repo>/<deploy_workflow_path>@refs/heads/main',
    'sa:deployer <- wif:repo_id_workflow_env=<governance_repo_id>@refs/heads/main|<governance_repo>/<deploy_workflow_path>@refs/heads/main|<deploy_environment>',
  ])('binds impersonation: %s', (binding) => {
    const bindings = grants
      .filter((g) => g.role === 'roles/iam.workloadIdentityUser')
      .map((g) => `${g.target} <- ${g.member}`);
    expect(bindings).toContain(binding);
  });

  it('binds no other impersonation', () => {
    expect(grants.filter((g) => g.role === 'roles/iam.workloadIdentityUser')).toHaveLength(4);
  });

  it('keeps the planner out of the deployer principal: they use different attributes', () => {
    const attr = (target: string): string | undefined =>
      /wif:(\w+)=/.exec(
        grants.find((g) => g.role === 'roles/iam.workloadIdentityUser' && g.target === target)
          ?.member ?? '',
      )?.[1];
    expect(attr('sa:deployer')).not.toBe(attr('sa:planner'));
  });

  it.each(['repo_id_workflow', 'repo_id_workflow_env', 'repository_owner_id'])(
    'maps attribute.%s in the provider',
    (attribute) => {
      expect(moduleText).toContain(`"attribute.${attribute}" =`);
    },
  );

  it.each([
    'assertion.repository_id',
    'assertion.ref',
    'assertion.job_workflow_ref',
    'assertion.environment',
  ])('builds repo_id_workflow_env from %s', (claim) => {
    const line =
      moduleText.split('\n').find((l) => l.includes('"attribute.repo_id_workflow_env" =')) ?? '';
    expect(line).toContain(claim);
  });

  it('tolerates a job with no environment claim', () => {
    expect(moduleText).toContain('has(assertion.environment)');
  });

  it('always requires the owner id in the provider condition', () => {
    expect(moduleText).toContain("assertion.repository_owner_id == '${var.github_owner_id}'");
  });

  it('only narrows the provider condition with a custom one', () => {
    expect(moduleText).toContain(
      '"(${local.owner_id_condition}) && (${var.allowed_owner_condition})"',
    );
  });

  it('never trusts the owner name', () => {
    expect(moduleText).not.toContain('var.github_owner}');
  });

  it.each(['corpus_repo', 'governance_repo'])(
    'uses the %s name only after its numeric id',
    (name) => {
      const uses = [...locals.values()].filter((v) => v.includes(`var.${name}}`));
      const after = new RegExp(
        `^\\$\\{var\\.${name}_id\\}@refs/heads/main\\|\\$\\{var\\.${name}\\}/`,
      );
      expect(uses.filter((v) => !after.test(v))).toEqual([]);
    },
  );
});

describe('module: additive IAM and no keys', () => {
  it('declares no iam_binding, iam_policy or audit config resource', () => {
    expect(
      resources.map((r) => r.type).filter((t) => /_iam_(binding|policy|audit_config)$/.test(t)),
    ).toEqual([]);
  });

  it('creates no service account key', () => {
    expect(moduleText).not.toContain('google_service_account_key');
  });

  it('uses no owner, editor, project IAM admin, IAM admin or security admin role', () => {
    expect(moduleCode).not.toMatch(
      /roles\/(owner|editor|resourcemanager\.projectIamAdmin|iam\.securityAdmin|iam\.admin)"/,
    );
  });

  it('never grants objectAdmin', () => {
    expect(moduleCode).not.toContain('roles/storage.objectAdmin');
  });

  it('gates every grant that involves the deployer or planner on create_deployer', () => {
    const involved = grants.filter((g) => /sa:(deployer|planner)/.test(`${g.member} ${g.target}`));
    expect(involved.length).toBeGreaterThan(0);
    expect(involved.filter((g) => !g.gated)).toEqual([]);
  });

  it('gates every project-level grant on create_deployer', () => {
    expect(grants.filter((g) => g.target === 'project' && !g.gated)).toEqual([]);
  });

  it('gates the deployer and planner accounts and every custom role on create_deployer', () => {
    const subjects = resources.filter(
      (r) =>
        r.type === 'google_project_iam_custom_role' ||
        (r.type === 'google_service_account' && /deployer|planner/.test(tagOf(r.type, r.name))),
    );
    expect(
      subjects.filter((r) => !r.body.includes('var.create_deployer')).map((r) => r.name),
    ).toEqual([]);
  });

  const customRoles = resources.filter((r) => r.type === 'google_project_iam_custom_role');
  const permissionsOf = (r: Resource): string[] =>
    [...(/permissions = \[([\s\S]*?)\]/.exec(r.body)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(
      (m) => m[1] as string,
    );

  it('has three custom roles', () => {
    expect(customRoles).toHaveLength(3);
  });

  it('gives no custom role a permission that sets a policy', () => {
    expect(customRoles.flatMap(permissionsOf).filter((p) => /\.set\w*Policy$/.test(p))).toEqual([]);
  });

  it('gives the planner roles read permissions only', () => {
    const planner = customRoles.filter((r) => tagOf(r.type, r.name).startsWith('planner'));
    expect(planner).toHaveLength(2);
    expect(
      planner.flatMap(permissionsOf).filter((p) => !/\.(get|list|getIamPolicy)$/.test(p)),
    ).toEqual([]);
  });
});

describe('module: buckets, APIs and versions', () => {
  const buckets = resources.filter((r) => r.type === 'google_storage_bucket');

  it('has the corpus and state buckets', () => {
    expect(buckets.map((b) => tagOf(b.type, b.name)).sort()).toEqual(['corpus', 'state']);
  });

  it.each([
    { setting: 'uniform bucket-level access', re: /uniform_bucket_level_access = true/ },
    { setting: 'public access prevention', re: /public_access_prevention = "enforced"/ },
    { setting: 'versioning', re: /versioning \{\n\s+enabled = true/ },
  ])('sets $setting on every bucket', ({ re }) => {
    expect(buckets.filter((b) => !re.test(b.body)).map((b) => tagOf(b.type, b.name))).toEqual([]);
  });

  it('protects the state bucket from destroy', () => {
    const state = buckets.find((b) => tagOf(b.type, b.name) === 'state');
    expect(state?.body).toContain('prevent_destroy = true');
  });

  it('keeps old corpus versions for a configurable number of days', () => {
    const corpus = buckets.find((b) => tagOf(b.type, b.name) === 'corpus');
    expect(corpus?.body).toContain('days_since_noncurrent_time = var.noncurrent_retention_days');
  });

  it('defaults the retention to 30 days', () => {
    expect(defaultOf('noncurrent_retention_days')).toBe('30');
  });

  it.each(['Too short', 'too long'])(
    'states the failure direction of the retention: "%s"',
    (phrase) => {
      expect(variableBlock('noncurrent_retention_days')).toContain(phrase);
    },
  );

  it('fits the longest pool id in the 32 characters GCP allows', () => {
    const prefix = Number(/\{1,(\d+)\}/.exec(variableBlock('name_prefix'))?.[1]) + 1;
    const suffix = Number(/\{0,(\d+)\}/.exec(variableBlock('pool_suffix'))?.[1]);
    expect(prefix + '-github-'.length + suffix).toBeLessThanOrEqual(32);
  });

  it('never disables an API on destroy', () => {
    expect(moduleCode).toContain('disable_on_destroy = false');
  });

  it('enables exactly the five APIs it needs', () => {
    const services = [...moduleCode.matchAll(/"([a-z]+\.googleapis\.com)"/g)].map((m) => m[1]);
    expect(services.sort()).toEqual([
      'cloudresourcemanager.googleapis.com',
      'iam.googleapis.com',
      'iamcredentials.googleapis.com',
      'storage.googleapis.com',
      'sts.googleapis.com',
    ]);
  });

  it('exposes exactly the seven outputs', () => {
    const outputs = [...moduleCode.matchAll(/^output "(\w+)"/gm)].map((m) => m[1]);
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

  it('pins OpenTofu ~> 1.12', () => {
    expect(moduleText).toContain('required_version = "~> 1.12"');
  });

  it('pins a specific google provider minor', () => {
    expect(moduleText).toMatch(/version = "~> \d+\.\d+\.0"/);
  });

  it.each(['verevoir', 'ai-gency'])('contains no hard-coded %s, comments included', (word) => {
    expect(moduleText.toLowerCase()).not.toContain(word);
  });
});

describe('module: input rules', () => {
  const rules = [
    {
      vars: ['github_owner_id', 'corpus_repo_id', 'governance_repo_id'],
      ok: ['266172281'],
      bad: ['', 'verevoir', '12a', '-1', '1 2'],
    },
    {
      vars: ['corpus_repo', 'governance_repo'],
      ok: ['verevoir/aigency-governance'],
      bad: ['', 'noslash', 'a/b/c', 'a b/c', '/x'],
    },
    {
      vars: ['name_prefix'],
      ok: ['review', 'rvw-corp', 'abcdefghij'],
      bad: ['', 'a', 'Review', '1abc', 'a_b', 'abcdefghijk'],
    },
    { vars: ['pool_suffix'], ok: ['', 'r2', 'abc-123'], bad: ['R2', 'a_b', 'abcdefghijklm'] },
    {
      vars: ['publish_workflow_path', 'deploy_workflow_path'],
      ok: ['.github/workflows/infra.yml'],
      bad: ['', 'a b', 'x?y', 'a;b'],
    },
    { vars: ['deploy_environment'], ok: ['infra-apply'], bad: ['', 'a b', 'x;y'] },
  ];
  const cases = rules.flatMap((r) =>
    r.vars.flatMap((v) => [
      ...r.ok.map((s) => ({ v, s, accepted: true })),
      ...r.bad.map((s) => ({ v, s, accepted: false })),
    ]),
  );

  it.each(cases)('$v accepted=$accepted for "$s"', ({ v, s, accepted }) => {
    expect(ruleOf(v).test(s)).toBe(accepted);
  });

  it.each(['publish_workflow_path', 'deploy_workflow_path'])(
    '%s rejects an absolute path',
    (name) => {
      expect(variableBlock(name)).toContain(`!startswith(var.${name}, "/")`);
    },
  );

  it('defaults the deploy environment to the one the workflow waits in', () => {
    expect(defaultOf('deploy_environment')).toBe('infra-apply');
  });
});

// ------------------------------------------------------------ installation

describe('verevoir installation', () => {
  const call = /module "review_corpus" \{\n([\s\S]*?)\n\}/.exec(installation)?.[1] ?? '';
  const passed = [...code(call).matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1] as string);
  const required = moduleText
    .split(/^variable "/m)
    .slice(1)
    .filter((b) => !/^ {2}default\b/m.test(b))
    .map((b) => /^(\w+)"/.exec(b)?.[1] as string);

  it.each(required)('passes the required input %s', (name) => {
    expect(passed).toContain(name);
  });

  it('passes no input the module does not declare', () => {
    const declared = moduleText
      .split(/^variable "/m)
      .slice(1)
      .map((b) => /^(\w+)"/.exec(b)?.[1]);
    expect(passed.filter((n) => n !== 'source' && !declared.includes(n))).toEqual([]);
  });

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

  it('declares a partial gcs backend', () => {
    expect(code(installation)).toMatch(/backend "gcs" \{\s*\}/);
  });

  it('bakes no bucket or prefix into the code', () => {
    expect(code(installation)).not.toMatch(/\b(bucket|prefix)\s*=/);
  });

  it.each(['-migrate-state', 'BOOTSTRAP'])(
    'no longer carries the local-bootstrap marker %s',
    (marker) => {
      expect(installation).not.toContain(marker);
    },
  );

  it.each(['-backend-config', 'TF_STATE_BUCKET', 'TF_STATE_PREFIX'])(
    'explains in a comment how %s reaches init',
    (token) => {
      expect(installation).toContain(token);
    },
  );
});

// ----------------------------------------------------------------- INSTALL

describe('INSTALL.md matches the code', () => {
  it.each([
    'TF_STATE_BUCKET',
    'TF_STATE_PREFIX',
    'INFRA_PLANNER_SA',
    'infra-apply',
    '-backend-config',
    'tofu import',
    'repo_id_workflow_env',
    'deploy_environment',
    'noncurrent_retention_days',
    'INSTALLATION',
  ])('documents %s', (token) => {
    expect(install).toContain(token);
  });

  it.each(['--versioning', '--uniform-bucket-level-access', '--public-access-prevention'])(
    'documents creating the state bucket with %s',
    (flag) => {
      expect(install).toContain(flag);
    },
  );

  it('enables the Storage API before creating the state bucket', () => {
    const enable = install.indexOf('gcloud services enable storage.googleapis.com');
    expect(enable).toBeGreaterThan(-1);
    expect(enable).toBeLessThan(install.indexOf('gcloud storage buckets create'));
  });

  it.each([
    'migrate-state',
    'Uncomment the `backend',
    'cannot widen its own access',
    'no role that can grant roles',
    'plans again',
    'two `infra/installations/verevoir` paths',
  ])('no longer says: %s', (stale) => {
    expect(flat).not.toContain(stale);
  });

  it('lists the provider variable as used by plan, apply and drift', () => {
    expect(flat).toMatch(
      /INFRA_WIF_PROVIDER[^|]*\|[^|]*\|[^|]*\|\s*`infra.yml`, the plan, apply and drift jobs/,
    );
  });

  it('says the publisher can read refs/main only', () => {
    expect(flat).toContain('can read only `refs/main`');
  });

  it('states the deployer residual risk', () => {
    expect(flat).toMatch(/accepted\s+residual\s+risk/);
  });

  it('requires a dedicated project', () => {
    expect(flat).toContain('**dedicated project**');
  });

  it('says the environment does not enforce the reviewers', () => {
    expect(flat).toContain('does NOT enforce is the reviewers');
  });

  it('says there is no owned drift alert channel', () => {
    expect(flat).toContain('no owned alert channel');
  });

  it('says the scan image is pulled by tag', () => {
    expect(flat).toContain('docker image by tag');
  });

  it('names the plan artifact retention', () => {
    expect(flat).toContain('kept 7 days');
  });

  it('keeps the first-apply caveat for the custom roles and the mapping', () => {
    expect(flat).toContain('first evaluated by a real apply');
  });

  it('says the custom roles are three', () => {
    expect(flat).not.toMatch(/the custom role\b/);
  });

  it('puts the ordering guard for refs/main on the publish workflow', () => {
    expect(flat).toContain('`refs/main` has no ordering guard');
  });

  it('states the residual risk in iam.tf', () => {
    expect(iamSource).toContain('accepted residual risk');
  });

  it('requires a dedicated project in iam.tf', () => {
    expect(iamSource).toContain('DEDICATED project');
  });

  it.each(['cannot widen its own access', 'no role that can grant roles'])(
    'iam.tf no longer claims: %s',
    (claim) => {
      expect(iamSource).not.toContain(claim);
    },
  );
});
