// Read-only live-IAM comparison for the drift job (see infra/INSTALL.md section 7).
//
//   node iam-drift.mjs scopes  <state.json>              one "scope<TAB>file" per place to read
//   node iam-drift.mjs compare <state.json> <live-dir>   compare the live policies with state
//
// state.json is the output of `tofu show -json`. For each place the module grants
// IAM (its buckets, its service accounts and its project) the workflow saves the
// live policy as <live-dir>/<file>. The comparison looks ONLY at bindings whose
// member is one of the module's own principals: its service accounts, and
// anything in its identity pool. A binding the live policy has and state lacks is
// "unexpected"; one state has and the live policy lacks is "missing". Either is
// drift. Grants to anyone else are not looked at.
//
// Conditions: a grant with an IAM condition is compared on its expression with
// whitespace collapsed (title and description are not compared). Whether gcloud
// returns conditions at all is UNVERIFIED, so for a place where state has a
// conditional grant, a live policy that does not say "version": 3 is an error:
// it must not be read as "no conditions".
//
// Exit 0 clean, 2 drift, 1 error. A policy that is missing or unreadable is an
// error, never a clean pass.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const fail = (message) => {
  process.stderr.write(`iam-drift: ${message}\n`);
  process.exit(1);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${path}: ${error.message}`);
  }
};

const walk = (module) => [
  ...(module.resources ?? []),
  ...(module.child_modules ?? []).flatMap(walk),
];
const collapse = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const fileFor = (scope) => `${scope.replace(/[^A-Za-z0-9._@-]/g, '_')}.json`;
// The google provider's bucket IAM resources may hold the bucket as "b/<name>"
// (the form of their import ids) rather than the bare name. Which one state really
// holds is UNVERIFIED, so both are accepted and mean the same bucket.
const bucketName = (value) => String(value).replace(/^b\//, '');
const keyOf = (b) => JSON.stringify([b.scope, b.role, b.member, b.condition]);
const describe = (kind, b) =>
  `${kind}: ${b.scope} ${b.role} ${b.member}${b.condition === '' ? '' : ` if ${b.condition}`}`;

function describeState(show) {
  const root = show?.values?.root_module;
  if (root === undefined) {
    return fail('no values.root_module: expected the output of "tofu show -json"');
  }
  const resources = walk(root);
  const values = (type) => resources.filter((r) => r.type === type).map((r) => r.values ?? {});
  const binding = (scope, v) => ({
    scope,
    role: v.role,
    member: v.member,
    condition: collapse(v.condition?.[0]?.expression),
  });
  const accounts = values('google_service_account');
  const expected = [
    ...values('google_storage_bucket_iam_member').map((v) =>
      binding(`bucket:${bucketName(v.bucket)}`, v),
    ),
    ...values('google_service_account_iam_member').map((v) =>
      binding(`sa:${String(v.service_account_id).split('serviceAccounts/').pop()}`, v),
    ),
    ...values('google_project_iam_member').map((v) => binding(`project:${v.project}`, v)),
  ];
  const scopes = new Set([
    ...expected.map((b) => b.scope),
    ...values('google_storage_bucket').map((b) => `bucket:${b.name}`),
    ...accounts.flatMap((a) => [`sa:${a.email}`, `project:${a.project}`]),
  ]);
  const members = new Set(accounts.map((a) => `serviceAccount:${a.email}`));
  const prefixes = values('google_iam_workload_identity_pool').flatMap((p) => [
    `principalSet://iam.googleapis.com/${p.name}/`,
    `principal://iam.googleapis.com/${p.name}/`,
  ]);
  const ours = (member) => members.has(member) || prefixes.some((p) => member.startsWith(p));
  return { expected, scopes: [...scopes].sort(), ours };
}

const [, , command, statePath, liveDir] = process.argv;
if (statePath === undefined || !['scopes', 'compare'].includes(command ?? '')) {
  fail('usage: iam-drift.mjs scopes <state.json> | compare <state.json> <live-dir>');
}
const { expected, scopes, ours } = describeState(readJson(statePath));
if (scopes.length === 0) fail('state holds no module resources: refusing to call that clean');

if (command === 'scopes') {
  for (const scope of scopes) process.stdout.write(`${scope}\t${fileFor(scope)}\n`);
} else {
  if (liveDir === undefined) fail('compare needs <live-dir>');
  const conditional = new Set(expected.filter((b) => b.condition !== '').map((b) => b.scope));
  const live = scopes.flatMap((scope) => {
    const policy = readJson(`${liveDir}/${fileFor(scope)}`);
    if (conditional.has(scope) && !(Number(policy.version) >= 3)) {
      fail(
        `${scope}: state has conditional grants but the live policy is version ${policy.version ?? 'absent'}, so its conditions may not have been returned: not comparing`,
      );
    }
    return (policy.bindings ?? []).flatMap((b) =>
      (b.members ?? []).filter(ours).map((member) => ({
        scope,
        role: b.role,
        member,
        condition: collapse(b.condition?.expression),
      })),
    );
  });
  const liveKeys = new Set(live.map(keyOf));
  const wantKeys = new Set(expected.map(keyOf));
  const lines = [
    ...live.filter((b) => !wantKeys.has(keyOf(b))).map((b) => describe('unexpected', b)),
    ...expected.filter((b) => !liveKeys.has(keyOf(b))).map((b) => describe('missing', b)),
  ];
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.exitCode = lines.length === 0 ? 0 : 2;
}
