# Relay MCP installation diagnostics

Journeys derived from the reported installer screenshot: identify why Relay MCP
setup failed for Codex, preserve personal configuration, and distinguish a
temporary installation failure from a configuration requiring human repair.

The repository reproduced the opaque diagnostic, not the affected Computer's
underlying configuration. Its screenshot cannot distinguish a parse error,
ownership conflict, busy lock, or filesystem failure: `configureRelayMcp`
discarded every installer exception and marked all of them as blocked conflicts.

## RED and GREEN

- `node_modules/.bin/tsc -p packages/tsconfig.json` passed before and after the fix.
- RED: `node --test dist/packages/relay-daemon/tests/relay-mcp-install-diagnostics.test.js`
  ran the initial four cases; all four failed on generic conflict reporting or
  blocked status for transient failures.
- GREEN: the same command passed all four cases after introducing safe typed
  installer errors. Four additional edge cases were then added.
- `npm run build -w relay-core`, `npm run build -w relay-daemon`, and
  `npm run build -w relay-supervisor` passed.
- With local HTTP and IPC access enabled, the following passed all 41 tests:

  ```sh
  node --test --experimental-test-coverage \
    --test-coverage-include='**/relay-mcp-install.js' \
    --test-coverage-include='**/relay-mcp-bootstrap.js' \
    dist/packages/relay-daemon/tests/relay-mcp*.test.js \
    dist/packages/relay-daemon/tests/install.test.js
  ```

| Guarantee | Regression case |
| --- | --- |
| Invalid TOML identifies the file and remedy without exposing its contents | Invalid Codex TOML |
| Edited entries identify the runtime, server and file, preserving the edit | Edited entry |
| A live lock is retrying; release allows reconciliation to succeed | Live installer lock |
| Filesystem errors are retrying and retain a safe errno | Directory at the config path |
| Missing owned tables remain blocked conflicts rather than hash errors | Missing Codex table |
| Invalid JSONC identifies the runtime without exposing values | Invalid JSONC |
| Unsafe locks remain blocked and unchanged | Unsafe lock |
| A persistent error keeps mixed failures blocked while identifying both | Mixed errors |

The changed compiled modules under `dist/packages/relay-daemon/src` achieved
100% line and function coverage, with 95.77% branch coverage for the installer
and 84.85% for bootstrap. The report also includes separate packaged-client
copies, which are not fully exercised by this focused command; these numbers
are not repository-wide coverage.

## Broader verification and limits

- Direct compiled Node tests passed: 3,176 tests, zero failures:
  `node --test dist/packages/relay-core/tests/*.test.js dist/packages/relay-daemon/tests/*.test.js dist/packages/relay-supervisor/tests/*.test.js dist/web/tests/*.test.js`.
- `npm audit --offline --ignore-scripts` reported zero vulnerabilities in the
  locally available advisory data. `git diff --check` passed.
- `npm run test:ts` stopped at the Next.js build because Turbopack could not
  resolve the linked dependency tree outside this worktree.
- `npm run test:react -w web`: 1,064 tests passed, but eight suites could not
  collect because `@tanstack/react-table` was unavailable in the shared dependency
  tree. This is not a clean full frontend result.
- The optional full Python run was stopped after 318 passed, seven skipped,
  and three installer TTY failures (`/dev/tty: Operation not permitted` inside
  the sandbox). Rerunning `PYTHONPATH=backend /Users/feihe/Workspace/Relay/backend/.venv/bin/python -m pytest backend/tests/api/test_computer_installer.py -q`
  with terminal access passed all 24 installer tests. No Python runtime code
  changed; the full Python suite remains unverified.
- A RED checkpoint commit was attempted but the sandbox denied creating the
  shared worktree Git index lock. No checkpoint commits were created; the
  RED/GREEN evidence is preserved here.

User-owned entries, ownership manifests, and lock safety checks retain their
existing protections. No account credentials or third-party resources changed.
The affected Computer needs the updated client to report its specific cause;
this change does not silently overwrite a genuinely conflicting configuration.
