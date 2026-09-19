# Computer setup and deleted-node lifecycle

## Intent and ownership

Journeys were derived from the reported setup experience, without a separate
plan: connect with one installer command, reconnect using the same service, and
stop cleanly when the backend reports deletion. Normal completion should not
require the user to understand PATH, launchctl, or systemctl.

Changes belong to `packages/relay-daemon/src/install.ts` (service policy and
completion output) and `src/index.ts` (terminal HTTP 410 during command polling).
The backend protocol, credentials, event stores, and execution boundary are
unchanged. No schema or migration changes are required.

## Red/green evidence

| Guarantee | Test and red evidence | Final result |
| --- | --- | --- |
| Clean exits stay stopped; failures can restart | `install.test.ts`: generated macOS KeepAlive was unconditional, so the new policy assertion failed | PASS for macOS and Linux service definitions |
| Setup prints a simple completion message | Packaged installer test failed because `Connected to Relay. You can close this terminal.` was absent | PASS; diagnostics appear only with `--verbose` |
| Reinstall uses the same service definition | Packaged installer is executed twice against a fixture backend and isolated HOME | PASS; same service content, successful registration both times |
| Deleted nodes exit successfully | Packaged CLI receives HTTP 410 and must exit 0 without exposing its token | PASS |
| Deletion during polling does not re-register | `daemon.test.ts` with a one-second bound observed 175 registrations instead of one before the fix | PASS; one initial registration, clean shutdown for both registration and poll deletion |

Focused commands:

```sh
npx tsc -p packages/tsconfig.json
node --test dist/packages/relay-daemon/tests/install.test.js
node --test --test-name-pattern='deletion is reported' dist/packages/relay-daemon/tests/daemon.test.js
```

A temporary real macOS launchd service using `serviceDefinition` wrote its start
count, exited 1 on its first invocation, then exited 0. It restarted once after
failure and stayed at two starts for 12 seconds after success (longer than the
10-second throttle). The temporary service and files were removed afterward.

## Broader verification

- `npm run build:computer`: PASS; downloadable installer bundle rebuilt.
- `npx tsc -p packages/tsconfig.json`: PASS.
- All compiled core/chat/daemon/supervisor/web tests via `node --test`: 1,592
  passed, one unrelated typography failure (`computer.css: font-weight: 600`).
- `npm run test:react -w web`: 143 passed across 25 files.
- `npm run test:py`: 1,713 passed.
- `npm test`: blocked at web production build by a Google Fonts download failure
  reported through Turbopack's internal font module resolution. Test suites were
  run separately as recorded above.
- `npm audit --registry=https://registry.npmjs.org --audit-level=high`: zero
  vulnerabilities. The configured mirror does not implement the audit endpoint.
- `git diff --check`: PASS.

The initial lifecycle RED checkpoint is commit `102c6abf`. This report preserves
the later output and polling RED evidence alongside the final implementation.
No aggregate coverage percentage was collected; Linux service policy was tested
as configuration, not against a running Linux systemd instance.

## Rollout limits

Existing service definitions receive the restart policy on reinstall. Login
startup remains enabled; a deleted registration exits cleanly if launched again
at login. The already-deleted service on the reporting Mac was unloaded and its
login definition archived outside LaunchAgents, preventing future login starts.
The current healthy connection was left running.
