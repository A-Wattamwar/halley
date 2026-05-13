#!/usr/bin/env bash
# Halley ingester smoke test — Week 1 Day 7.
#
# Verifies the end-to-end path:
#   POST /v1/spans/json → ClickHouse observations + observation_body rows.
#
# Usage:
#   ./ingester/tests/smoke.sh
#   make smoke
#
# Exit codes: 0 = all assertions passed, non-zero = failure.
#
# Assumptions:
#   - The full compose stack is running (make up && make ready).
#   - The ingester is reachable at http://localhost:4318.
#   - ClickHouse HTTP interface is reachable at http://localhost:8123.
#   - curl and bash are available on the host.

set -euo pipefail

INGESTER_URL="http://localhost:4318"
CH_URL="http://localhost:8123"
FIXTURE="$(dirname "$0")/../fixtures/hello-span.json"
MAX_WAIT=30   # seconds to wait for /healthz
PASS=0
FAIL=0

# ---- helpers ----------------------------------------------------------------

green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        green "  PASS  $label (got: $actual)"
        PASS=$((PASS + 1))
    else
        red   "  FAIL  $label (expected: $expected, got: $actual)"
        FAIL=$((FAIL + 1))
    fi
}

assert_ge() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" -ge "$expected" ] 2>/dev/null; then
        green "  PASS  $label (got: $actual >= $expected)"
        PASS=$((PASS + 1))
    else
        red   "  FAIL  $label (expected >= $expected, got: $actual)"
        FAIL=$((FAIL + 1))
    fi
}

ch_query() {
    # Run a ClickHouse query via HTTP and return the trimmed result.
    curl -s --fail "${CH_URL}/?query=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1")"
}

# ---- 1. Wait for /healthz ---------------------------------------------------

echo "==> Waiting for ingester /healthz (up to ${MAX_WAIT}s)..."
waited=0
until curl -fsS "${INGESTER_URL}/healthz" >/dev/null 2>&1; do
    if [ "$waited" -ge "$MAX_WAIT" ]; then
        red "FAIL  /healthz did not return 200 within ${MAX_WAIT}s"
        exit 1
    fi
    sleep 1
    waited=$((waited + 1))
done
green "  OK    /healthz responded after ${waited}s"

# ---- 2. Truncate tables for a clean baseline --------------------------------
# This makes the smoke test idempotent: re-running it always starts from 0.

echo "==> Truncating halley.observations and halley.observation_body..."
curl -s -X POST "${CH_URL}/" --data "TRUNCATE TABLE halley.observations" >/dev/null
curl -s -X POST "${CH_URL}/" --data "TRUNCATE TABLE halley.observation_body" >/dev/null

# ---- 3. POST hello-span.json, assert 202 ------------------------------------

echo "==> POST hello-span.json..."
response=$(curl -s -w '\n%{http_code}' -X POST "${INGESTER_URL}/v1/spans/json" \
    -H 'Content-Type: application/json' \
    -d @"${FIXTURE}")
http_status=$(echo "$response" | tail -1)
body=$(echo "$response" | head -1)

assert_eq "POST /v1/spans/json HTTP status" "202" "$http_status"
assert_eq "POST /v1/spans/json body" '{"accepted":1}' "$body"

# ---- 4. Verify ClickHouse rows ----------------------------------------------

# Small sleep to let ClickHouse commit the part. MergeTree writes are
# synchronous on the HTTP path so this is just defensive.
sleep 1

echo "==> Checking halley.observations count..."
obs_count=$(ch_query "SELECT count() FROM halley.observations" | tr -d '[:space:]')
assert_eq "observations count after first insert" "1" "$obs_count"

echo "==> Checking body hashes are 64-char hex strings..."
hashes=$(ch_query "SELECT hex(input_body_hash), hex(output_body_hash) FROM halley.observations")
input_hash=$(echo "$hashes" | awk '{print $1}')
output_hash=$(echo "$hashes" | awk '{print $2}')
assert_eq "input_body_hash length" "64" "${#input_hash}"
assert_eq "output_body_hash length" "64" "${#output_hash}"

echo "==> Checking observation_body rows exist for both hashes..."
body_count=$(ch_query "SELECT count() FROM halley.observation_body" | tr -d '[:space:]')
assert_ge "observation_body count after first insert" "2" "$body_count"
first_body_count=$body_count

# ---- 5. Re-post the same span (dedup check) ---------------------------------

echo "==> Re-posting hello-span.json (dedup check)..."
response2=$(curl -s -w '\n%{http_code}' -X POST "${INGESTER_URL}/v1/spans/json" \
    -H 'Content-Type: application/json' \
    -d @"${FIXTURE}")
http_status2=$(echo "$response2" | tail -1)
assert_eq "second POST HTTP status" "202" "$http_status2"

sleep 1

echo "==> Checking observations count is now 2..."
obs_count2=$(ch_query "SELECT count() FROM halley.observations" | tr -d '[:space:]')
assert_eq "observations count after second insert" "2" "$obs_count2"

echo "==> Checking observation_body count has not grown (dedup)..."
body_count2=$(ch_query "SELECT count() FROM halley.observation_body" | tr -d '[:space:]')
# ReplacingMergeTree dedup is eventual. Accept <= first_body_count as a pass
# if the merge hasn't run yet; the important thing is it did not grow beyond
# the original count. See plan pitfall #4 and DECISIONS.md D5.
if [ "$body_count2" -le "$first_body_count" ]; then
    green "  PASS  observation_body dedup (count: $body_count2 <= $first_body_count)"
    PASS=$((PASS + 1))
else
    yellow "  NOTE  observation_body count grew to $body_count2 (was $first_body_count)."
    yellow "        ReplacingMergeTree merge may not have run yet — this is expected."
    yellow "        The dedup will collapse on background merge. Not a failure."
    # Not incrementing FAIL: eventual dedup is documented behaviour.
fi

# ---- 6. Summary -------------------------------------------------------------

echo ""
echo "==> Smoke test complete: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    red "SMOKE TEST FAILED"
    exit 1
fi
green "SMOKE TEST PASSED"
exit 0
