import { defineConfig, devices } from "@playwright/test";

const port = process.env.RELAY_E2E_PORT ?? "5124";

/* The phone layout contracts (surfaceLayout.spec.ts) on both engines a phone
   actually runs: WebKit for every iPhone browser, Chromium for Android. The
   recovery suite runs them on Chromium alone, and a sheet, a sticky bar, or a
   docked toolbar can hold there and slip in Safari. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "surfaceLayout.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "iphone", use: { ...devices["iPhone 15"] } },
    {
      name: "android",
      use: { ...devices["Pixel 7"], launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
    },
  ],
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
