// Pins the SHAPE of the keyless-corpus installation: infra.yml and the
// OpenTofu module. Text-level, no cloud, no tofu, no YAML or HCL dependency.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const workflow = read('.github/workflows/infra.yml');
const moduleDir = new URL('infra/modules/review-corpus/', root);
const moduleFiles = readdirSync(moduleDir).filter((f) => f.endsWith('.tf'));
const moduleText = moduleFiles.map((f) => readFileSync(new URL(f, moduleDir), 'utf8')).join('\n');
const installation = read('infra/installations/verevoir/main.tf');

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

describe('infra.yml shape', () => {
  it('pins both named actions by full SHA with a version comment', () => {
    expect(workflow).toContain(
      'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0',
    );
    expect(workflow).toContain(
      'opentofu/setup-opentofu@a1320f892987e89d278cc92dc5adc984fb93aca4 # v2.0.2',
    );
  });

  it('pins every action by 40-hex SHA with a version comment', () => {
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(.+)$/gm)].map((m) => m[1] as string);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const u of uses) {
      expect(u, u).toMatch(/^\S+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  it('has exact permissions: top level and check read-only; apply adds only id-token: write', () => {
    expect(entries(/^permissions:\n((?: {2}.+\n)+)/m.exec(workflow)?.[1])).toEqual([
      'contents: read',
    ]);
    const perms = (name: string): string[] =>
      entries(/^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(job(name))?.[1]);
    expect(perms('check')).toEqual(['contents: read']);
    expect(perms('apply')).toEqual(['contents: read', 'id-token: write']);
  });

  it('never expands ${{ }} inside a run: body', () => {
    const bodies = runBodies(workflow);
    expect(bodies.length).toBeGreaterThanOrEqual(5);
    for (const body of bodies) expect(body).not.toContain('${{');
  });

  it('checks out with persist-credentials: false every time', () => {
    const checkouts = workflow.match(/uses: actions\/checkout@/g) ?? [];
    const persist = workflow.match(/persist-credentials: false/g) ?? [];
    expect(checkouts.length).toBe(2);
    expect(persist.length).toBe(checkouts.length);
  });

  it('gives the pull request path no credentials', () => {
    const check = job('check');
    expect(check).toContain("github.event_name == 'pull_request'");
    expect(check).not.toContain('google-github-actions/auth');
    expect(check).not.toContain('id-token');
    expect(check).not.toContain('secrets.');
    expect(check).not.toContain('vars.');
    expect(check).toContain('tofu fmt -check -recursive');
    expect(check).toContain('tofu validate');
    expect(check).toContain('tofu init -backend=false');
    expect(check).not.toContain('tofu apply');
  });

  it('applies only on push to main, as the deployer, from variables', () => {
    const apply = job('apply');
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]/);
    expect(apply).toContain("github.event_name == 'push'");
    expect(apply).toContain('workload_identity_provider: ${{ vars.INFRA_WIF_PROVIDER }}');
    expect(apply).toContain('service_account: ${{ vars.INFRA_DEPLOYER_SA }}');
    expect(apply).not.toContain('secrets.');
    expect(apply).toContain('tofu apply');
    expect(apply).toContain('infra/installations/verevoir');
  });

  it('serialises applies', () => {
    const apply = job('apply');
    expect(apply).toMatch(/concurrency:\n {6}group: \S+\n {6}cancel-in-progress: false/);
  });

  it('keeps the whole workflow free of secrets', () => {
    expect(code(workflow)).not.toContain('secrets.');
  });
});

