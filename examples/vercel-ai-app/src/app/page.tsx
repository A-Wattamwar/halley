"use client";

import { useState } from "react";
import { askQuestion } from "./actions";

const SAMPLE_QUESTIONS = [
    "What is the capital of France?",
    "Explain what OpenTelemetry is in one sentence.",
    "What is 17 * 23?",
];

export default function Home() {
    const [question, setQuestion] = useState(SAMPLE_QUESTIONS[0]);
    const [answer, setAnswer] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setLoading(true);
        setAnswer(null);
        setError(null);

        try {
            const result = await askQuestion(question);
            setAnswer(result);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    }

    return (
        <main>
            <h1 style={{ marginBottom: "0.5rem" }}>Halley — Vercel AI SDK Example</h1>
            <p style={{ color: "#666", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
                Each request emits an OTLP trace to Halley via{" "}
                <code>experimental_telemetry: {"{ isEnabled: true }"}</code>.
                Traces land as <code>source_dialect = &quot;vercel-ai&quot;</code>.
            </p>

            <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: "1rem" }}>
                    <label htmlFor="question" style={{ display: "block", marginBottom: "0.5rem", fontWeight: "bold" }}>
                        Question
                    </label>
                    <input
                        id="question"
                        type="text"
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        style={{
                            width: "100%",
                            padding: "0.5rem",
                            fontSize: "1rem",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                            boxSizing: "border-box",
                        }}
                    />
                </div>

                <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {SAMPLE_QUESTIONS.map((q) => (
                        <button
                            key={q}
                            type="button"
                            onClick={() => setQuestion(q)}
                            style={{
                                padding: "0.25rem 0.75rem",
                                fontSize: "0.8rem",
                                border: "1px solid #ccc",
                                borderRadius: "4px",
                                background: question === q ? "#e8f4fd" : "white",
                                cursor: "pointer",
                            }}
                        >
                            {q}
                        </button>
                    ))}
                </div>

                <button
                    type="submit"
                    disabled={loading || !question.trim()}
                    style={{
                        padding: "0.5rem 1.5rem",
                        fontSize: "1rem",
                        background: loading ? "#ccc" : "#0070f3",
                        color: "white",
                        border: "none",
                        borderRadius: "4px",
                        cursor: loading ? "not-allowed" : "pointer",
                    }}
                >
                    {loading ? "Asking…" : "Ask (emits trace)"}
                </button>
            </form>

            {answer && (
                <div style={{ marginTop: "1.5rem", padding: "1rem", background: "#f0f9f0", borderRadius: "4px", border: "1px solid #c3e6c3" }}>
                    <strong>Answer:</strong>
                    <p style={{ margin: "0.5rem 0 0" }}>{answer}</p>
                </div>
            )}

            {error && (
                <div style={{ marginTop: "1.5rem", padding: "1rem", background: "#fff0f0", borderRadius: "4px", border: "1px solid #f5c6c6" }}>
                    <strong>Error:</strong> {error}
                </div>
            )}

            <hr style={{ margin: "2rem 0", borderColor: "#eee" }} />
            <p style={{ fontSize: "0.8rem", color: "#999" }}>
                Verify traces:{" "}
                <code>
                    docker exec halley-clickhouse clickhouse-client --query &quot;SELECT count() FROM halley.observations WHERE source_dialect = &apos;vercel-ai&apos;&quot;
                </code>
            </p>
        </main>
    );
}
