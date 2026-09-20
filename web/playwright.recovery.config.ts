import { defineConfig } from "@playwright/test";

const port = process.env.RELAY_E2E_PORT ?? "5124";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["computerConnection.spec.ts", "executionRecovery.spec.ts", "frontendRecovery.spec.ts", "taskKanban.spec.ts", "surfaceLayout.spec.ts", "performance.spec.ts", "teamCollaboration.spec.ts"],
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