describe('review-corpus module shape', () => {
  it('contains no hard-coded verevoir or ai-gency, in any file, comments included', () => {
    expect(moduleFiles.length).toBeGreaterThanOrEqual(5);
    expect(moduleText.toLowerCase()).not.toContain('verevoir');
    expect(moduleText.toLowerCase()).not.toContain('ai-gency');
  });

  it('pins OpenTofu ~> 1.12 and a specific google provider minor', () => {
    expect(moduleText).toContain('required_version = "~> 1.12"');
    expect(moduleText).toMatch(/source\s*=\s*"hashicorp\/google"/);
    expect(moduleText).toMatch(/version\s*=\s*"~> \d+\.\d+\.0"/);
  });

  it('protects the buckets', () => {
    expect(moduleText.match(/uniform_bucket_level_access = true/g)).toHaveLength(2);
    expect(moduleText.match(/public_access_prevention\s+= "enforced"/g)).toHaveLength(2);
    expect(moduleText.match(/versioning \{\n\s+enabled = true/g)).toHaveLength(2);
    expect(moduleText).toContain('days_since_noncurrent_time = 30');
    expect(moduleText).toContain('prevent_destroy = true');
  });

  it('uses no owner or editor role and leaves unrelated APIs alone', () => {
    expect(moduleText).not.toMatch(/roles\/(owner|editor)/);
    expect(moduleText).toMatch(/disable_on_destroy\s+= false/);
    const services = [...moduleText.matchAll(/"([a-z]+\.googleapis\.com)"/g)].map((m) => m[1]);
    expect(services.sort()).toEqual([
      'cloudresourcemanager.googleapis.com',
      'iam.googleapis.com',
      'iamcredentials.googleapis.com',
      'storage.googleapis.com',
      'sts.googleapis.com',
    ]);
  });

  it('binds the deployer only to the governance repo on main', () => {
    expect(moduleText).toContain(
      '${local.pool_principal}/attribute.repo_id_workflow/${local.deployer_identity}"',
    );
  });

  it('exposes the six outputs', () => {
    const outputs = [...moduleText.matchAll(/^output "([a-z_]+)"/gm)].map((m) => m[1]);
    expect(outputs.sort()).toEqual([
      'corpus_bucket',
      'deployer_sa',
      'publisher_sa',
      'reader_sa',
      'state_bucket',
      'wif_provider',
    ]);
  });
});

describe('verevoir installation', () => {
  it('passes every required module input and no unknown one', () => {
    const variables = moduleText
      .split(/^variable "/m)
      .slice(1)
      .map((b) => ({
        name: /^([a-z_]+)"/.exec(b)?.[1] as string,
        hasDefault: /^ {2}default\b/m.test(b),
      }));
    const required = variables.filter((v) => !v.hasDefault).map((v) => v.name);
    expect(required.sort()).toEqual([
      'corpus_repo',
      'corpus_repo_id',
      'github_owner',
      'github_owner_id',
      'governance_repo',
      'governance_repo_id',
      'project_id',
      'region',
    ]);
    const call = /module "review_corpus" \{\n([\s\S]*?)\n\}/.exec(installation)?.[1] ?? '';
    const passed = [...code(call).matchAll(/^\s*([a-z_]+)\s*=/gm)].map((m) => m[1] as string);
    for (const name of required) expect(passed, name).toContain(name);
    for (const name of passed) {
      if (name === 'source') continue;
      expect(
        variables.map((v) => v.name),
        name,
      ).toContain(name);
    }
  });

  it('holds only the installation values and a commented bootstrap backend', () => {
    expect(installation).toContain('project_id         = "ai-gency"');
    expect(installation).toContain('region             = "europe-west2"');
    expect(installation).toContain('github_owner       = "verevoir"');
    expect(installation).toContain('github_owner_id    = "266172281"');
    expect(installation).toContain('corpus_repo        = "verevoir/aigency-guardrails"');
    expect(installation).toContain('corpus_repo_id     = "1238645336"');
    expect(installation).toContain('governance_repo    = "verevoir/aigency-governance"');
    expect(installation).toContain('governance_repo_id = "1334340199"');
    expect(installation).toContain('BOOTSTRAP');
    expect(installation).toContain('tofu init -migrate-state');
    expect(installation).toMatch(/^\s*# backend "gcs" \{/m);
    expect(code(installation)).not.toContain('backend "gcs"');
  });
});

describe('shared-project guards', () => {
  const moduleCode = code(moduleText);
  const blocks = moduleCode.split(/^resource "/m).slice(1);
  const header = (b: string): string => b.split('{')[0] as string;

  it('uses additive IAM only: no iam_binding and no iam_policy', () => {
    expect(moduleText).not.toContain('_iam_binding');
    expect(moduleText).not.toContain('_iam_policy');
    for (const b of blocks) expect(header(b), header(b)).not.toMatch(/_iam_(binding|policy)"/);
    // IAM grant types only (workload identity pools are not grants).
    const grants = blocks.filter((b) =>
      /^google_(project|storage_bucket|service_account)_iam_\w+"/.test(header(b)),
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const b of grants) expect(header(b), header(b)).toMatch(/_iam_(member|custom_role)"/);
  });

  it('manage_apis=false creates no project service; true never disables on destroy', () => {
    const api = blocks.find((b) => b.startsWith('google_project_service')) as string;
    expect(api).toMatch(/for_each\s*=\s*var\.manage_apis \?/);
    expect(api).toContain('disable_on_destroy         = false');
    expect(api).toContain('disable_dependent_services = false');
    expect(moduleText).toMatch(/variable "manage_apis" \{[\s\S]*?default\s+= true/);
  });

  it('create_deployer=false leaves no deployer resource and no project-level grant', () => {
    expect(moduleText).toMatch(/variable "create_deployer" \{[\s\S]*?default\s+= true/);
    const deployerOrProject = blocks.filter(
      (b) => /deployer/.test(header(b)) || /^google_project_iam/.test(b),
    );
    expect(deployerOrProject.length).toBeGreaterThanOrEqual(6);
    for (const b of deployerOrProject) {
      expect(b, header(b)).toMatch(/(count|for_each)\s*=\s*var\.create_deployer \?/);
    }
    // Every project-level IAM resource is one of those, i.e. deployer-only.
    for (const b of blocks.filter((x) => /^google_project_iam/.test(x))) {
      expect(header(b), header(b)).toContain('deployer');
    }
  });

  it('binds the publisher to the corpus repo id on main only', () => {
    expect(moduleText).toContain(
      '${local.pool_principal}/attribute.repo_id_workflow/${local.publisher_identity}"',
    );
    expect(moduleText).not.toContain('attribute.repository/');
    expect(moduleText).not.toContain('attribute.repo_ref');
    expect(moduleText).not.toContain('attribute.repo_id_ref');
  });

  it('binds publisher and deployer to the exact repo id, ref AND workflow file', () => {
    expect(moduleText).toContain(
      'publisher_identity = "${var.corpus_repo_id}@refs/heads/main|${var.corpus_repo}/${var.publish_workflow_path}@refs/heads/main"',
    );
    expect(moduleText).toContain(
      'deployer_identity  = "${var.governance_repo_id}@refs/heads/main|${var.governance_repo}/${var.deploy_workflow_path}@refs/heads/main"',
    );
    expect(moduleText).toContain(
      '"attribute.repo_id_workflow"    = "assertion.repository_id + \'@\' + assertion.ref + \'|\' + assertion.job_workflow_ref"',
    );
    expect(moduleText).toContain('"attribute.job_workflow_ref"    = "assertion.job_workflow_ref"');
    const defaults = (name: string): string | undefined =>
      new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s+= "([^"]+)"`).exec(moduleText)?.[1];
    expect(defaults('publish_workflow_path')).toBe('.github/workflows/publish-corpus.yml');
    expect(defaults('deploy_workflow_path')).toBe('.github/workflows/infra.yml');
    const members = [
      ...moduleCode.matchAll(/^\s*member\s*=\s*"(\$\{local\.pool_principal\}[^"]*)"/gm),
    ].map((m) => m[1] as string);
    const wf = members.filter((p) => p.includes('attribute.repo_id_workflow/'));
    expect(wf).toEqual([
      '${local.pool_principal}/attribute.repo_id_workflow/${local.publisher_identity}',
      '${local.pool_principal}/attribute.repo_id_workflow/${local.deployer_identity}',
    ]);
    // Exact match: no wildcard, no prefix operator, and nothing trails the ref.
    for (const p of wf) expect(p).not.toMatch(/[*]|startsWith/);
    for (const id of ['publisher_identity', 'deployer_identity']) {
      expect(moduleCode).toMatch(new RegExp(`${id}\\s+= "[^"]*@refs/heads/main"\\n`));
    }
    // The workflow file is mandatory: nothing binds a repo+ref without it.
    expect(moduleText).not.toMatch(/attribute\.repo_id_ref|attribute\.ref\//);
  });

  it('ends publisher and deployer principals exactly in @refs/heads/main, with no wildcard', () => {
    const identities = [
      ...moduleCode.matchAll(/^\s*(publisher|deployer)_identity\s*=\s*"([^"]*)"/gm),
    ].map((m) => m[2] as string);
    expect(identities).toHaveLength(2);
    for (const v of identities) {
      expect(v.endsWith('@refs/heads/main')).toBe(true);
      expect(v).not.toMatch(/[*]|startsWith/);
      expect(v).toContain('@refs/heads/main|');
    }
    expect(identities[0]).toContain('${var.corpus_repo_id}@');
    expect(identities[1]).toContain('${var.governance_repo_id}@');
  });

  it('pins trust on numeric ids: provider condition and reader', () => {
    expect(moduleText).toContain("assertion.repository_owner_id == '${var.github_owner_id}'");
    expect(moduleText).toContain('"attribute.repository_id"       = "assertion.repository_id"');
    expect(moduleText).toContain('= "assertion.repository_owner_id"');
    expect(moduleText).toContain(
      '${local.pool_principal}/attribute.repository_owner_id/${var.github_owner_id}"',
    );
    expect(moduleText).not.toContain('var.github_owner}');
    // A repo NAME may appear only inside the workflow identity, and there the
    // numeric id comes first, so a name never appears without its id.
    for (const name of ['corpus_repo', 'governance_repo']) {
      const uses = moduleCode.split('\n').filter((l) => l.includes(`var.${name}}`));
      expect(uses.length, name).toBeGreaterThan(0);
      for (const l of uses) {
        expect(l, l).toMatch(
          new RegExp(
            `_identity\\s+= "\\$\\{var\\.${name}_id\\}@refs/heads/main\\|\\$\\{var\\.${name}\\}/`,
          ),
        );
      }
    }
    expect(moduleCode).toMatch(/attribute_condition\s+=.*local\.owner_id_condition/);
  });

  it('gives the reader objectViewer on the corpus bucket and nothing that writes', () => {
    const reader = blocks.filter((b) => /^google_[a-z_]+"\s*"reader(_wif)?"/.test(b));
    const grants = blocks.filter((b) => /^google_storage_bucket_iam_member"\s*"reader"/.test(b));
    expect(reader.length).toBe(3);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('role   = "roles/storage.objectViewer"');
    // Any role granted to the reader is objectViewer or workloadIdentityUser on its own SA.
    for (const b of reader) {
      const roles = [...b.matchAll(/role\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      for (const r of roles) {
        expect(['roles/storage.objectViewer', 'roles/iam.workloadIdentityUser']).toContain(r);
      }
    }
    // No write-capable storage role is granted to the reader's member anywhere.
    for (const b of blocks.filter((x) => x.includes('google_service_account.reader.email'))) {
      expect(b).not.toMatch(
        /roles\/storage\.(objectCreator|objectUser|objectAdmin|admin|legacy\w*)/,
      );
      expect(b).not.toMatch(/roles\/(owner|editor)/);
    }
  });

  it('limits the publisher: create by prefix, overwrite refs/main only, no objectAdmin', () => {
    expect(moduleText).not.toContain('roles/storage.objectAdmin');
    const create = blocks.find((b) => b.includes('"publisher_create"')) as string;
    expect(create).toContain('role   = "roles/storage.objectCreator"');
    expect(create).toContain("startsWith('${local.object_prefix}corpus/')");
    expect(create).toContain("startsWith('${local.object_prefix}manifests/')");
    expect(create).toContain("resource.name == '${local.object_prefix}refs/main'");
    const overwrite = blocks.find((b) => b.includes('"publisher_overwrite_ref"')) as string;
    expect(overwrite).toContain('role   = "roles/storage.objectUser"');
    expect(overwrite).toMatch(
      /expression\s+= "resource\.name == '\$\{local\.object_prefix\}refs\/main'"/,
    );
    expect(overwrite).not.toContain('startsWith');
    expect(moduleText).toContain(
      'object_prefix  = "projects/_/buckets/${google_storage_bucket.corpus.name}/objects/"',
    );
  });

  it('ANDs any custom provider condition with the owner-id check, never replacing it', () => {
    expect(moduleText).not.toContain('coalesce(var.allowed_owner_condition');
    expect(moduleText).toContain(
      'owner_id_condition  = "assertion.repository_owner_id == \'${var.github_owner_id}\'"',
    );
    expect(moduleText).toContain(
      'attribute_condition = var.allowed_owner_condition == null ? local.owner_id_condition : "(${local.owner_id_condition}) && (${var.allowed_owner_condition})"',
    );
    expect(moduleText).toMatch(/attribute_condition\s+= local\.attribute_condition/);
  });

  it('gives every id the name prefix, with no fixed ids', () => {
    const ids = [
      ...moduleCode.matchAll(
        /^\s*(account_id|role_id|workload_identity_pool_id|workload_identity_pool_provider_id)\s*=\s*(.+)$/gm,
      ),
    ];
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const m of ids) {
      expect(m[2] as string, m[0]).toMatch(/var\.name_prefix|local\.pool_id|google_/);
    }
    expect(moduleCode).toMatch(/corpus_bucket = "\$\{var\.name_prefix\}-/);
    expect(moduleCode).toMatch(/state_bucket = "\$\{var\.name_prefix\}-/);
    expect(moduleCode).toMatch(/pool_id = var\.pool_suffix == "" \? "\$\{var\.name_prefix\}-/);
  });
});
