# Agent connection and communication fixes

Journeys were derived from the connection review: recover every durable output
chunk after reconnecting, keep the supervisor alive when bootstrap cannot spawn,
and require explicit permission before launching agents directly on the host.

## Guarantees

| Behavior | Regression evidence |
| --- | --- |
| Live durable output remains admissible after replay finalizes its command | `terminal-outbox.test.ts`: RED received no chunks; GREEN receives the chunk and empties the outbox |
| Missing local daemon executable rejects the launch without terminating the supervisor | `supervisor.test.ts`: RED unhandled ENOENT; GREEN rejected launch |
| Host execution without acknowledgement fails before spawning | `supervisor.test.ts`: RED missing rejection; GREEN rejects |
| Acknowledged host execution forwards the daemon permission flag | `supervisor.test.ts`: GREEN inspects actual spawned child arguments |
| Remote bootstrap with a missing working directory rejects safely | `supervisor.test.ts`: GREEN rejected launch |

Local and remote computers share the durable daemon transport. Output sends now
include the existing `replayed` flag, allowing the backend to recover output after
terminal delivery while retaining its lease checks and sequence deduplication.
Both exported supervisor launchers await spawn and handle later child errors.
The exported local launcher accepts `allowHostAgentExecution`, or the existing
`RELAY_ALLOW_HOST_AGENT_EXECUTION=1` setting, and forwards explicit permission.
Managed computers remain BoxLite-only; their provider does not use this launcher.

## Validation

- RED: `npx tsc -p packages/tsconfig.json`, then
  `node --test dist/packages/relay-daemon/tests/terminal-outbox.test.js dist/packages/relay-supervisor/tests/supervisor.test.js`.
  Output-loss assertion failed and the missing executable caused an unhandled
  child error. The host-execution test separately failed with missing rejection.
- GREEN and coverage: `node --experimental-test-coverage --test dist/packages/relay-daemon/tests/terminal-outbox.test.js dist/packages/relay-supervisor/tests/supervisor.test.js dist/packages/relay-supervisor/tests/managed-reconcile.test.js`:
  59 passed. Outbox lines/branches/functions: 94.48% / 87.88% / 93.75%.
  Launcher lines/branches/functions: 93.79% / 78.95% / 83.33%.
- All compiled TypeScript suites: 1,787 passed, no failures or skips.
- `npm run test:react -w web`: 331 passed in 49 files.
- `npm run build -w web -- --webpack`: production build passed.
- `npm test` could not complete its Turbopack build because build-worker port
  binding was denied, including on the escalated retry. Component suites were
  therefore run separately; detached-process tests required escalation.
- `npm run test:py`: 2,019 passed, 653 existing dependency/reflection warnings.
- `git diff --check`: passed.
- Dependency audits found existing advisories: npm reported four affected
  packages (one high, two moderate, one low); pip-audit reported two advisories
  in anyio 4.13.0. Dependency updates are outside this patch.

## Checkpoints and gaps

Local RED checkpoint: `fc37c6c2`; GREEN checkpoint: `d3eb3952`.
No changes were pushed. Backend already covers late output with a matching
completed lease in `test_daemon_registry.py`. Tests use simulated backend
transport and real child processes; no remote computer was provisioned.
Launcher branch coverage is below 80% because unrelated stop-escalation and
shell-template branches are not all exercised by this focused suite.
