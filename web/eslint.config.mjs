import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "test-results/**",
    "next-env.d.ts",
    // Vendored from the reui.io registry; kept byte-close to upstream so
    // re-syncing stays a copy, not a merge.
    "src/components/reui/**",
  ]),
]);
