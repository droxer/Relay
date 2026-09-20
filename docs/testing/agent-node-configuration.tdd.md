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

## Initial broader verification and limits

- The initial `npm test` attempt failed while fetching Google fonts. The
  continuation below removes this build dependency.
- All compiled package and web unit tests: 1,608 passed, one existing failure in
  `dimensionScales.test.ts` against `computer.css` (`font-weight: 600`). Both
  files were unchanged by the runtime fixes.
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

## Validation blocker follow-up

The continuation fixes the two unrelated issues that prevented a complete test
run after the runtime changes:

- RED: `dimensionScales.test.ts` reproduced the unsupported weight 600 on
  `.computer-platform-support dt`. That emphasis label now uses the existing
  700 rung.
- RED checkpoint: `6b16c239` requires UI fonts to resolve from installed assets
  instead of `next/font/google`. The prior build failed downloading Noto CJK
  subsets from `fonts.gstatic.com`.
- GREEN: all 32 typography/dimension tests pass. The application now imports
  version-locked Fontsource 5.3.0 packages, preserving Noto Sans and regional
  SC/TC variable families, on-demand unicode subsets, and bundled OFL licenses.
- Browser smoke: served the production static export on loopback and used
  headless Chromium with all external requests blocked. `document.fonts.load`
  loaded the English, simplified Chinese, and traditional Chinese samples;
  computed body families matched the locale and no font request failed.
- CSS lint and npm audit pass (zero reported vulnerabilities).

The first complete run after removing those blockers passed the build, all 1,610
TypeScript tests, and all 143 React tests. Python reported 1,730 passed and two
failures that exposed timing assumptions in the test harness:

- The piped installer test closed `script(1)` stdin via `communicate()` before
  the token was consumed, producing “Could not read node token.” It now waits
  for the fixture installer's acknowledgement before closing that pipe.
- The lease reclamation test expected database operations to finish before a
  50 ms lease expired. It now freezes the store clock for the in-lease assertion
  and advances it explicitly beyond expiry for the retry assertion.

Both fixes preserve the original behavior assertions. All 261 tests in the two
affected Python files pass after these changes.

Final verification: the complete Python suite passes all 1,732 tests (527
existing warnings). Together with the successful production build, 1,610
TypeScript tests, and 143 React tests, all validation stages pass. The initial
combined `npm test` failure remains recorded above; after the Python-only
harness fixes, `npm run test:py` was rerun in full. No production backend
behavior was changed for these timing fixes.
