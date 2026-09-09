import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "jsdom",
    coverage: {
      provider: "v8",
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      include: ["src/lib/navigationGuard.ts", "src/components/ScreenErrorBoundary.tsx", "src/hooks/useSessionDetail.ts", "src/hooks/useSessionEvents.ts", "src/hooks/useTranscriptPin.ts"],
      reporter: ["text", "json-summary"],
    },
    include: ["interaction-tests/**/*.test.tsx"],
    setupFiles: ["./interaction-tests/setup.tsx"],
  },
});
