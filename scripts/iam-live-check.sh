#!/usr/bin/env bash
# The drift job's "Compare live IAM with state" step (see infra/INSTALL.md
# section 7), kept in a script so a test can run it with fake tofu and gcloud.
#
# Run it from the installation directory, with tofu, gcloud and node on PATH,
# already authenticated as the read-only planner. It reads, never writes to
# GCP. It writes `status=<0|1|2>` to $GITHUB_OUTPUT for the step that reports
# the result, and exits with the same number: 0 clean, 2 drift, 1 error. Any
# failure to read a policy is an error, never a clean pass.
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/iam-drift.mjs"
out="${GITHUB_OUTPUT:-/dev/null}"

fail() {
  echo "status=1" >> "${out}"
  echo "::error title=IAM check failed::$1" >&2
  exit 1
}

mkdir -p live
tofu show -json > state.json || fail "tofu show failed"
node "${script}" scopes state.json > scopes.tsv || fail "could not list the places to read"

# gcloud's policy output is requested as JSON. Whether it includes IAM
# conditions (a version 3 policy) is UNVERIFIED: iam-drift.mjs refuses to compare
# a place that has conditional grants in state unless the policy says version 3.
while IFS=$'\t' read -r scope file; do
  case "${scope}" in
    bucket:*) gcloud storage buckets get-iam-policy "gs://${scope#bucket:}" --format=json > "live/${file}" || fail "could not read ${scope}" ;;
    sa:*) gcloud iam service-accounts get-iam-policy "${scope#sa:}" --format=json > "live/${file}" || fail "could not read ${scope}" ;;
    project:*) gcloud projects get-iam-policy "${scope#project:}" --format=json > "live/${file}" || fail "could not read ${scope}" ;;
    *) fail "unknown place ${scope}" ;;
  esac
done < scopes.tsv

status=0
node "${script}" compare state.json live || status=$?
echo "status=${status}" >> "${out}"
if [ "${status}" -eq 2 ]; then
  echo "::error title=IAM drift::A live IAM binding for the module's principals differs from state (see the lines above)." >&2
  exit 2
fi
if [ "${status}" -ne 0 ]; then
  echo "::error title=IAM check failed::the comparison exited ${status}." >&2
  exit "${status}"
fi
