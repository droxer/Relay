# Handoff redesign, step 2: structured receipts

The work receipt carries protected requirements separately from trimmed history.
Agent-authored checkpoint claims remain attributed evidence. Artifact IDs and
SHA-256 hashes identify persisted source-run snapshots; the receiver must still
inspect live files. Runtime validation and ownership fencing remain step 3.

## RED

Checkpoint `b9c1e3ae` records six failing receipt tests. The old capture API had
no receipt, task requirements, checkpoint provenance, or protected-text limit.
An added prepared-retry test also failed when a later task edit became too large:
the retry attempted to recapture requirements instead of reusing accepted data.

## GREEN

- Receipt/context unit tests: 17 passed, including stale assignment, wrong run,
  malformed JSON, excessive nesting/size, invalid field types, missing snapshots,
  bounded reference lists, and preservation of full original/current requests.
- Task/team API and context tests: 71 passed, including prepared replay with
  requirements changed after acceptance.
- TypeScript compilation and 13 prompt/replay tests passed. All four executors
  receive checkpoint instructions; the receipt survives core replay/browser SSE.
- `npm test` passed the production build, 1,406 TypeScript tests, 19 React tests,
  and 1,216 backend tests. Subsequent focused checks cover context version 2,
  including legacy version 1 delivery and rejection of missing/future receipts.
- Final regression run: 281 daemon-registry, team API, receipt and context tests
  passed after the version 2 compatibility change.

Coverage command:

```sh
uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.sessions.handoff_receipt --data-file=/tmp/relay-receipt-coverage-final -m pytest backend/tests/unit/test_handoff_receipt.py backend/tests/unit/test_handoff_context.py -q --tb=short
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-receipt-coverage-final -m
```

The new receipt module reports 92% combined statement/branch coverage.

## Limits

Checkpoints are optional agent output, bounded to 8 KiB and validated against
the source assignment. A failed/cancelled run or older daemon may not report a
snapshot; that remains an explicit missing checkpoint. Snapshot coverage is
partial, not a full filesystem or Git-state attestation. No live agent behavior
evaluation was run; tests establish the deterministic contract and delivery.

The security review guided bounded parsing, allowed checkpoint fields,
attribution, and database-only snapshot reads. No checkpoint content is executed
by the backend or granted permission/completion authority.

New captures use handoff context version 2 with a required version 1 receipt.
Upgrade backend replicas before generating version 2: older backends reject it
rather than silently dropping requirements. Existing version 1 contexts remain
readable. Dependency audit still reports the existing Next.js, sharp, and
baseline-browser-mapping advisories; dependencies were not changed.
