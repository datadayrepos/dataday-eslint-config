#!/usr/bin/env bash
set -euo pipefail

# ./shell/deploy.sh

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
export PATH="$ROOT_DIR/shell/bin:$PATH"
VERSION_FILES=(package.json)
BUMPED=0

usage() {
  cat <<'HELP'
Usage: ./shell/deploy.sh [--check|--pack|--help]
No arguments: interactive Git / npm / combined menu.
--check: run the existing build, lint, type and test checks.
--pack: run checks and create verified local archives; never publish.
Interactive actions offer the standard patch/minor/major/no version choice.
--check and --pack never bump versions. Dependencies are never updated here.
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

# Keep UseVue's root and published workspace versions synchronized.
bump_version() {
  require_main
  local current next choice
  current="$(node -p 'require("./package.json").version')"
  printf '\nBump version? (current: %s)\n  p) patch\n  m) minor\n  M) major\n  n) no\n' "$current"
  while true; do
    read -r -p "Choose [p/m/M/n] (default: n): " choice || return 1
    choice="${choice:-n}"
    case "$choice" in
      p|m|M|n) break ;;
      *) printf 'Please choose p, m, M, or n.\n' ;;
    esac
  done
  if [[ "$choice" == n ]]; then
    printf 'Skipping version bump.\n'
    return 0
  fi
  next="$(node --input-type=commonjs - "$current" "$choice" <<'NODE'
const version = process.argv[2];
const match = version.split('-')[0].match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) throw new Error('Unsupported version format: ' + version);
let [major, minor, patch] = match.slice(1).map(Number);
if (process.argv[3] === 'M') { major++; minor = 0; patch = 0; }
else if (process.argv[3] === 'm') { minor++; patch = 0; }
else patch++;
process.stdout.write([major, minor, patch].join('.'));
NODE
)"
  printf 'Selected version: %s -> %s\n' "$current" "$next"
  if ! confirm "Apply this version bump?"; then
    printf 'Version unchanged.\n'
    return 0
  fi
  require_main
  node --input-type=commonjs - "$current" "$next" "${VERSION_FILES[@]}" <<'NODE'
const fs = require('node:fs');
const [current, next, ...files] = process.argv.slice(2);
// Validate every workspace manifest before changing any version.
const entries = files.map(file => {
  if (!fs.lstatSync(file).isFile()) throw new Error('Expected a regular manifest: ' + file);
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pkg.version !== current) throw new Error('Version changed or workspace versions differ: ' + file);
  return { file, pkg };
});
for (const { file, pkg } of entries) {
  pkg.version = next;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
console.log('Version updated: ' + current + ' -> ' + next);
NODE
  BUMPED=1
}

preflight() {
  BUMPED=0
  bump_version
  run_checks
}

npm_publish() {
  require_main
  # Pack after any Git hooks, using the existing build and archive safeguards.
  corepack pnpm run pack:release
  publish_release
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
  if [[ "$BUMPED" == 1 ]] && confirm "Stage the version bump files?"; then
    require_main
    git add -- "${VERSION_FILES[@]}"
  fi
  if confirm "Stage all changes in this checkout (git add -A)?"; then
    require_main
    git add -A
  fi
  local status=0 message
  git diff --cached --quiet || status=$?
  case "$status" in
    0) printf 'No staged changes to commit.\n' ;;
    1)
      local default_message
      default_message="chore(release): v$(node -p 'require("./package.json").version')"
      read -r -p "Commit message (default: $default_message): " message
      message="${message:-$default_message}"
      confirm "Commit the staged changes?" || return 1
      require_main
      git commit -m "$message"
      ;;
    *) return "$status" ;;
  esac
  if ! confirm "Push HEAD to origin/main?"; then
    printf 'Git push canceled; no npm publication will follow this action.\n'
    return 1
  fi
  require_main
  git push origin HEAD:refs/heads/main
}

publish_release() {
  require_main
  local answer
  printf 'Publish the current @datadayrepos/eslint-config version through its verified-archive publisher.\n'
  read -r -p "Type PUBLISH to publish the verified archives: " answer
  [[ "$answer" == PUBLISH ]] || { printf 'Publication canceled.\n'; return 1; }
  if npm whoami >/dev/null 2>&1; then
    printf 'NPM: already authenticated; login is not needed.\n'
  else
    printf 'NPM login required.\n'
    npm login --auth-type=web
  fi
  require_main
  printf 'Publishing verified npm archive(s)...\n'
  corepack pnpm run pub
  printf 'NPM publish completed successfully.\n'
}

case "${1:-}" in
  --check) run_checks; exit 0 ;;
  --pack) pack_release; exit 0 ;;
esac

while true; do
  printf '\ndeploy.sh (repo: %s)\n' "$ROOT_DIR"
  node -e 'const p = require("./package.json"); console.log("Package: " + p.name + " v" + p.version)'
  printf 'Optional version bump; no dependency updates or automatic tags.\n'
  printf '  1) Git: commit + push\n  2) NPM: login + publish\n  3) Git + NPM (combined)\n  q) Quit\n'
  read -r -p "Choose: " choice || exit 0
  case "$choice" in
    1) preflight; git_commit_push; printf 'Git-only action complete. No npm publication requested; choose 2 or 3 to publish.\n' ;;
    2) preflight; npm_publish ;;
    3) preflight; git_commit_push; npm_publish ;;
    q|Q) exit 0 ;;
    *) printf 'Unknown choice.\n' ;;
  esac
done
