#!/bin/bash
set -euo pipefail

# ./shell/check-private-updates.sh
# chmod +x ./shell/check-private-updates.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR/.."

PACKAGE_JSON="./package.json"
REPORT_FILE="./dependency-update-report.md"

# Hardcoded scopes to check
SCOPES=(
  "@ivstrand/"
  "@datadayrepos/"
)

if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "ERROR: package.json not found at $PACKAGE_JSON"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm is required"
  exit 1
fi

if [[ ! -e /dev/tty ]]; then
  echo "ERROR: /dev/tty not available, cannot prompt interactively"
  exit 1
fi

echo "Checking npm login..."

if ! npm whoami >/dev/null 2>&1; then
  echo "npm login is required."
  echo "Starting browser-based login..."
  npm login --auth-type=web < /dev/tty
  echo
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "ERROR: npm login still not active after login attempt."
  exit 1
fi

echo "npm login OK."
echo

TMP_UPDATES_FILE="$(mktemp)"
TMP_REPORT_ROWS="$(mktemp)"
trap 'rm -f "$TMP_UPDATES_FILE" "$TMP_REPORT_ROWS"' EXIT

while IFS=$'\t' read -r dep_type pkg_name current_range; do
  echo "Checking package: $pkg_name ($current_range)"

  latest_version="$(npm view "$pkg_name" version 2>/dev/null || true)"

  if [[ -z "$latest_version" ]]; then
    echo "  -> latest version not found"
    echo "| $pkg_name | $current_range | not-found | skipped |" >> "$TMP_REPORT_ROWS"
    echo
    continue
  fi

  current_clean="$(node -e '
    const v = process.argv[1] || "";
    process.stdout.write(v.replace(/^[\^~><=\s]+/, ""));
  ' "$current_range")"

  is_newer="$(node -e '
    function norm(v) {
      return String(v || "")
        .trim()
        .replace(/^[\^~><=\s]+/, "")
        .split(".")
        .map(x => parseInt(x, 10) || 0);
    }
    function gt(a, b) {
      const aa = norm(a);
      const bb = norm(b);
      const len = Math.max(aa.length, bb.length);
      for (let i = 0; i < len; i++) {
        const av = aa[i] || 0;
        const bv = bb[i] || 0;
        if (av > bv) return true;
        if (av < bv) return false;
      }
      return false;
    }
    process.stdout.write(gt(process.argv[1], process.argv[2]) ? "yes" : "no");
  ' "$latest_version" "$current_clean")"

  if [[ "$is_newer" != "yes" ]]; then
    echo "  -> already up to date"
    echo "| $pkg_name | $current_range | $latest_version | no-update |" >> "$TMP_REPORT_ROWS"
    echo
    continue
  fi

  echo "  -> newer version found"
  echo "     current: $current_range"
  echo "     latest:  $latest_version"

  answer="n"
  read -r -p "Update this package? (y/N): " answer < /dev/tty

  if [[ "$answer" =~ ^[Yy]$ ]]; then
    printf '%s\t%s\t%s\n' "$dep_type" "$pkg_name" "$latest_version" >> "$TMP_UPDATES_FILE"
    echo "| $pkg_name | $current_range | $latest_version | yes |" >> "$TMP_REPORT_ROWS"
    echo "  -> marked for update"
  else
    echo "| $pkg_name | $current_range | $latest_version | no |" >> "$TMP_REPORT_ROWS"
    echo "  -> skipped"
  fi

  echo
done < <(
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
    const scopes = ["@ivstrand/", "@datadayrepos/"];

    function matches(name) {
      return scopes.some(scope => name.startsWith(scope));
    }

    for (const depType of ["dependencies", "devDependencies"]) {
      const deps = pkg[depType] || {};
      for (const [name, version] of Object.entries(deps)) {
        if (matches(name)) {
          process.stdout.write(`${depType}\t${name}\t${version}\n`);
        }
      }
    }
  '
)

updated_any="no"

if [[ -s "$TMP_UPDATES_FILE" ]]; then
  echo "Applying accepted updates to package.json..."

  while IFS=$'\t' read -r dep_type pkg_name latest_version; do
    echo "  -> updating $pkg_name to $latest_version"

    node -e '
      const fs = require("fs");
      const file = "./package.json";
      const depType = process.argv[1];
      const pkgName = process.argv[2];
      const latest = process.argv[3];

      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!pkg[depType] || !pkg[depType][pkgName]) {
        process.exit(1);
      }

      pkg[depType][pkgName] = latest;
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    ' "$dep_type" "$pkg_name" "$latest_version"

    updated_any="yes"
  done < "$TMP_UPDATES_FILE"
fi

{
  echo "# Dependency Update Report"
  echo
  echo "- File: \`$PACKAGE_JSON\`"
  echo
  echo "| Package | Current | Latest | Selected |"
  echo "|---|---:|---:|---|"
  cat "$TMP_REPORT_ROWS"
} > "$REPORT_FILE"

echo
echo "Wrote report to $REPORT_FILE"

if [[ "$updated_any" == "yes" ]]; then
  echo
  echo "Running pnpm install..."
  pnpm install
  echo "Done."
else
  echo
  echo "No updates were accepted."
fi
