# Handoff runtime validation evidence

Journeys derived from the handoff design review:

- A receiver must check recorded files before preparing or executing its agent.
- A preceding writer must release the physical workspace before that check.
- Missing snapshots remain unknown; matching bytes do not approve completion.
- Required checks cannot silently disappear on an older daemon.

## RED and GREEN checkpoints

`35aa2c0c`: daemon regression ran an agent despite file drift; two backend tests
showed no capability gate or validation payload. The daemon test excludes startup
inventory/preflight calls and counts only preparation of the receiving workspace.

`0d9e63a9`: snapshot validation passed 107 daemon/unit tests and 83 backend tests.
An additional queued-writer test reproduced thread runs bypassing the existing
physical workspace gate (receiver prepared while the preceding writer held it).

`f1c27e7b`: thread runs now acquire the gate too. All 117 validator, daemon, and
workspace-gate tests passed. The queued test changes a previously matching file
while the first writer holds the gate; the receiver then rejects it after release.

## Commands and guarantees

```sh
npx tsc -p packages/tsconfig.json
node --test dist/packages/relay-daemon/tests/handoff-validation.test.js dist/packages/relay-daemon/tests/daemon.test.js dist/packages/relay-daemon/tests/workspace-run-gate.test.js
uv run --project backend --extra dev pytest backend/tests/api/test_team_routes.py backend/tests/unit/test_handoff_receipt.py -q --tb=short
node --test --experimental-test-coverage --test-coverage-include='dist/packages/relay-daemon/src/handoff-validation.js' dist/packages/relay-daemon/tests/handoff-validation.test.js
```

Validator coverage: 100% lines/functions and 93.10% branches. Cases include
matching and changed bytes, absent snapshots/files, directories, oversize files,
leaf/parent symlinks, path traversal, malformed/future contracts, receiver and
workspace mismatch, excessive reference counts, and command immutability.

Final backend boundary tests: 9 passed, covering capability absence/presence,
legacy versions 1/2 on older daemons, invalid receipts, frozen nonempty artifact
payloads, and receipt assignment/workspace mismatch before command publication.

Full `npm test` passed the production build/typechecks, 1,434 TypeScript tests,
19 React tests, and 1,242 Python tests (158.16 seconds for the backend suite).
The three final receipt-binding cases were added after that suite's collection
and passed in the separate nine-test boundary run above.

## Security and limits

The security skill guided bounded descriptor reads, no-follow/nonblocking opens,
path component checks before/after reads, and generic failures without file
contents or host paths. The backend never opens a daemon path. Nothing is restored,
deleted, or executed from checkpoint contents.

The gate excludes cooperative upgraded Relay writers. It does not defend against
a hostile host process racing directory replacement or an older daemon ignoring
the lock. Checks cover only recorded snapshots, not the entire workspace or Git
revision. Null hashes and missing checkpoints remain unknown. Tests use fake
agent execution, not live CLI behavior; no browser UI was changed or evaluated.

The dependency audit reports the existing Next.js critical, sharp high, and
baseline-browser-mapping moderate advisories. Dependencies were not changed.
