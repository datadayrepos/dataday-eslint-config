#!/bin/bash
set -euo pipefail

# ./shell/check-private-updates.sh
# chmod +x ./shell/check-private-updates.sh
# Copy this file and check-private-updates/main.mjs together, without edits.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec node "$SCRIPT_DIR/check-private-updates/main.mjs" "$@"
