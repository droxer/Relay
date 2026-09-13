# Handoff atomicity regression evidence

Source: [handoff design review](../agent-handoff-design-review.md). The journey
was derived while tracing the controller and conductor: when persistence fails
during a handoff, retrying must finish the transfer record rather than treating
a surviving decision as success.

## RED / GREEN

Command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_handoff.py -q
```

Before the fix: **2 failed, 4 passed** on the database-backed SQLite store.
Failure injection at `assigned` and `handoff:codex` left the stored session
different from its pre-operation snapshot.

After the fix: **6 passed**. Both failure points roll back the entire operation;
retry creates one decision and one assignment artifact, reaches the handoff
phase, and replay of the same decision ID returns an unchanged session.

The database-backed test exercises real event, artifact, and snapshot writes.
Only the selected status append is replaced to inject an exception.

## Adjacent continuity checks

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_bridge.py backend/tests/unit/test_conversation.py backend/tests/unit/test_handoff.py -q
```

**29 passed.** Covers existing prompt continuity behavior alongside the new
transaction regressions.

## Repository verification

- `npm run test:py`: **1,183 passed, 3 skipped, 1 failed**. The failure was
  `test_daemon_store_reclaims_expired_command_leases[<lambda>]`: its 50 ms
  lease expired before the assertion that it remained leased. This test does
  not call the changed controller method.
- Focused rerun with `pytest backend/tests/unit/test_daemon_registry.py -k
  test_daemon_store_reclaims_expired_command_leases -q`: **2 passed**. This
  supports a timing-sensitive failure; the full run is not recorded as green.
- `npx tsc -p packages/tsconfig.json`: passed.
- `npm run test:ts`: production build passed, **1,396 compiled tests passed**,
  and **15 React tests passed**. The first attempt was blocked by Turbopack's
  sandboxed worker port; the permitted rerun completed successfully.
- `git diff --check`: passed.

## Scope and limits

No schema, daemon protocol, or frontend behavior changed. The backend still
dispatches exclusively through daemons, and authoritative events remain the
source of session state. The existing controller transaction helper joins outer
transactions where the stores share an engine.

These tests do not prove cross-replica request serialization, live PostgreSQL
failure behavior, historical partial-record repair, or atomicity for the legacy
file-backed store. Coverage percentages were not measured. RED/GREEN evidence
is preserved here; no checkpoint commits were created.
