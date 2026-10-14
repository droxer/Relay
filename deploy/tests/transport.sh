#!/usr/bin/env bash
# Exercise gql's transport boundary without credentials or a network connection.
set -euo pipefail
TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
. "$TESTS_DIR/../lib/common.sh"
. "$TESTS_DIR/../lib/railway.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
RAILWAY_API_URL=https://example.invalid/graphql
RAILWAY_API_TOKEN=test-token
sleep() { :; }

curl() {
  local count body
  count=$(cat "$WORK/count")
  count=$((count + 1))
  printf '%s' "$count" > "$WORK/count"
  body=$(cat)
  printf '%s\n' "$body" >> "$WORK/bodies"
  if [ "$MODE" = persistent ] || [ "$count" -eq 1 ]; then
    printf 'curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL\n' >&2
    return 35
  fi
  printf '{"data":{"ok":true}}'
}

printf 0 > "$WORK/count"
MODE=transient
result=$(gql 'query Probe { ok }')
[ "$result" = '{"ok":true}' ]
[ "$(cat "$WORK/count")" = 2 ]
[ "$(sort -u "$WORK/bodies" | wc -l | tr -d ' ')" = 1 ]
echo 'ok    TLS read failure retries with the complete request body'

printf 0 > "$WORK/count"
MODE=persistent
if (gql 'query Probe { ok }') > "$WORK/result" 2> "$WORK/error"; then
  echo 'FAIL persistent transport failure succeeded' >&2
  exit 1
fi
[ "$(cat "$WORK/count")" = 3 ]
grep -q 'Railway API unreachable' "$WORK/error"
echo 'ok    persistent TLS failure stops after three attempts'

printf 0 > "$WORK/count"
if (gql 'mutation Probe { create }') > "$WORK/result" 2> "$WORK/error"; then
  echo 'FAIL failed mutation succeeded' >&2
  exit 1
fi
[ "$(cat "$WORK/count")" = 1 ]
echo 'ok    mutation is not automatically replayed'
