# Default team collaboration

Journeys derived from the request: submitting work to a team from a thread or
assigned task must run lead planning, delegated member work, then lead review
and final delivery.

## Behavior and ownership

- Regular members are required by default; explicit optional and on-request
  configuration remains authoritative. The team editor displays this default.
- New multi-member accomplish rounds require the work-results protocol, even
  without custom membership configuration. Older daemons receive the existing
  upgrade error instead of silently bypassing planning and evidence gates.
- The final lead brief requests review against the goal and acceptance criteria,
  repairs for defects, and a final result with validation and limitations.
- Dispatch remains sequential through the daemon. Plans and results remain
  event-backed. No schema, permissions, execution-plane, or acceptance-policy
  changes are introduced. Legacy single-agent recovery remains covered.

## RED / GREEN evidence

- RED: `uv run --project backend --extra dev pytest backend/tests/unit/test_team_dispatch.py -q`
  produced **7 failed, 17 passed**: ordinary members were optional, unconfigured
  multi-member teams omitted the work contract, and synthesis did not explicitly
  request final review. Checkpoint: `3b36dc78`.
- GREEN: the same unit target produced **24 passed**. The focused API,
  collaboration-policy, dispatch, and registry suite produced **397 passed**.
  Checkpoint: `b900e4b6`.

## Guarantees

| Guarantee | Test | Result |
| --- | --- | --- |
| Every regular role participates by default | `test_regular_team_members_are_required_by_default` | PASS, six roles |
| Explicit optional and on-request settings survive | `test_explicit_optional_contribution_is_preserved`, existing on-request cases | PASS |
| Thread and task submissions dispatch both members before final lead review | `test_default_team_delegates_all_members_then_lead_reviews` | PASS |
| Omitting a required member prevents completion | Same API test, omitted-member cases | PASS |
| Both configured and ordinary teams reject unsupported daemons | `test_team_work_contract_refuses_a_daemon_without_evidence_support` | PASS |
| Editor shows regular members as required and disables requirement for on-request members | `teamResponsibilities.test.tsx` | PASS, 2 tests |

Focused command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_team_routes.py backend/tests/unit/test_team_dispatch.py backend/tests/unit/test_collaboration_work.py backend/tests/unit/test_collaboration_service.py backend/tests/unit/test_daemon_registry.py -q --tb=short
```

Coverage command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_team_dispatch.py backend/tests/api/test_team_routes.py -k 'team_dispatch or default_team_delegates or task_assigned_to_team_starts' --cov=relay.services.team_dispatch --cov-report=term-missing -q
```

Result: **80%** of the dispatch module, **29 passed**. This is module coverage,
not a repository-wide coverage claim.

## Broader verification

- `npm test`: package and production web builds succeeded; **1,725 TypeScript
  tests** and **286 React tests** passed. The initial Python run was stopped
  after compatibility scope changed, then restarted with `npm run test:py`.
- `npm run test:py`: **1,827 passed, 2 failed** in 288.29 seconds. Both
  failures were scheduler fixtures advertising legacy daemons for new team
  work. Updated those two fixtures to advertise work-results and supply lead
  plans and member/final evidence. Reran the entire affected file with
  `uv run --project backend --extra dev pytest backend/tests/unit/test_task_scheduler.py -q --tb=short`:
  **29 passed**. No production code changed after the full run; the full suite
  was not repeated after these fixture-only corrections.
- `git diff --check` and commit hooks, including web typecheck: PASS.
- `npm audit --registry=https://registry.npmjs.org --json`: zero vulnerabilities.
  The configured npm mirror's audit endpoint is unimplemented.
- `uvx pip-audit --path backend/.venv/lib/python3.14/site-packages`: existing
  AnyIO 4.13.0 has CVE-2026-63374 and CVE-2026-64847 (fixed in 4.14.2).
  Dependency changes are outside this task.

The API tests simulate daemon reports; they do not launch paid agent CLIs or
prove that a live model actually performed every claimed check. Parallel
writable execution is unchanged and remains outside this implementation.
