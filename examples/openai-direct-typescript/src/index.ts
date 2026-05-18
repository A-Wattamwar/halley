/**
 * OpenAI direct TypeScript example — OpenInference instrumentation.
 *
 * Demonstrates Halley's openinference adapter path:
 *   openai SDK + @arizeai/openinference-instrumentation-openai
 *   → spans with openinference.span.kind, llm.model_name, llm.token_count.*
 *   → source_dialect = "openinference" in ClickHouse
 *
 * Environment variables:
 *   OPENAI_API_KEY                  — required
 *   OTEL_EXPORTER_OTLP_ENDPOINT     — optional, default http://localhost:4318/v1/traces
 *
 * Run with: npx tsx src/index.ts
 *
 * IMPORTANT: The OTEL SDK and OpenInference instrumentation are initialised
 * at the top of this file using static imports. The instrumentation patches
 * the openai module via require() hooks, which run before any openai code
 * executes. The OpenAI client is created inside main() to ensure the patch
 * is applied first.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";

const OTLP_ENDPOINT =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces";

const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
    instrumentations: [new OpenAIInstrumentation()],
});
sdk.start();

// Use require() for openai so the instrumentation patch (applied by sdk.start())
// is in place before the module is loaded. TypeScript static imports are hoisted
// and would load openai before sdk.start() runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenAI = require("openai").default as typeof import("openai").default;

const MODEL = "gpt-4o-mini";

const PROMPTS = [
    "What is the capital of Japan? Answer in one word.",
    "What is 13 * 7? Answer with just the number.",
    "Name one planet in our solar system. One word only.",
    "What color is the sky on a clear day? One word.",
];

async function main(): Promise<void> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    console.log(`Model: ${MODEL}`);
    console.log(`OTLP:  ${OTLP_ENDPOINT}`);
    console.log(`Calls: ${PROMPTS.length}\n`);

    for (const prompt of PROMPTS) {
        const response = await client.chat.completions.create({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 10,
        });

        const answer =
            response.choices[0]?.message?.content?.trim() ?? "(no response)";
        const inputTok = response.usage?.prompt_tokens ?? 0;
        const outputTok = response.usage?.completion_tokens ?? 0;

        console.log(`Q: ${prompt}`);
        console.log(`A: ${answer}  [in=${inputTok} out=${outputTok}]`);
        console.log();
    }

    console.log("Shutting down OTEL SDK (flushes spans)...");
    await sdk.shutdown();

    console.log("Done. Verify in ClickHouse:");
    console.log(
        "  docker exec halley-clickhouse clickhouse-client --query \"SELECT count() FROM halley.observations WHERE source_dialect = 'openinference'\""
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
