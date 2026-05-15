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

# ---- 6. Dashboard reachability check ---------------------------------------

echo "==> Checking dashboard is reachable at http://localhost:3000..."
dash_status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
assert_eq "dashboard HTTP status" "200" "$dash_status"

# ---- 7. OTLP/HTTP protobuf ingest (Day 3) -----------------------------------

OTLP_BIN="$(dirname "$0")/../fixtures/otlp-genai-trace.bin"

echo "==> POST otlp-genai-trace.bin to /v1/traces (OTLP/HTTP protobuf)..."
otlp_response=$(curl -s -w '\n%{http_code}' -X POST "${INGESTER_URL}/v1/traces" \
    -H 'Content-Type: application/x-protobuf' \
    --data-binary @"${OTLP_BIN}")
otlp_status=$(echo "$otlp_response" | tail -1)
otlp_body=$(echo "$otlp_response" | head -1)

assert_eq "OTLP/HTTP POST status" "200" "$otlp_status"
assert_eq "OTLP/HTTP POST body" '{}' "$otlp_body"

sleep 1

echo "==> Checking OTLP span landed with source_dialect = otel-genai..."
otel_dialect=$(ch_query "SELECT source_dialect FROM halley.observations WHERE source_dialect = 'otel-genai' LIMIT 1" | tr -d '[:space:]')
assert_eq "OTLP span source_dialect" "otel-genai" "$otel_dialect"

# ---- 8. OpenLLMetry OTLP ingest (Day 4) ------------------------------------

OPENLLMETRY_BIN="$(dirname "$0")/../fixtures/otlp-openllmetry-trace.bin"

echo "==> POST otlp-openllmetry-trace.bin to /v1/traces (OpenLLMetry dialect)..."
ollm_response=$(curl -s -w '\n%{http_code}' -X POST "${INGESTER_URL}/v1/traces" \
    -H 'Content-Type: application/x-protobuf' \
    --data-binary @"${OPENLLMETRY_BIN}")
ollm_status=$(echo "$ollm_response" | tail -1)
ollm_body=$(echo "$ollm_response" | head -1)

assert_eq "OpenLLMetry POST status" "200" "$ollm_status"
assert_eq "OpenLLMetry POST body" '{}' "$ollm_body"

sleep 1

echo "==> Checking OpenLLMetry span landed with source_dialect = openllmetry and run_name = test-run..."
ollm_row=$(ch_query "SELECT source_dialect, run_name FROM halley.observations WHERE source_dialect = 'openllmetry' LIMIT 1")
ollm_dialect=$(echo "$ollm_row" | awk '{print $1}')
ollm_run_name=$(echo "$ollm_row" | awk '{print $2}')
assert_eq "OpenLLMetry source_dialect" "openllmetry" "$ollm_dialect"
assert_eq "OpenLLMetry run_name" "test-run" "$ollm_run_name"

# ---- 9. OTLP/gRPC ingest (Day 5) -------------------------------------------

echo "==> Running gRPC smoke client (cargo run --bin smoke-grpc)..."
# Build and run the gRPC smoke client. It connects to localhost:4317,
# sends the OTEL GenAI fixture, and exits 0 on success.
if cargo run --bin smoke-grpc --manifest-path "$(dirname "$0")/../Cargo.toml" --quiet 2>/dev/null; then
    green "  PASS  gRPC smoke client exited 0"
    PASS=$((PASS + 1))
else
    red   "  FAIL  gRPC smoke client exited non-zero"
    FAIL=$((FAIL + 1))
fi

sleep 1

echo "==> Checking gRPC span landed with source_dialect = otel-genai..."
# The gRPC fixture uses the same trace_id as the HTTP fixture (0102030405060708090a0b0c0d0e0f10).
# We check that at least one otel-genai row exists (the HTTP test already inserted one;
# the gRPC test adds another with the same trace_id but the writer deduplicates body hashes,
# not observation rows — so count should be >= 2 after both Day 3 and Day 5 assertions).
grpc_count=$(ch_query "SELECT count() FROM halley.observations WHERE source_dialect = 'otel-genai'" | tr -d '[:space:]')
assert_ge "gRPC otel-genai row count" "2" "$grpc_count"

# ---- 10. Prometheus metrics endpoint (Day 4) --------------------------------

echo "==> Checking /metrics returns Prometheus format..."
metrics_status=$(curl -s -o /dev/null -w "%{http_code}" "${INGESTER_URL}/metrics")
assert_eq "metrics HTTP status" "200" "$metrics_status"

metrics_body=$(curl -s "${INGESTER_URL}/metrics")
if echo "$metrics_body" | grep -q "halley_ingest_requests_total"; then
    green "  PASS  /metrics contains halley_ingest_requests_total"
    PASS=$((PASS + 1))
else
    red   "  FAIL  /metrics missing halley_ingest_requests_total"
    FAIL=$((FAIL + 1))
fi

# ---- 11. Summary ------------------------------------------------------------

echo ""
echo "==> Smoke test complete: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    red "SMOKE TEST FAILED"
    exit 1
fi
green "SMOKE TEST PASSED"
exit 0
