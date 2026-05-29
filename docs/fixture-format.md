# Halley Fixture Format v1

> **LOCKED CONTRACT** — `fixture_format_version: 1`
>
> This document describes the on-disk layout of a Halley regression fixture.
> Once a fixture file is committed to a user's repo it is treated as
> immutable by Halley tooling. Field names and semantics are stable across
> patch releases. Additive changes (new optional keys) are non-breaking.
> Breaking changes require incrementing `fixture_format_version` and shipping
> a migration tool. See D52 in `docs/DECISIONS.md`.

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
| `match_key` | 64-char lowercase hex \| `""` | D22 canonical-JSON SHA-256 of the recorded input body. The replay shim matches incoming calls against this. Empty string = no input body captured. |
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
algorithm that the ingester used when recording, and looks up the matching
`observations[i]` by `match_key`.

- **Hit**: serve the recorded `output_body_ref` body as the provider response.
- **Miss**: make a live call, record the new response as a new fixture version.

The shim does **not** match on URL or HTTP method (all LLM calls POST to one
endpoint) and does **not** match on `span_id` (unstable across runs).

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

```
examples/replay-target/
  halley/
    fixtures/
      test-run-day3.json
      test-run-day3/
        bodies/
          sha256-3a7bd3e2....json    # input body (request)
          sha256-b14a7bcd....json    # output body (response)
```

See `examples/replay-target/` in this repository for a real fixture produced
from a seeded dev run.
