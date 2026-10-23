# PostgreSQL test alias regressions

The review identified two test-adapter failures: readable fixture IDs were
rejected before SQL binding could alias them, and tests marked `postgres`
enabled aliasing despite requiring raw PostgreSQL UUID behavior.

Tests were derived from those findings; there was no separate plan.

| Guarantee | Regression test | Type |
| --- | --- | --- |
| Readable IDs pass each UUID guard and round-trip through PostgreSQL UUID processors | `backend/tests/unit/test_postgres_backend.py::test_readable_ids_pass_guards_and_round_trip` | Unit, four store/helper references |
| Patches and cached processors stop aliasing after the test | Same parametrized test | Unit |
| The `postgres` marker preserves raw binds and validation | `test_postgres_marker_preserves_raw_uuid_binds` | Fixture integration without a live database |
| The explicit alias opt-out preserves UUID validation | `test_alias_opt_out_preserves_uuid_validation` | Unit |
| A nested raw context restores its outer aliases | `test_nested_raw_context_restores_outer_aliases` | Unit |

RED: `backend/.venv/bin/python -m pytest backend/tests/unit/test_postgres_backend.py -q`
reported **5 failed, 1 passed** before the fix. Four failures rejected readable
IDs; the fifth enabled aliasing for a marked test.

GREEN: the same tests, together with the task and session store suites, reported
**74 passed, 1 skipped**. The skipped test requires a live PostgreSQL database.
The nested-context regression subsequently failed before state restoration was
added; all **7 adapter cases** passed afterward. A final adapter/task/session
run reported **75 passed, 1 skipped**. Daemon-registry, waitlist,
and adapter checks also reported **333 passed** before the nested case was added.

The fix is confined to the test adapter and fixture; production UUID validation
remains intact. Numeric coverage was not measured because the environment does
not have the coverage package installed. The focused tests exercise PostgreSQL
UUID processors and fixture setup without a server; they do not replace a live
database run. RED/GREEN evidence is recorded here without checkpoint commits.

Broader checks: Ruff and `git diff --check` passed. `npm test` could not
complete because Turbopack's CSS processing attempted to bind a port and the
sandbox denied it (`Operation not permitted`). A separate full backend run
was interrupted after 171 passing tests; it is not a full-suite pass.
TypeScript compilation (`tsc -p packages/tsconfig.json`) passed. The separate
built TypeScript test run also encountered sandbox restrictions, including
socket/listener and process-spawn failures (`EPERM`); it was not a clean run.
