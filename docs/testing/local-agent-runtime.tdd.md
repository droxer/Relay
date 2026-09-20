# Local agent runtime fixes

The implementation follows the review accepted in this conversation: preserve
native runtime configuration, make permission bypass explicit, bound process-group
cleanup, align discovery with configured homes, and keep doctor read-only.

## Guarantees and evidence

| Guarantee | Test | Evidence |
| --- | --- | --- |
| Local Claude/Codex/Kimi do not bypass permissions by default; trusted opts in | `packages/relay-core/tests/local-agent-runtime.test.ts` | RED: existing Claude command contained `bypassPermissions`; GREEN: native/trusted/invalid policy assertions pass |
| Doctor does not register nodes or persist credentials | `packages/relay-daemon/tests/daemon.test.ts` | RED: observed POST registration instead of GET; GREEN: authenticated GET only, no credential file created |
| Authentication checks use runtime tokens without renewing liveness | `backend/tests/api/test_daemon_api.py` | RED: missing endpoint returned 404; GREEN: runtime/UI token separation, invalid/unknown/deleted node cases |
| Process-group cleanup stops waiting at its deadline and cannot report success | `packages/relay-daemon/tests/daemon.test.ts` | RED: returned exit 0 after deadline; GREEN: exit -1 with cleanup error |
| Discovery uses custom runtime homes | `packages/relay-daemon/tests/daemon.test.ts` | RED: custom Codex skills were missing; GREEN: custom skills and MCP server discovered |
| Background settings and credential references survive terminal environment loss | `packages/relay-daemon/tests/runtime-profile.test.ts`, `install.test.ts` | GREEN: real packaged CLI doctor reads saved custom home in a clean launch environment; credentials stay out of service/profile output |
| Invalid/private-file boundaries fail closed | `packages/relay-daemon/tests/runtime-profile.test.ts` | GREEN: reject exposed files, unsupported variables and malformed JSON without echoing values |

The initial TypeScript RED check also identified the absent runtime-profile module
and cleanup deadline option. A RED checkpoint commit was attempted, but the
repository's typecheck hook correctly rejected that intentionally uncompilable
state. The hook was not bypassed. This report preserves the RED evidence alongside
the final implementation commit.

## Validation

- Final `npm test`: PASS, including production builds and TypeScript compilation,
  1,620 Node tests, 161 React interaction tests, and 1,749 Python tests.
  Python emitted 533 dependency/reflection warnings; no tests failed or skipped.
- `git diff --check` and repository pre-commit checks: PASS.
- Implementation checkpoint: `69a879d1` (local branch, not pushed).
- Focused initial suite: 120 tests passed.
- Node coverage run: 112 tests passed. Across test and packaged copies of the three
  extracted runtime modules: 88.62% lines, 77.56% branches, 94.55% functions.
  The test-compiled modules individually cover 96.05% / 83.48% / 100% of lines
  (`local-runtime`, `process-supervisor`, `runtime-profile` respectively).
- `npm audit --registry=https://registry.npmjs.org --json`: zero vulnerabilities.
  The configured mirror's audit API was unavailable; no registry setting changed.

Coverage command:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='**/process-supervisor.js' \
  --test-coverage-include='**/local-runtime.js' \
  --test-coverage-include='**/runtime-profile.js' \
  dist/packages/relay-daemon/tests/daemon.test.js \
  dist/packages/relay-daemon/tests/runtime-profile.test.js \
  dist/packages/relay-daemon/tests/agent-auth.test.js \
  dist/packages/relay-daemon/tests/install.test.js
```

## Limits and rollout

Deploy the backend before the new client: doctor/setup now require
`GET /api/v1/daemon-nodes/{id}/auth-check`. Reinstall existing services to generate
a runtime profile. Local execution now defaults to native CLI permissions;
`--local-permission-policy trusted` explicitly restores unattended bypass flags.
Native policy is not an OS sandbox and interactive approvals can block headless
work. Runtime credentials remain in user-owned files; restart after rotation.

Installer tests use real packaged Node entrypoints with fake service managers and
agent executables. They do not install a real login service or make paid model
calls. Process-group tests cover ordinary Unix descendants; processes escaping
the group and uninterruptible kernel waits need stronger OS isolation. CLI paths
still follow the saved PATH, and runtime versions are not pinned by this change.
