import { defineConfig } from "@playwright/test";

const port = process.env.RELAY_CONCURRENCY_E2E_PORT ?? "5128";
export default defineConfig({
  testDir: "./e2e", testMatch: ["concurrency.spec.ts", "workspaceScope.spec.ts"], workers: 1, retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`, serviceWorkers: "block",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/concurrency-server.mjs", url: `http://127.0.0.1:${port}/api/v1/auth/status`,
    reuseExistingServer: false, timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
