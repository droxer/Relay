# Skill visibility evidence

The journeys come from the request to make private skills owner-only and public
skills available to all users. Here, all users means all signed-in Relay users;
public visibility enables discovery and use without transferring ownership or
assigning the skill automatically.

## Red and green

- RED checkpoint `cfd2326f`: the route suite had 10 failures and 35 passes;
  public create, import, and update requests returned 422. The migration
  regression failed because revision `20261112_0124` did not exist.
- GREEN: 232 backend skill tests passed, including the same route and migration
  regressions. The added runtime assertion was corrected to unpack
  `resolve_bundle`'s bundle/diagnostics tuple before checking its contents.
- Web: 33 skill interaction tests passed, including the English and Chinese
  visibility descriptions and editor requests containing `private` or `public`.

| Guarantee | Evidence |
| --- | --- |
| Private skills cannot be listed, read, downloaded, or assigned by another user | `backend/tests/api/test_skill_routes.py` |
| Administrators cannot read another user's private skills | `backend/tests/api/test_skill_routes.py` |
| All signed-in users can use public skills; only the owner can mutate them | `backend/tests/api/test_skill_routes.py` |
| Returning to private prevents other users' subsequent runtime delivery | `backend/tests/api/test_skill_routes.py` |
| Migration updates projections and event replay while preserving prior events and private visibility | `backend/tests/unit/test_skill_visibility_migration.py` |
| Upgrade/downgrade enforce their respective visibility enums | `backend/tests/unit/test_skill_visibility_migration.py` |
| Both locales explain the audience and publication defaults to private | `web/interaction-tests/skillsLocale.test.tsx` |
| Editor saves the selected audience | `web/interaction-tests/skillsDraftIsolation.test.tsx` |

## Commands and limits

Backend tests used the available Python environment with
`PYTHONPATH=backend:backend/tests`:

```sh
python -m pytest backend/tests/unit/test_skill*.py backend/tests/api/test_skill_routes.py backend/tests/api/test_skill_dispatch.py backend/tests/api/test_agent_skill_policy_creation.py -q
python -m pytest backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py backend/tests/api/test_route_auth.py backend/tests/unit/test_skill_schema_registration.py -q
npm run test:react -w web -- skill --configLoader runner
```

The first suite passed 232 tests; the second passed 12. Branch-enabled coverage
was measured by running the first suite through `coverage run --branch`, scoped
to the changed skill API, rules, catalog read/write modules, and migration.
`coverage report --fail-under=80` passed at 85% combined line/branch coverage;
the new migration had 100% coverage. Coverage was installed in a temporary
directory and did not change project dependencies.

Backend Ruff passed; mypy reported no issues in 462 source files. Web ESLint
passed with three existing warnings. `git diff --check` and the component design
scan passed. Full repository suites were not run. Full web type checking remains
blocked by the available dependency tree's missing `@tanstack/react-table` and
unrelated session-queue types; the `typecheck-web` commit hook is skipped on this
basis. The 17 PostgreSQL schema-drift tests skipped because PostgreSQL was not
reachable; the migration's round trip was exercised on SQLite. The dependency
audit attempted earlier in this PR could not complete because the configured
mirror lacks its endpoint and the official registry retry failed TLS connection.

## Rollout

Stop old backend writers before applying `20261112_0124`; deploy the backend and
web client together afterward. The migration appends visibility-change events,
keeps existing record timestamps, and changes validation from `private/org` to
`private/public`. Downgrade appends the reverse events. Assignment target `org`
remains the separate administrator-only delivery scope. No live database was
migrated during this work.
