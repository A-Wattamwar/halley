"use client";

/**
 * InvariantEditor — client island for editing proposed invariants (D-11).
 *
 * Invariant types rendered:
 *   Structural — span count, operation sequence (exact vs subsequence mode),
 *                required operations (individually removable).
 *   Schema    — per-span key-path/type map; each key can be toggled
 *               required ↔ optional or removed entirely.
 *   Metric    — editable numeric bounds (cost, latency, tokens).
 *   Semantic  — disabled/read-only (runner is Phase 6).
 *
 * Save: POST /api/fixtures/[id] with the current edited state.
 */

import { useState } from "react";

// ── Shared invariant types (mirrors worker/src/jobs/invariant-infer.ts) ──────

export interface StructuralInvariants {
  span_count:             number;
  operation_sequence:     string[];
  /** New field added by editor — not present in raw worker output; defaults to "exact". */
  operation_sequence_mode?: "exact" | "subsequence";
  required_operations:    string[];
  parent_index:           Array<number | null>;
}

export interface SpanSchemaEntry {
  op:            string;
  key_types:     Record<string, string>;
  required_keys: string[];
}

export interface SchemaInvariants {
  per_span: Array<SpanSchemaEntry | null>;
}

export interface MetricInvariants {
  cost_max_usd:      number;
  latency_max_ms:    number;
  span_count:        number;
  input_tokens_max:  number;
  output_tokens_max: number;
}

export interface SemanticInvariant {
  enabled:     boolean;
  judge_model: string | null;
  rubric:      string | null;
}

export interface InvariantsJson {
  structural?: StructuralInvariants;
  schema?:     SchemaInvariants;
  metric?:     MetricInvariants;
  semantic?:   SemanticInvariant;
}

// ── Props ─────────────────────────────────────────────────────────────────

interface Props {
  fixtureId:         string;
  initialInvariants: InvariantsJson;
}

// ── Tiny UI primitives ───────────────────────────────────────────────────

function SectionCard({
  title,
  badge,
  children,
  onRemove,
}: {
  title:     string;
  badge?:    string;
  children:  React.ReactNode;
  onRemove?: () => void;
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-4">
      <div className="px-5 py-3.5 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
            {title}
          </h2>
          {badge && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-800 text-gray-400">
              {badge}
            </span>
          )}
        </div>
        {onRemove && (
          <button
            onClick={onRemove}
            className="text-xs text-red-500 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-950/50"
            title="Reject this section"
          >
            Reject
          </button>
        )}
      </div>
      <div className="px-5 py-4 space-y-3">{children}</div>
    </div>
  );
}

