# Agent configuration on local and BoxLite nodes

Journeys were derived from the review request: run each configured agent on
local or remote daemon hosts, preserve existing local configuration, and keep
other providers' credentials out of the child process environment.

## Changes and guarantees

| Behavior | Regression evidence |
| --- | --- |
| Codex retains its native provider without a custom endpoint and accepts API-key-only readiness | `packages/relay-core/tests/handoff.test.ts` |
| Local Pi receives provider auth/models without overwriting its existing configuration; linked skills remain usable | `packages/relay-daemon/tests/agent-auth.test.ts` |
| Kimi/Moonshot variables map to the supported temporary model environment | `packages/relay-core/tests/handoff.test.ts` |
| Kimi rejects missing models, providers, and credentials, while accepting configured API keys and refreshable OAuth | `packages/relay-daemon/tests/agent-auth.test.ts` |
| Local subprocesses strip provider aliases and native Kimi model credentials before injecting the selected agent's environment | `packages/relay-daemon/tests/daemon.test.ts` |
| Local daemon discovery prepares Pi and refuses unconfigured Kimi; guest provisioning validates Kimi before copying configuration | `agent-auth.test.ts` and `handoff.test.ts` |
| Downloadable daemon includes its TOML parser and starts outside the repository | `packages/relay-daemon/tests/computer-bundle.test.ts` |

## RED/GREEN evidence

- RED checkpoint: `4626c6b0`. Runtime regressions reproduced the forced Codex
  provider, missing Kimi environment mapping, and inherited credential aliases.
  New Pi/Kimi configuration tests also failed compilation because the required
  `agent-auth` module did not yet exist. The intentionally failing typecheck was
  skipped for that test-only checkpoint; the final changes pass typechecks.
- Additional RED checks reproduced Codex API-key preflight rejection and Pi's
  failure to preserve a symlinked skills directory (`EISDIR`).
- GREEN: the focused core handoff, daemon, agent-auth, and computer-bundle suites
  pass 209 tests after package builds and `npx tsc -p packages/tsconfig.json`.
- Coverage command: `node --test --experimental-test-coverage
  --test-coverage-include='**/relay-daemon/src/agent-auth.js'` with those four
  compiled test files. The new auth module has 100% line/function coverage and
  over 90% branch coverage. This is scoped coverage, not a repository-wide claim.

## Broader verification

- `npm test` attempted the full build and suites. The web build failed fetching
  Google fonts; a separate `npm run build -w web` retry also failed.
- Running all compiled package and web unit tests directly: 1,604 passed, one
  failed. The failure is the existing `dimensionScales.test.ts` weight-ladder
  assertion against `computer.css` (`font-weight: 600`). Both files are unchanged
  from before this task.
- `npm run test:react -w web`: 143 passed.
- `npm run test:py`: 1,732 passed.
- `npx tsc -p web/tsconfig.json --noEmit`: passed.
- `npm audit --registry=https://registry.npmjs.org`: zero vulnerabilities. The
  configured mirror does not implement the audit endpoint.
- Offline smoke checks using temporary homes and dummy credentials: installed
  Codex accepts the native generated configuration; installed Pi resolves its
  generated model and auth key; installed Kimi resolves the translated model
  and key. The Kimi environment contract was also checked against the published
  0.39.1 package pinned in the image.

No paid model requests, live cloud provisioning, or external publication were
performed. Offline readiness validates configuration and credential presence;
provider-side revocation and endpoint availability still require a real request.
The backend execution boundary and event-store behavior are unchanged. No
schema or container-image change is needed. The installer bundle was rebuilt
with the new runtime dependency.
