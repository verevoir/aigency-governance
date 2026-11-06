#!/usr/bin/env bash
# The drift job's "Compare live IAM with state" step (see infra/INSTALL.md
# section 7), kept in a script so a test can run it with fake tofu and gcloud.
#
# Run it with tofu, gcloud and node on PATH, already authenticated as the
# read-only planner, from the installation directory (tofu show needs it). It
# reads, never writes to GCP. It writes `status=<0|1|2>` to $GITHUB_OUTPUT for
# the step that reports the result, and exits with the same number: 0 clean,
# 2 drift, 1 error. Any failure to read a policy is an error, never a clean pass.
#
# Its working files (a full `tofu show -json` of state, the place list, the live
# policies) go to a temporary directory this script owns and removes on exit, NOT
# into the installation directory, so a local run cannot leave a state dump where
# a broad `git add` would pick it up.
#
# No `set -e`, on purpose: the exit status of `node ... compare` (0, 1 or 2) must
# be captured and written to $GITHUB_OUTPUT before the script exits, and -e would
# exit on the first non-zero status without writing it. Every command whose
# failure matters is checked explicitly with `|| fail`.
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/iam-drift.mjs"
out="${GITHUB_OUTPUT:-/dev/null}"

fail() {
  echo "status=1" >> "${out}"
  echo "::error title=IAM check failed::$1" >&2
  exit 1
}

work="$(mktemp -d "${TMPDIR:-/tmp}/iam-live.XXXXXX")" || fail "could not create a temp directory"
trap 'rm -rf "${work}"' EXIT
state="${work}/state.json"
scopes="${work}/scopes.tsv"
live="${work}/live"
mkdir -p "${live}" || fail "could not create ${live}"

tofu show -json > "${state}" || fail "tofu show failed"
node "${script}" scopes "${state}" > "${scopes}" || fail "could not list the places to read"

# gcloud's policy output is requested as JSON. Whether it includes IAM
# conditions (a version 3 policy) is UNVERIFIED: iam-drift.mjs refuses to compare
# a place that has conditional grants in state unless the policy says version 3.
# Each gcloud call has stdin from /dev/null so it cannot swallow the loop's own
# input (the remaining lines of the place list) and silently skip places.
while IFS=$'\t' read -r scope file; do
  case "${scope}" in
    bucket:*) gcloud storage buckets get-iam-policy "gs://${scope#bucket:}" --format=json < /dev/null > "${live}/${file}" || fail "could not read ${scope}" ;;
    sa:*) gcloud iam service-accounts get-iam-policy "${scope#sa:}" --format=json < /dev/null > "${live}/${file}" || fail "could not read ${scope}" ;;
    project:*) gcloud projects get-iam-policy "${scope#project:}" --format=json < /dev/null > "${live}/${file}" || fail "could not read ${scope}" ;;
    *) fail "unknown place ${scope}" ;;
  esac
done < "${scopes}"

status=0
node "${script}" compare "${state}" "${live}" || status=$?
echo "status=${status}" >> "${out}"
if [ "${status}" -eq 2 ]; then
  echo "::error title=IAM drift::A live IAM binding for the module's principals differs from state (see the lines above)." >&2
  exit 2
fi
if [ "${status}" -ne 0 ]; then
  echo "::error title=IAM check failed::the comparison exited ${status}." >&2
  exit "${status}"
fi
