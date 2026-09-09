import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5017", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 900 } } },
    { name: "touch", use: { browserName: "chromium", viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    command: "npm run build -w relay-core && next dev -H 127.0.0.1 -p 5017",
    url: "http://127.0.0.1:5017/dev/design-system",
    timeout: 120_000,
  },
});
