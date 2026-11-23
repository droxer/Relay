#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/../lib/verify.sh"

WEB_ORIGIN=https://web.example.test
calls=$(mktemp)
trap 'rm -f "$calls"' EXIT

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*"; }
http_code() { printf '404\n'; }

curl() {
  printf '%s\n' "$*" >> "$calls"
  [ "${!#}" = "$WEB_ORIGIN/_next/static/chunks/app.js" ] || return 1
  local status=$FIRST_CACHE_STATUS colo=SIN
  if [ "$(wc -l < "$calls")" -eq 2 ]; then
    status=$SECOND_CACHE_STATUS
    colo=HKG
  fi
  printf 'HTTP/2 103\r\nCF-Cache-Status: HIT\r\n\r\n'
  printf 'HTTP/2 %s\r\nCache-Control: %s\r\nCF-Ray: sample-%s\r\n' "$RESPONSE_CODE" "$CACHE_CONTROL" "$colo"
  if [ -n "$status" ]; then
    printf 'Cf-Cache-Status: %s\r\n' "$status"
  fi
  printf '\r\n'
}

run_check() {
  local name=$1 expected_requests=$2 expected_failures=$3 expected_output=$4 output
  : > "$calls"
  output=$(verify_worker_assets /_next/static/chunks/app.js; printf 'failures=%s\n' "$VERIFY_FAILURES")
  if ! grep -Fq "$expected_output" <<<"$output" ||
     ! grep -qx "failures=$expected_failures" <<<"$output" ||
     ! grep -Fq 'a missing asset is a 404' <<<"$output" ||
     [ "$(wc -l < "$calls")" -ne "$expected_requests" ] ||
     grep -Eq '(^| )(-I|--head)( |$)' "$calls"; then
    printf 'FAIL  %s\n%s\n' "$name" "$output" >&2
    exit 1
  fi
  printf 'ok    %s\n' "$name"
}

CACHE_CONTROL='public, max-age=31536000, immutable'
RESPONSE_CODE=200
FIRST_CACHE_STATUS=MISS SECOND_CACHE_STATUS=HIT
run_check 'a cold Worker asset retries the same GET and reports the HIT' 2 0 'MISS (SIN) -> HIT (HKG)'
FIRST_CACHE_STATUS=HIT
run_check 'an already warm Worker asset needs one GET' 1 0 'HIT (SIN)'
FIRST_CACHE_STATUS=MISS SECOND_CACHE_STATUS=MISS
run_check 'an asset remaining cold only warns' 2 0 'warning: Worker static asset CF-Cache-Status: MISS (SIN) -> MISS (HKG)'
FIRST_CACHE_STATUS= SECOND_CACHE_STATUS=
run_check 'missing cache status only warns' 2 0 'warning: Worker static asset CF-Cache-Status: missing (SIN) -> missing (HKG)'
RESPONSE_CODE=404 FIRST_CACHE_STATUS=HIT
run_check 'a cached 404 fails real asset verification' 1 1 'expected 200, got 404'
RESPONSE_CODE=200 CACHE_CONTROL=no-cache
run_check 'a successful response without immutable fails verification' 1 1 'expected immutable'
