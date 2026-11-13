#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
export PATH="$ROOT_DIR/shell/bin:$PATH"

usage() {
  cat <<'HELP'
Usage: ./shell/check-private-updates.sh [--report-only|--help]
Check @ivstrand/* and @datadayrepos/* using this repo's pinned pnpm.
Default: interactive refresh within existing declared version ranges.
--report-only: show outdated packages without prompts or installation.
Exact pins and upgrades outside declared ranges need a separate review.
Self, workspace, local, alias/tag and peer-constrained packages are skipped.
No automatic npm login, manifest rewrite, version bump or Git operation.
Report-only preserves pnpm's exit status (outdated packages normally return 1).
HELP
}

[[ $# -le 1 ]] || { usage >&2; exit 2; }
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  ""|--report-only) ;;
  *) usage >&2; exit 2 ;;
esac

# Select explicit registry dependencies so workspace/self links cannot be replaced.
names="$(node --input-type=commonjs - "$ROOT_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const candidates = new Map();
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [name, spec] of Object.entries(pkg[section] || {})) {
    if (!/^@(ivstrand|datadayrepos)\//.test(name)) continue;
    if (!candidates.has(name)) candidates.set(name, []);
    candidates.get(name).push(spec);
  }
}
for (const [name, specs] of candidates) {
  let skip = name === pkg.name || Object.hasOwn(pkg.peerDependencies || {}, name)
    || specs.some(spec => typeof spec !== 'string' || !/^[~^<>=\s]*\d/.test(spec));
  const installed = path.join(root, 'node_modules', name);
  if (fs.existsSync(installed)) {
    const relative = path.relative(path.join(root, 'node_modules'), fs.realpathSync(installed));
    skip ||= relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  }
  if (skip) console.error('Manual review / preserved declaration: ' + name);
  else console.log(name);
}
NODE
)"
packages=()
while IFS= read -r name; do
  [[ -z "$name" ]] || packages+=("$name")
done <<< "$names"

if [[ ${#packages[@]} -eq 0 ]]; then
  printf 'No eligible registry-managed private dependencies.\n'
  exit 0
fi

if [[ "${1:-}" == --report-only ]]; then
  exec corepack pnpm outdated --long "${packages[@]}"
fi

[[ -t 0 ]] || { printf 'Interactive selection requires a terminal; use --report-only.\n' >&2; exit 1; }
printf 'Only versions allowed by current declarations are eligible; no --latest rewrite.\n'
exec corepack pnpm update --interactive --no-save "${packages[@]}"
