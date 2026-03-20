#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "start-context7-mcp.sh is deprecated. Use scripts/compose.sh up instead." >&2
exec "${SCRIPT_DIR}/scripts/compose.sh" up "$@"
