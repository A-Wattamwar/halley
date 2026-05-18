/**
 * test-trace.mjs — standalone script to trigger a real Vercel AI SDK call
 * with OTEL tracing, without needing a browser or running Next.js.
 *
 * This script initialises the OTEL NodeSDK directly (same as instrumentation.ts
 * does in Next.js) and then calls generateText with experimental_telemetry.
 * Run with: node scripts/test-trace.mjs
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const OTLP_ENDPOINT =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces";

// Initialise OTEL SDK before any AI SDK calls.
const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
});
sdk.start();

console.log(`OTLP endpoint: ${OTLP_ENDPOINT}`);
console.log("Calling gpt-4o-mini with experimental_telemetry enabled...\n");

try {
    const { text, usage } = await generateText({
        model: openai("gpt-4o-mini"),
        prompt: "What is the capital of France? Answer in one word.",
        experimental_telemetry: {
            isEnabled: true,
            functionId: "test-trace",
            metadata: { source: "halley-vercel-ai-example" },
        },
    });

    console.log(`Answer: ${text}`);
    console.log(`Tokens — input: ${usage.promptTokens}, output: ${usage.completionTokens}`);
    console.log("\nShutting down OTEL SDK (flushes spans)...");
} catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
} finally {
    // Graceful shutdown flushes the OTLP exporter before process exits.
    await sdk.shutdown();
    console.log("Done. Check ClickHouse:");
    console.log(
        "  docker exec halley-clickhouse clickhouse-client --query \"SELECT count() FROM halley.observations WHERE source_dialect = 'vercel-ai'\""
    );
}
