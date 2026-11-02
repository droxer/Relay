# Native Windows execution evidence

Journeys were derived from the request to add native Windows command execution:
connect a Windows computer without Git Bash, discover its existing agent installs,
and run agents with the same permissions, output streaming and cancellation contract.

## Implementation

Local Windows command builders emit Node scripts, selected through
`commandExecution`; POSIX hosts and BoxLite retain Bash. The daemon supervises a
Node root and launches native executables or resolves npm `.cmd` launchers to
Node entrypoints. Arguments and Node eval payloads use private temporary files
rather than shell interpolation. Cancellation removes the execution's staging
directory after process-tree cleanup. Arbitrary batch wrappers fail explicitly.

Windows preflight, model discovery, skill/MCP inventory and permission adapter
startup use native execution. Skill directories use Windows junctions, and cache
validation compares canonical targets. The installer no longer probes for Git
Bash. Agent CLIs retain their own prerequisites and native permission policies.

## RED evidence

`node_modules/.bin/tsc -p packages/tsconfig.json --pretty false` failed after the
new tests were added because `commandExecution` and `native-command.js` did not
exist. Those were the intended missing implementation paths.

After basic launch support, the new discovery regression executed and failed:
it observed six `bash` invocations where six `relay-native` invocations were
required. Native model and inventory scripts resolved that failure.

## Final validation

| Guarantee | Evidence | Result |
| --- | --- | --- |
| All five runtimes build native run/preflight scripts | `native-windows.test.ts` | PASS |
| Native executables and npm shims preserve argv; adjacent POSIX npm shims are skipped | `native-windows.test.ts` | PASS |
| Unicode, quotes, metacharacters, large Node argv/eval payloads, cwd and exit codes survive execution | `native-windows.test.ts` | PASS |
| Failure stops subsequent commands; live cancellation removes private staging files | `native-windows.test.ts` | PASS |
| Model and inventory output fits existing parsers; provider credentials are excluded | `native-windows.test.ts` | PASS |
| Saved Claude login is used only for its vendor; provider requests emit model ids only | `native-windows.test.ts` | PASS |
| Pi selects JSON, streaming or legacy print mode according to installed help | `native-windows.test.ts` | PASS |
| Native skill transfer and immutable cache reuse preserve file contents | `native-windows.test.ts` | PASS |
| Agent execution retains the existing executor contract | `native-windows.test.ts` | PASS |
| Compiled client and installer bundle build | `npm run build:computer` | PASS |
| TypeScript packages and tests compile | `node_modules/.bin/tsc -p packages/tsconfig.json --pretty false` | PASS |
| Core and daemon regression suites | `node --test --test-timeout=120000 dist/packages/relay-core/tests/*.test.js dist/packages/relay-daemon/tests/*.test.js` | 822 PASS, 0 FAIL |
| Patch whitespace | `git diff --check` | PASS |

The 15 focused native tests pass. Focused coverage command:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='**/native-command.js' \
  --test-coverage-include='**/command-execution.js' \
  dist/packages/relay-daemon/tests/native-windows.test.js
```

Coverage for those launcher/selection modules: 99.10% lines, 69.05% branches,
94.74% functions. This is focused coverage, not repository-wide coverage.

## Environment limits

Tests ran on macOS. Windows script generation and executable lookup are tested
with Windows inputs; actual Node subprocess, streaming, cancellation, discovery
and skill-transfer behavior is exercised on the host. A live Windows installation,
Task Scheduler run, real Windows agent binaries, and junction behavior still need
Windows validation. Native binaries remain subject to their own argument limits.

The sandbox denied local HTTP and Unix-socket listeners; the final regression
suite ran with local socket access enabled. An initial run also exposed a missing
generated client bundle; rebuilding it resolved the bundle test failure.
