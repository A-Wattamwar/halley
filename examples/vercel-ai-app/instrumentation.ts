/**
 * instrumentation.ts — OTEL setup for the Vercel AI SDK example.
 *
 * Next.js 14 loads this file automatically when experimental.instrumentationHook
 * is set in next.config.mjs. The register() function runs once on server startup,
 * before any request handlers.
 *
 * The NodeSDK initialises the OTLP exporter and registers it as the global
 * tracer provider. Every subsequent Vercel AI SDK call that has
 * `experimental_telemetry: { isEnabled: true }` will emit spans through this
 * provider to Halley's ingester at :4318.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        const { NodeSDK } = await import("@opentelemetry/sdk-node");
        const { OTLPTraceExporter } = await import(
            "@opentelemetry/exporter-trace-otlp-http"
        );

        const sdk = new NodeSDK({
            traceExporter: new OTLPTraceExporter({
                // OTEL_EXPORTER_OTLP_ENDPOINT is the standard env var.
                // Falls back to Halley's default OTLP/HTTP endpoint.
                url:
                    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
                    "http://localhost:4318/v1/traces",
            }),
        });

        sdk.start();
    }
}
