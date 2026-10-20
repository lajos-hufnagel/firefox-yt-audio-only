#!/bin/bash
# Optional real-Firefox bench. Build variants first with node build.js.
# Usage: RUN_SECONDS=100 ./run.sh resolver-stub '?full=1'
# Cleanup is limited to this run's process groups and exact copied Firefox profile.
set -euo pipefail
HARNESS=$(cd "$(dirname "$0")" && pwd)
exec node "$HARNESS/run.js" "$@"
