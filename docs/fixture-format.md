# Halley Fixture Format v1

> **v1 — PROVISIONAL pending Week 10 replay validation** (see D53 in `docs/DECISIONS.md`)
>
> This document describes the on-disk layout of a Halley regression fixture.
> The format is stable enough to ship and write fixtures against, but is not
> yet a locked contract. It will be finalized once the Week 10 replay shim
> validates the `match_key` / ordinal-cursor matching against real intercepts.
> Additive changes (new optional top-level or per-observation keys) are
> non-breaking. Breaking changes require incrementing `fixture_format_version`.
> See D52 and D53 in `docs/DECISIONS.md`.

---

## 1. Purpose

A Halley fixture is a **portable, in-repo, vendor-independent regression test**
generated from a recorded production or test run. It contains:

1. **Run metadata** — what ran, when, on which model.
2. **Observations** — the ordered list of LLM/tool spans, each referencing its
   recorded input and output bodies by content-addressed hash.
3. **Invariants** — the structural, schema, metric, and semantic constraints
   that a replay must satisfy.
4. **Replay-matching spec** — how the replay shim identifies the correct
   recorded response to serve for each incoming LLM call.

Fixtures are plain JSON files checked into the user's repository. No proprietary
format, no API dependency, no account required to run regression tests.

---

## 2. On-disk layout

```
<repo>/
  halley/
    fixtures/
      <slug>.json                          # fixture index
      <slug>/
        bodies/
          sha256-<lowercase-64-char-hex>.json  # one file per unique body
```

- `<slug>` is a URL-safe identifier derived from the run name (or the first 12
  chars of the run ID if the run has no name).
- Body files are **content-addressed** by the SHA-256 hash of the
  D22-canonicalized JSON body as computed by the ingester. The writer reuses
  the stored hash from `halley.observation_body.body_hash` — it does **not**
  recompute or re-canonicalize.
- A body referenced by two observations maps to **one file** (deduplication is
  automatic).

---

## 3. Fixture index (`<slug>.json`)

### 3.1 Top-level fields

```jsonc
{
  "fixture_format_version": 1,       // REQUIRED — literal integer 1
  "fixture_id": "<uuid>",            // Postgres fixtures.id
  "source_run_id": "<32-char-hex>",  // trace/run ID from the recording
  "run_name": "my-agent-run",        // human-readable; may be empty string
  "started_at_ms": 1780000000000,    // Unix epoch ms — first span start
  "dialect": "otel-genai",           // source instrumentation dialect
  "top_model": "gpt-4o-mini",        // first model seen in the run
  "written_at": "2026-05-29T...",    // ISO 8601 UTC — when writer job ran
  "observations": [ ... ],           // ordered span list — see §3.2
  "invariants": { ... },             // invariants_json — see §3.3
  "replay_matching": { ... }         // matching spec — see §3.4
}
```

| Field | Type | Notes |
|---|---|---|
| `fixture_format_version` | integer literal `1` | Required. Future format changes increment this. |
| `fixture_id` | UUID string | Links file back to `fixtures` Postgres row. |
| `source_run_id` | 32-char uppercase hex | The recorded trace ID. |
| `run_name` | string | May be empty. |
| `started_at_ms` | integer | Unix epoch milliseconds. |
| `dialect` | string | `otel-genai` \| `openllmetry` \| `vercel-ai` \| `halley-raw` \| … |
| `top_model` | string | First non-empty `gen_ai_request_model` in the run. |
| `written_at` | ISO 8601 string | Timezone: UTC (`Z` suffix). |
| `observations` | array | See §3.2. Ordered by execution time ascending. |
| `invariants` | object | See §3.3. |
| `replay_matching` | object | See §3.4. |

### 3.2 `observations[i]` fields

Each entry represents one recorded LLM or tool span in execution order.

```jsonc
{
  "index": 0,
  "span_id": "AABBCCDD11223344",      // 16-char uppercase hex
  "parent_span_id": "0000000000000000",  // root span sentinel
  "operation": "chat",
  "model": "gpt-4o-mini",
  "system": "openai",
  "status": "ok",
  "started_at_ms": 1780000000000,
  "ended_at_ms": 1780000001500,
  "duration_ms": 1500,
  "input_tokens": 30,
  "output_tokens": 4,
  "match_key": "<64-char-hex>",       // D22 SHA-256 of canonical input body
  "input_body_ref": "halley/fixtures/<slug>/bodies/sha256-<hash>.json",
  "output_body_ref": "halley/fixtures/<slug>/bodies/sha256-<hash>.json"
}
```

