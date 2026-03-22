#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

set +e
output=$(npx --yes tsx worker/src/index.test.ts 2>&1)
status=$?
set -e

echo "$output"

if echo "$output" | grep -qE '^[[:space:]]+✗'; then
  echo "WORKER TESTS: FAIL — one or more tests failed" >&2
  exit 1
fi

if echo "$output" | grep -qE '[1-9][0-9]* failed'; then
  echo "WORKER TESTS: FAIL — non-zero failure count" >&2
  exit 1
fi

if [ "$status" -ne 0 ]; then
  echo "WORKER TESTS: FAIL — test runner exited non-zero" >&2
  exit 1
fi

echo "WORKER TESTS: PASS"
exit 0
