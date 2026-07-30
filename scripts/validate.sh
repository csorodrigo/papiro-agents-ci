#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

project="${1:?project required}"
repository="${2:?repository required}"
branch="${3:?branch required}"
sha="${4:?sha required}"
result_dir="${5:?result directory required}"

[[ "$branch" =~ ^agent/ops-[0-9a-f]{16}$ ]]
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
case "$project:$repository" in
  lucrandoai:csorodrigo/lucrando-ai) ;;
  papiro:csorodrigo/papiro) ;;
  *) printf 'project repository mismatch\n' >&2; exit 2 ;;
esac

[[ -n "${READ_KEY:-}" ]]
install -d -m 0700 "$HOME/.ssh"
install -m 0600 /dev/null "$HOME/.ssh/id_ed25519"
printf '%s\n' "$READ_KEY" > "$HOME/.ssh/id_ed25519"
install -m 0600 /dev/null "$HOME/.ssh/known_hosts"
printf '%s\n' \
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
  > "$HOME/.ssh/known_hosts"

rm -rf source
git init -q source
git -C source remote add origin "git@github.com:${repository}.git"
GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes" \
  git -C source fetch --depth=1 --filter=blob:none --no-tags origin "$sha"
git -C source checkout -q --detach FETCH_HEAD
[[ "$(git -C source rev-parse HEAD)" == "$sha" ]]

rm -f "$HOME/.ssh/id_ed25519"
unset READ_KEY

commands=()
status=0
run_gate() {
  if [[ "$status" -ne 0 ]]; then
    return
  fi
  commands+=("$*")
  "$@" || status=$?
}

cd source
run_gate npm ci --no-audit --no-fund
run_gate npm run typecheck:codex
if [[ "$project" == "lucrandoai" ]]; then
  run_gate npm run test:ci
else
  run_gate npm run db:push:test
  run_gate npm run test:gate:ci
  run_gate npm run canvas:check
  run_gate npm run prisma:validate:supabase
fi
cd ..

install -d -m 0700 "$result_dir"
PROJECT="$project" REPOSITORY="$repository" BRANCH="$branch" SHA="$sha" \
  STATUS="$status" COMMANDS="$(printf '%s\n' "${commands[@]}")" \
  node - "$result_dir/result.json" <<'NODE'
const fs = require("node:fs");
const result = {
  version: 1,
  project: process.env.PROJECT,
  repository: process.env.REPOSITORY,
  branch: process.env.BRANCH,
  sha: process.env.SHA,
  conclusion: process.env.STATUS === "0" ? "success" : "failure",
  exit_code: Number(process.env.STATUS),
  commands: process.env.COMMANDS.split("\n").filter(Boolean),
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
});
NODE

printf 'validation_conclusion=%s\n' "$(
  [[ "$status" -eq 0 ]] && printf success || printf failure
)"
