import { createClient } from "@clickhouse/client";

/**
 * Create a ClickHouse client for server-side queries.
 *
 * Reads connection details from environment variables (set via .env
 * and docker compose env_file). Falls back to localhost defaults for
 * local development outside Docker.
 *
 * NOTE: Use `@clickhouse/client` (Node.js), NOT `@clickhouse/client-web`.
 * Server Components run on Node.js. See Week 2 plan pitfall #1.
 */
export function getClickHouseClient() {
    return createClient({
        url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
        database: process.env.CLICKHOUSE_DATABASE ?? "halley",
        username: process.env.CLICKHOUSE_USER ?? "default",
        password: process.env.CLICKHOUSE_PASSWORD ?? "",
    });
}
