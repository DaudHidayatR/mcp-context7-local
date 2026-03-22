#!/usr/bin/env bash
set -euo pipefail

export GOCACHE="$(mktemp -d)"
export GOMODCACHE="$(mktemp -d)"

trap 'rm -rf "$GOCACHE" "$GOMODCACHE"' EXIT

exec go test "$@"