| Field | Type | Notes |
|---|---|---|
| `index` | integer | 0-based position in execution order. |
| `span_id` | 16-char uppercase hex | Changes on every replay — not a stable identifier. Use `index` for positional references. |
| `parent_span_id` | 16-char uppercase hex | `"0000000000000000"` = root span (no parent). |
| `operation` | string | `gen_ai_operation` value. |
| `model` | string | `gen_ai_request_model`. |
| `system` | string | `gen_ai_system` (e.g. `openai`, `anthropic`). |
| `status` | string | `ok` \| `error` \| `timeout`. |
| `started_at_ms` | integer | Unix epoch ms. |
| `ended_at_ms` | integer | Unix epoch ms. |
| `duration_ms` | integer | `ended_at_ms − started_at_ms`. |
| `input_tokens` | integer | Prompt token count. |
| `output_tokens` | integer | Completion token count. |
| `match_key` | 64-char lowercase hex \| `""` | D22 canonical-JSON SHA-256 of the recorded input body. The replay shim matches incoming calls against this. **Matching is ordinal**: when multiple observations share the same `match_key` (e.g. a loop that calls the calculator twice with the same argument), the shim advances a per-key cursor through `index` order — the first intercepted call gets `observations[i]`, the second gets `observations[j]` where `j > i` and `match_key[j] == match_key[i]`. Empty string = no input body captured. |
| `input_body_ref` | string \| `null` | Relative path from the repo root to the input body file. null = no body. |
| `output_body_ref` | string \| `null` | Relative path to the output body file. null = no body. |

### 3.3 `invariants` object

The full `invariants_json` as edited and saved by the user. Four top-level keys
(all optional — absent = that invariant type was rejected by the user):

```jsonc
{
  "structural": {
    "span_count": 3,
    "operation_sequence": ["chat", "execute_tool", "chat"],
    "operation_sequence_mode": "exact",   // "exact" | "subsequence"
    "required_operations": ["chat"],
    "parent_index": [null, 0, 1]          // positional parent pointers; null = root
  },
  "schema": {
    "per_span": [
      {
        "op": "chat",
        "key_types": { "[].role": "string", "[].parts": "array" },
        "required_keys": ["[].role", "[].parts"]
      },
      null,   // null = no schema invariant for this span
      null
    ]
  },
  "metric": {
    "cost_max_usd": 0.000010,
    "latency_max_ms": 2400,
    "span_count": 3,
    "input_tokens_max": 120,
    "output_tokens_max": 50
  },
  "semantic": {
    "enabled": false,        // always false in v1; runner ships in Phase 6
    "judge_model": null,
    "rubric": null
  }
}
```

`operation_sequence_mode`:
- `"exact"` — replay must produce exactly this sequence, in this order.
- `"subsequence"` — replay must contain these operations as an ordered
  subsequence (extra spans are allowed).

`parent_index`: a positional array aligned to `observations`. Value at index `i`
is the 0-based index of span `i`'s parent in the same array, or `null` for root
spans. Encodes tree shape without relying on `span_id` values (which change on
every replay).

### 3.4 `replay_matching` object

```jsonc
{
  "strategy": "input_body_hash_v1",
  "description": "..."
}
```

**Strategy `input_body_hash_v1`** (the only v1 strategy):

The replay shim (Week 10 CLI) intercepts each outgoing LLM provider call,
computes `hex(SHA-256(canonical_json(request_body)))` using the same D22
algorithm that the ingester used when recording, and finds the matching
`observations[i]` by `match_key`.

**Matching is ordinal, not a bare lookup.** When multiple observations share
the same `match_key` (loops, retries — e.g. two calculator calls with the same
arguments), the shim uses a **per-key cursor** that starts at `index=0` and
advances through the observation list in order. The first intercepted call
matching key `k` is served by the first recorded observation with `match_key=k`,
the second intercepted call by the second, and so on. This guarantees
determinism across repeated identical calls without requiring unique inputs.

- **Hit** (key found, cursor has remaining observations): serve the
  `output_body_ref` body as the provider response.
- **Miss** (key not in cassette, or cursor exhausted): make a live call,
  record the new response as a new fixture version.

The shim does **not** match on URL or HTTP method (all LLM calls POST to one
endpoint) and does **not** match on `span_id` (unstable across runs).

---

### Body source and replay fidelity (D53)

Two capture tiers determine whether bodies support bit-faithful replay:

- **Tier 1 — any OTLP instrumentation, zero Halley code:** bodies are
  **gen_ai-semantic reconstructions** assembled by the ingester from span
  events (`gen_ai.*.message`, `gen_ai.*.tool_call`, etc.). They omit raw
  provider fields like `model`, `temperature`, `seed`, `id`, and `usage`.
  Tier-1 bodies are correct for *invariant inference* (schema, metric, cost)
  but `hash(live raw request) ≠ match_key`, so bit-faithful cassette replay
  is **not possible from Tier-1 data alone**.

- **Tier 2 — add the Halley recorder (one-line client wrap):** the recorder
  shim captures the **full raw request and response JSON** and emits them as a
  `halley-raw` span. `observation_body` then holds byte-faithful payloads, and
  `hash(live raw request) == match_key` by construction (the same shim
  canonicalizes in both record and replay modes). Tier-2 cassettes are fully
  bit-replayable.

Tier 1 gives you observability + invariant inference at zero instrumentation
cost. Tier 2 adds the $0 CI replay hero loop. Both tiers write identical
fixture files; the difference is in body content, not format.

---

## 4. Body files (`sha256-<hash>.json`)

Each body file contains the **parsed JSON** of one recorded LLM request or
response body.

