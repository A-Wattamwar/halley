/**
 * Halley ingester HTTP load test — Phase 2 Week 4 Day 5.
 *
 * Executor: constant-arrival-rate at 5,000 RPS for 5 minutes.
 * Payload:  OTLP/HTTP protobuf (ExportTraceServiceRequest, one OTEL GenAI span).
 * Target:   http://halley-ingester:4318/v1/traces  (in-network hostname)
 *
 * Run via:  make load-test
 *
 * The fixture binary (ingester/fixtures/otlp-genai-trace.bin, 349 bytes) is
 * embedded as base64 below so the script is self-contained inside the k6
 * container without needing a volume mount.
 *
 * Thresholds are informational only (not blocking):
 *   - p(99) latency < 50ms
 *   - error rate < 1%
 *
 * See DECISIONS.md D36 for methodology and results.
 */

import http from 'k6/http';
import { check } from 'k6';
import encoding from 'k6/encoding';

// ---------------------------------------------------------------------------
// Fixture: otlp-genai-trace.bin embedded as base64.
// One ExportTraceServiceRequest with a single OTEL GenAI span.
// Regenerate with: cargo test --test gen_otlp_fixture -- --nocapture
// ---------------------------------------------------------------------------
const FIXTURE_B64 =
    'CtoCCh8KHQoMc2VydmljZS5uYW1lEg0KC2hhbGxleS10ZXN0ErYCErMCChABAgMEBQYH' +
    'CAkKCwwNDg8QEggBAgMEBQYHCCoLb3BlbmFpLmNoYXQwAzkAYMIv2A2vGEEAKl1r2A2v' +
    'GEoZCg1nZW5fYWkuc3lzdGVtEggKBm9wZW5haUofChVnZW5fYWkub3BlcmF0aW9uLm5h' +
    'bWUSBgoEY2hhdEogChRnZW5fYWkucmVxdWVzdC5tb2RlbBIICgZncHQtNG9KIQoVZ2Vu' +
    'X2FpLnJlc3BvbnNlLm1vZGVsEggKBmdwdC00b0ofChlnZW5fYWkudXNhZ2UuaW5wdXRf' +
    'dG9rZW5zEgIYKkogChpnZW5fYWkudXNhZ2Uub3V0cHV0X3Rva2VucxICGBFKLAoeZ2Vu' +
    'X2FpLnJlc3BvbnNlLmZpbmlzaF9yZWFzb25zEgoqCAoGCgRzdG9wegIYAQ==';

// Decode once at init time (shared across all VUs).
const PAYLOAD = encoding.b64decode(FIXTURE_B64, 'std', 'b');

const TARGET_URL = 'http://halley-ingester:4318/v1/traces';

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
export const options = {
    scenarios: {
        otlp_http: {
            executor: 'constant-arrival-rate',
            rate: 5000,          // target 5,000 iterations/sec
            timeUnit: '1s',
            duration: '5m',
            preAllocatedVUs: 100,
            maxVUs: 500,
        },
    },
    thresholds: {
        // Informational only — not blocking the test.
        http_req_duration: ['p(99)<50'],   // 50ms p99 target
        http_req_failed: ['rate<0.01'],  // <1% error rate target
    },
};

// ---------------------------------------------------------------------------
// Default function — called once per iteration
// ---------------------------------------------------------------------------
export default function () {
    const res = http.post(TARGET_URL, PAYLOAD, {
        headers: {
            'Content-Type': 'application/x-protobuf',
        },
        timeout: '5s',
    });

    check(res, {
        'status is 200': (r) => r.status === 200,
    });
}