function Tag({
  label,
  mono,
  onRemove,
}: {
  label:     string;
  mono?:     boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
        mono ? "font-mono" : ""
      } bg-gray-800 text-gray-300 border border-gray-700`}
    >
      {label}
      {onRemove && (
        <button
          onClick={onRemove}
          className="text-gray-500 hover:text-red-400 transition-colors leading-none"
          title={`Remove ${label}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

function NumericInput({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label:    string;
  value:    number;
  onChange: (v: number) => void;
  step?:    number;
  min?:     number;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="text-sm text-gray-400 min-w-0 flex-1">{label}</span>
      <input
        type="number"
        className="w-36 px-2.5 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200
                   focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/40
                   tabular-nums text-right"
        value={value}
        step={step ?? 1}
        min={min ?? 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </label>
  );
}

// ── Editor sections ───────────────────────────────────────────────────────

function StructuralSection({
  data,
  onChange,
  onReject,
}: {
  data:     StructuralInvariants;
  onChange: (next: StructuralInvariants) => void;
  onReject: () => void;
}) {
  const mode = data.operation_sequence_mode ?? "exact";

  const removeRequiredOp = (op: string) =>
    onChange({
      ...data,
      required_operations: data.required_operations.filter((o) => o !== op),
    });

  const removeSeqOp = (idx: number) =>
    onChange({
      ...data,
      operation_sequence: data.operation_sequence.filter((_, i) => i !== idx),
    });

  return (
    <SectionCard
      title="Structural"
      badge={`${data.span_count} span${data.span_count === 1 ? "" : "s"}`}
      onRemove={onReject}
    >
      {/* Span count */}
      <div>
        <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
          Span count
        </p>
        <span className="text-sm text-gray-300 tabular-nums">
          Expected exactly <strong className="text-white">{data.span_count}</strong>{" "}
          span{data.span_count === 1 ? "" : "s"}
        </span>
      </div>

      {/* Operation sequence */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Operation sequence
          </p>
          {/* Exact vs subsequence toggle */}
          <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5 border border-gray-700">
            {(["exact", "subsequence"] as const).map((m) => (
              <button
                key={m}
                onClick={() =>
                  onChange({ ...data, operation_sequence_mode: m })
                }
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors capitalize ${
                  mode === m
                    ? "bg-blue-700 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.operation_sequence.length === 0 ? (
            <span className="text-xs text-gray-600 italic">
              All removed — sequence not enforced
            </span>
          ) : (
            data.operation_sequence.map((op, i) => (
              <Tag
                key={`${op}-${i}`}
                label={`${i + 1}. ${op}`}
                mono
                onRemove={() => removeSeqOp(i)}
              />
            ))
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-600">
          {mode === "exact"
            ? "Replay must produce this exact sequence."
            : "Replay must contain these operations as a subsequence (order preserved, extras allowed)."}
        </p>
      </div>

      {/* Required operations */}
      <div>
        <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
          Required operations
        </p>
        <div className="flex flex-wrap gap-2">
          {data.required_operations.length === 0 ? (
            <span className="text-xs text-gray-600 italic">
              None — all operations optional
            </span>
          ) : (
            data.required_operations.map((op) => (
              <Tag key={op} label={op} mono onRemove={() => removeRequiredOp(op)} />
            ))
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-600">
          Each listed operation must appear at least once in the replay.
        </p>
      </div>

      {/* Parent index — read-only summary */}
      <div>
        <p className="text-xs font-medium text-gray-500 mb-1.5 uppercase tracking-wide">
          Call-tree shape
        </p>
        <p className="text-xs text-gray-400">
          {data.parent_index.every((v) => v === null)
            ? "All root spans (flat)"
            : `Parent pointers: [${data.parent_index.map((v) => (v === null ? "∅" : String(v))).join(", ")}]`}
        </p>
      </div>
    </SectionCard>
  );
}

function SchemaSection({
  data,
  onChange,
  onReject,
}: {
  data:     SchemaInvariants;
  onChange: (next: SchemaInvariants) => void;
  onReject: () => void;
}) {
  const nonNull = data.per_span.filter(Boolean) as SpanSchemaEntry[];

  const updateSpan = (
    op: string,
    updater: (s: SpanSchemaEntry) => SpanSchemaEntry
  ) =>
    onChange({
      per_span: data.per_span.map((s) => (s?.op === op ? updater(s) : s)),
    });

  const toggleRequired = (op: string, key: string) =>
    updateSpan(op, (s) => ({
      ...s,
      required_keys: s.required_keys.includes(key)
        ? s.required_keys.filter((k) => k !== key)
        : [...s.required_keys, key],
    }));

  const removeKey = (op: string, key: string) =>
    updateSpan(op, (s) => ({
      ...s,
      key_types:     Object.fromEntries(
        Object.entries(s.key_types).filter(([k]) => k !== key)
      ),
      required_keys: s.required_keys.filter((k) => k !== key),
    }));

  return (
    <SectionCard title="Schema" onRemove={onReject}>
      {nonNull.length === 0 ? (
        <p className="text-sm text-gray-500 italic">No schema proposals.</p>
      ) : (
        nonNull.map((span) => (
          <div key={span.op} className="space-y-2">
            <p className="text-xs font-semibold text-gray-400 font-mono">
              op: {span.op}
            </p>
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-950/50">
                    <th className="text-left px-3 py-2 text-gray-600 font-medium w-1/2">
                      Key path
                    </th>
                    <th className="text-left px-3 py-2 text-gray-600 font-medium w-1/6">
                      Type
                    </th>
                    <th className="text-center px-3 py-2 text-gray-600 font-medium w-1/6">
                      Required
                    </th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {Object.entries(span.key_types).map(([key, type]) => {
                    const isRequired = span.required_keys.includes(key);
                    return (
                      <tr key={key} className="hover:bg-gray-800/20 transition-colors">
                        <td className="px-3 py-2 font-mono text-gray-300 truncate max-w-0">
                          {key}
                        </td>
                        <td className="px-3 py-2 text-gray-500">{type}</td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => toggleRequired(span.op, key)}
                            title={
                              isRequired
                                ? "Click to make optional"
                                : "Click to make required"
                            }
                            className={`w-9 h-5 rounded-full transition-colors ${
                              isRequired ? "bg-blue-600" : "bg-gray-700"
                            }`}
                          >
                            <span
                              className={`block w-3.5 h-3.5 rounded-full bg-white transition-transform mx-auto ${
                                isRequired ? "translate-x-2" : "-translate-x-2"
                              }`}
                            />
                          </button>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <button
                            onClick={() => removeKey(span.op, key)}
                            className="text-gray-600 hover:text-red-400 transition-colors"
                            title="Remove key"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </SectionCard>
  );
}

function MetricSection({
  data,
  onChange,
  onReject,
}: {
  data:     MetricInvariants;
  onChange: (next: MetricInvariants) => void;
  onReject: () => void;
}) {
  return (
    <SectionCard
      title="Metric"
      badge="20 % headroom"
      onRemove={onReject}
    >
      <NumericInput
        label="Max cost (USD)"
        value={data.cost_max_usd}
        step={0.00000001}
        min={0}
        onChange={(v) => onChange({ ...data, cost_max_usd: v })}
      />
      <NumericInput
        label="Max latency (ms)"
        value={data.latency_max_ms}
        step={1}
        min={0}
        onChange={(v) => onChange({ ...data, latency_max_ms: Math.round(v) })}
      />
      <NumericInput
        label="Max input tokens"
        value={data.input_tokens_max}
        step={1}
        min={0}
        onChange={(v) => onChange({ ...data, input_tokens_max: Math.ceil(v) })}
      />
      <NumericInput
        label="Max output tokens"
        value={data.output_tokens_max}
        step={1}
        min={0}
        onChange={(v) => onChange({ ...data, output_tokens_max: Math.ceil(v) })}
      />
      <p className="text-[11px] text-gray-600 pt-1">
        Bounds were computed as recorded value × 1.2. Edit to tighten or loosen.
      </p>
    </SectionCard>
  );
}

function SemanticSection({ data }: { data: SemanticInvariant }) {
  return (
    <SectionCard title="Semantic">
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <span className="w-8 h-5 rounded-full bg-gray-700 inline-block relative">
          <span className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-gray-500 block" />
        </span>
        <span>Disabled — semantic invariants are Phase 6</span>
      </div>
      {data.rubric && (
        <p className="text-xs text-gray-600 italic mt-1">
          Rubric: {data.rubric}
        </p>
      )}
    </SectionCard>
  );
}

// ── Main editor ───────────────────────────────────────────────────────────

export function InvariantEditor({ fixtureId, initialInvariants }: Props) {
  const [inv, setInv] = useState<InvariantsJson>(() => ({
    ...initialInvariants,
    structural: initialInvariants.structural
      ? {
          ...initialInvariants.structural,
          operation_sequence_mode:
            initialInvariants.structural.operation_sequence_mode ?? "exact",
        }
      : undefined,
  }));

  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const [writeState, setWriteState] = useState<
    "idle" | "enqueuing" | "queued" | "error"
  >("idle");
  const [writeError, setWriteError] = useState("");

  async function handleWrite() {
    setWriteState("enqueuing");
    setWriteError("");
    try {
      const res = await fetch(`/api/fixtures/${fixtureId}/save`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setWriteState("queued");
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
      setWriteState("error");
    }
  }

  async function handleSave() {
    setSaveState("saving");
    setErrorMsg("");
    try {
      const res = await fetch(`/api/fixtures/${fixtureId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ invariants_json: inv }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSaveState("error");
    }
  }

  return (
    <div>
      {/* Structural */}
      {inv.structural ? (
        <StructuralSection
          data={inv.structural}
          onChange={(next) => setInv({ ...inv, structural: next })}
          onReject={() => setInv({ ...inv, structural: undefined })}
        />
      ) : (
        <RejectedBanner
          title="Structural"
          onRestore={() =>
            setInv({ ...inv, structural: initialInvariants.structural })
          }
        />
      )}

      {/* Schema */}
      {inv.schema ? (
        <SchemaSection
          data={inv.schema}
          onChange={(next) => setInv({ ...inv, schema: next })}
          onReject={() => setInv({ ...inv, schema: undefined })}
        />
      ) : (
        <RejectedBanner
          title="Schema"
          onRestore={() => setInv({ ...inv, schema: initialInvariants.schema })}
        />
      )}

      {/* Metric */}
      {inv.metric ? (
        <MetricSection
          data={inv.metric}
          onChange={(next) => setInv({ ...inv, metric: next })}
          onReject={() => setInv({ ...inv, metric: undefined })}
        />
      ) : (
        <RejectedBanner
          title="Metric"
          onRestore={() => setInv({ ...inv, metric: initialInvariants.metric })}
        />
      )}

      {/* Semantic */}
      {inv.semantic && <SemanticSection data={inv.semantic} />}

      {/* Action bar */}
      <div className="mt-6 flex items-center justify-between gap-4 py-4 border-t border-gray-800">
        <div className="space-y-1">
          <p className="text-xs text-gray-600">
            <span className="font-semibold text-gray-400">Save invariants</span>
            {" — "}updates the edits above in Postgres (status stays{" "}
            <span className="font-mono text-amber-500">proposing</span>).
          </p>
          <p className="text-xs text-gray-600">
            <span className="font-semibold text-gray-400">Write to repo</span>
            {" — "}writes fixture files to the local repo and sets status to{" "}
            <span className="font-mono text-green-500">ready</span>.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Errors */}
          {saveState === "error" && (
            <span className="text-xs text-red-400">{errorMsg}</span>
          )}
          {writeState === "error" && (
            <span className="text-xs text-red-400">{writeError}</span>
          )}

          {/* Status indicators */}
          {saveState === "saved" && (
            <span className="text-xs text-green-400">Edits saved</span>
          )}
          {writeState === "queued" && (
            <span className="text-xs text-green-400">
              Write job queued — reload to see status update
            </span>
          )}

          {/* Save invariants */}
          <button
            onClick={handleSave}
            disabled={saveState === "saving"}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
              saveState === "saving"
                ? "bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed"
                : "bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700"
            }`}
          >
            {saveState === "saving" ? "Saving…" : "Save invariants"}
          </button>

          {/* Write to repo */}
          <button
            onClick={handleWrite}
            disabled={writeState === "enqueuing" || writeState === "queued"}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              writeState === "enqueuing" || writeState === "queued"
                ? "bg-violet-900 text-violet-400 cursor-not-allowed"
                : "bg-violet-600 hover:bg-violet-500 text-white"
            }`}
          >
            {writeState === "enqueuing"
              ? "Enqueuing…"
              : writeState === "queued"
              ? "Queued ✓"
              : "Write fixture to repo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rejected section placeholder ─────────────────────────────────────────

function RejectedBanner({
  title,
  onRestore,
}: {
  title:     string;
  onRestore: () => void;
}) {
  return (
    <div className="bg-gray-900/50 rounded-xl border border-dashed border-gray-800 px-5 py-4 mb-4 flex items-center justify-between">
      <span className="text-sm text-gray-600">
        <span className="font-semibold text-gray-500">{title}</span> — rejected
      </span>
      <button
        onClick={onRestore}
        className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
      >
        Restore
      </button>
    </div>
  );
}