```jsonc
// Example: halley/fixtures/my-agent/bodies/sha256-abc123...def.json
{
  "messages": [
    { "role": "user", "content": "hello" }
  ]
}
```

- File names are always `sha256-` followed by the 64-character lowercase
  hex SHA-256 hash.
- The hash is the D22 canonical-JSON SHA-256 as computed by the ingester.
  The fixture writer **reuses** this stored hash; it does not recompute it.
- If a body cannot be parsed as JSON (e.g. a plain-text tool output), it is
  stored as `{ "raw_text": "..." }`.
- Files are **deduplicated**: if two spans record the same body, both
  `input_body_ref` / `output_body_ref` paths point to the same file.

---

## 5. Versioning and migration

| `fixture_format_version` | Status | Notes |
|---|---|---|
| `1` | **Current** | Shipped in Phase 5 Week 9 Day 4. |

Adding new **optional** keys to `<slug>.json` or `observations[i]` at v1 is
non-breaking — existing tooling ignores unknown keys.

Removing or renaming existing keys, or changing the semantics of `match_key`,
requires incrementing `fixture_format_version` to `2` and shipping a
`halley fixture migrate --from=1 --to=2` command before the change lands.

---

## 6. Example

A 4-span `chat → execute_tool → chat → execute_tool` run (`multi-span-distinct`,
`gpt-4o-mini`, `halley-raw` dialect). The two `execute_tool` spans share the
same `match_key` (`39ef062e…`), demonstrating ordinal cursor matching. The two
`chat` spans have distinct `match_key` values (`d4e2520a…` and `30227078…`).
Deduplication: 4 observations × 2 body slots = 8 hash lookups → 6 unique files
(the two execute_tool spans share both input and output bodies).

```
examples/replay-target/
  halley/
    fixtures/
      multi-span-distinct.json
      multi-span-distinct/
        bodies/
          sha256-30227078....json   # chat-3 input body
          sha256-32ef3703....json   # chat-3 output body
          sha256-39ef062e....json   # execute_tool input body (shared by index 0 + 2)
          sha256-87fc178a....json   # execute_tool output body (shared by index 0 + 2)
          sha256-d4e2520a....json   # chat-1 input body
          sha256-f83182cd....json   # chat-1 output body
```

See `examples/replay-target/` in this repository for the actual fixture files.

---

## 7. Known limitations (v1)

### Float exponent representation divergence

The D22 canonical JSON hash is computed independently by the Python shim
(`sdk-py/halley_sdk/canonical.py`) and the Rust ingester
(`ingester/src/domain/span.rs::canonicalize_json`). Both agree on all float
values that appear in LLM chat completion request bodies (temperature, top_p,
frequency_penalty, presence_penalty — all short decimals or integers).

However, pathological floats with scientific-notation exponents can produce
different canonical strings:

| Value | Python `json.dumps` | Rust `serde_json` |
|---|---|---|
| `1e20` | `"1e+20"` | `"1e20"` |
| `1e-7` | `"1e-07"` | `"1e-7"` |
| `0.7`  | `"0.7"` (agree) | `"0.7"` (agree) |
| `0.0`  | `"0.0"` (agree) | `"0.0"` (agree) |

Since `hash(canonical)` differs when the canonical strings differ, a
fixture containing such values in its request bodies would not be
replayable across Python↔Rust boundaries. This does not affect the v1
hero loop (Python shim records and replays using the same Python
canonicalizer), nor the worker-written fixtures (worker uses the same
Rust canonicalizer that the ingester used to compute the stored hash).
It only affects the cross-language path: promoting a worker-written fixture
to shim replay, which is a Tier-1 (OTLP) path already known to be
non-bit-faithful (D53).

If this needs fixing in a future version, the solution is to normalize
float exponent format in the Python canonicalizer to match Rust's output
(strip the `+` sign and leading zeros from exponents).

### Tool-effect-safe replay: in-process tool limitation

The Python shim intercepts HTTP calls at the `httpx.Client.send` level. This
means:

- **HTTP-visible tools**: Tools whose invocation goes through an HTTP call
  intercepted by the shim (e.g., an OpenAI chat.completions request that
  includes a `tools` parameter with function definitions) **are guarded**. If
  the call misses the cassette in hybrid mode and the tool is marked
  `irreversible: true` in `halley.config.json`, the shim refuses the live
  call with exit code 79 and a clear error message.

- **In-process Python function tools**: Tools implemented as regular Python
  functions that are called directly by the agent (not through an HTTP
  provider call) are **NOT intercepted** by the shim in v1. Their side effects
  happen regardless of the replay mode. This is a fundamental constraint of
  the httpx-layer interception approach — the shim has no visibility into
  direct Python function calls.

**Implication**: If an agent implements tool execution in-process (calling a
Python function directly rather than delegating to a provider that calls back
via HTTP), the irreversible guard cannot protect against those side effects.
The guard only applies to tools whose `tools` parameter appears in an
intercepted OpenAI API request body.

This limitation is tracked for Phase 6. The correct fix is a higher-level
interception point (e.g., wrapping the agent's `tool_call` dispatch method)
or an explicit "dry-run" mode in the tool registry.
