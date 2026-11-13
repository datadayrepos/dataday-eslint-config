#!/usr/bin/env bash
set -euo pipefail

# ./shell/deploy.sh

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
export PATH="$ROOT_DIR/shell/bin:$PATH"

usage() {
  cat <<'HELP'
Usage: ./shell/deploy.sh [--check|--pack|--help]
No arguments: interactive Git / npm / combined menu.
--check: run the existing build, lint, type and test checks.
--pack: run checks and create verified local archives; never publish.
Versions and dependencies are never changed by this entrypoint.
Git and npm actions require separate operator confirmations.
HELP
}

[[ $# -le 1 ]] || { usage >&2; exit 2; }
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  ""|--check|--pack) ;;
  *) usage >&2; exit 2 ;;
esac

require_main() {
  local actual branch
  actual="$(git rev-parse --show-toplevel)"
  branch="$(git symbolic-ref --quiet --short HEAD)" || branch="DETACHED HEAD"
  if [[ "$actual" != "$ROOT_DIR" || "$branch" != main ]]; then
    printf 'ERROR: Expected main in %s; no automatic branch repair.\n' "$ROOT_DIR" >&2
    exit 1
  fi
}

confirm() {
  local answer
  read -r -p "$1 [y/N] " answer || return 1
  [[ "$answer" == y || "$answer" == Y ]]
}

run_checks() {
  require_main
  CI=true corepack pnpm run build
  CI=true corepack pnpm run lint
  CI=true corepack pnpm run typecheck
  CI=true corepack pnpm run test
}

pack_release() {
  run_checks
  require_main
  corepack pnpm run pack:release
}

git_commit_push() {
  require_main
  git status --short
  if confirm "Stage all changes in this checkout (git add -A)?"; then
    require_main
    git add -A
  fi
  local status=0 message
  git diff --cached --quiet || status=$?
  case "$status" in
    0) printf 'No staged changes to commit.\n' ;;
    1)
      read -r -p "Commit message: " message
      [[ -n "$message" ]] || { printf 'Commit message is required.\n' >&2; return 1; }
      confirm "Commit the staged changes?" || return 1
      require_main
      git commit -m "$message"
      ;;
    *) return "$status" ;;
  esac
  confirm "Push HEAD to origin/main?" || return 1
  require_main
  git push origin HEAD:refs/heads/main
}

publish_release() {
  require_main
  local answer
  printf 'Publish the current @datadayrepos/eslint-config version through its verified-archive publisher.\n'
  read -r -p "Type PUBLISH to publish the verified archives: " answer
  [[ "$answer" == PUBLISH ]] || { printf 'Publication canceled.\n'; return 1; }
  if ! npm whoami >/dev/null 2>&1; then
    npm login --auth-type=web
  fi
  require_main
  corepack pnpm run pub
}

case "${1:-}" in
  --check) run_checks; exit 0 ;;
  --pack) pack_release; exit 0 ;;
esac

while true; do
  printf '\ndeploy.sh (repo: %s)\n' "$ROOT_DIR"
  node -e 'const p = require("./package.json"); console.log("Package: " + p.name + " v" + p.version)'
  printf 'No automatic version bumps, dependency updates or tags.\n'
  printf '  1) Git: checks, commit + push\n  2) NPM: checks, verified pack + publish\n  3) Git + NPM (combined)\n  4) Local checks only\n  q) Quit\n'
  read -r -p "Choose: " choice || exit 0
  case "$choice" in
    1) run_checks; git_commit_push ;;
    2) pack_release; publish_release ;;
    3) pack_release; git_commit_push; publish_release ;;
    4) run_checks ;;
    q|Q) exit 0 ;;
    *) printf 'Unknown choice.\n' ;;
  esac
done
