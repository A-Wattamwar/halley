import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for Halley dashboard E2E tests.
 *
 * Tests run against a live stack (dashboard on port 3000, ingester on port 4318).
 * HALLEY_AUTH_REQUIRED=false (set in .env) is required — tests do not log in.
 *
 * Run against dev server:   npx playwright test
 * Run against Docker image: DASHBOARD_URL=http://localhost:3000 npx playwright test
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  retries: 1,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.DASHBOARD_URL ?? "http://localhost:3000",
    headless: true,
    ...devices["Desktop Chrome"],
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
