# Local and BoxLite agent configuration

Journeys were derived from the review and the requirement that local computers
use the user's installed runtime and its existing authorization.

## Runtime contract

- Local execution resolves Claude, Codex, Pi, and Kimi from the user's `PATH`.
  Native config directories, stored login, provider, model, and launch-environment
  settings belong to those CLIs. Relay-loaded dotenv settings and aliases do not
  override them. No local Pi auth/model overlay or shared skill installation is
  performed, and local execution does not require `stdbuf`.
- Local Claude/Codex managed skills are delivered as paths in task instructions;
  their config/auth home is never replaced. Pi/Kimi retain explicit skill flags.
  Required-skill validation and immutable materialization still apply.
- BoxLite keeps explicit credential/model provisioning, per-agent credential
  scoping, configuration validation, and its existing skill delivery mechanisms.
- Both paths keep provider credentials out of command arguments and unrelated
  agent environments. Kimi readiness checks are read-only; native mode reads the
  user's chosen home and ignores Relay-only aliases.

## Regression guarantees

| Guarantee | Tests |
| --- | --- |
| Local commands do not force provider/model settings or relocate auth homes | `packages/relay-core/tests/local-agent-runtime.test.ts` |
| Relay dotenv credentials stay out of local execution while native launch settings survive | `local-agent-runtime.test.ts` subprocess test |
| All four installed-runtime stand-ins use their existing custom auth directories | `packages/relay-daemon/tests/agent-auth.test.ts` |
| Pi's saved auth/model files remain unchanged and local discovery creates no config/skill directories | `agent-auth.test.ts` local doctor test |
| Assigned local Claude/Codex skills do not replace authorization configuration | `local-agent-runtime.test.ts`, `packages/relay-daemon/tests/agent-skills.test.ts` |
| Guest config, stream rendering, older/newer Pi commands, and credential isolation remain covered | `packages/relay-core/tests/handoff.test.ts`, `skill-delivery.test.ts`, `packages/relay-daemon/tests/daemon.test.ts` |
| Standalone daemon contains its runtime dependencies | `packages/relay-daemon/tests/computer-bundle.test.ts` |

## RED/GREEN evidence

- RED checkpoint: `5f69aeea`. Tests reproduced forced local model/provider flags,
  rewritten home directories, and Relay alias translation. A further RED test
  reproduced managed skills replacing native authorization homes.
- GREEN: 233 focused tests passed after rebuilding core, daemon, the standalone
  computer bundle, and compiling tests with `npx tsc -p packages/tsconfig.json`.
- Coverage: `node --test --experimental-test-coverage`, scoped to `commands.js`,
  `env.js`, `guest.js`, and `agent-auth.js`, across the seven focused test files
  listed above: 94.22% lines, 88.03% branches, 89.71% functions. This is scoped
  coverage, not a repository-wide claim.
- Earlier cloud regressions retain their RED/GREEN history in `4626c6b0` and
  `b70a36e5`; native runtime behavior is governed by the contract above.

## Broader verification and limits

- `npm test` was attempted; the web build fails while fetching Google fonts.
- All compiled package and web unit tests: 1,608 passed, one existing failure in
  `dimensionScales.test.ts` against `computer.css` (`font-weight: 600`). Both
  files are unchanged by these fixes.
- `npm run test:react -w web`: 143 passed.
- `npm run test:py`: 1,732 passed.
- `npx tsc -p web/tsconfig.json --noEmit`: passed.
- `npm audit --registry=https://registry.npmjs.org`: zero vulnerabilities.
- `git diff --check`: passed.

The native invocation tests use temporary homes and runtime stand-ins, without
reading or changing the operator's real login files. No paid model requests or
live cloud provisioning were performed. Offline readiness cannot establish
provider-side key validity or network availability. No schema or container-image
change is needed; rebuild/restart the daemon to use the updated runtime path.
