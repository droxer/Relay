# Team mode review fixes

Journeys derived from the agent-team implementation review:

- A Pipeline's final specialist must perform its own work before summarizing
  the round, including when that specialist is the only implementer or tester.
- Build & Review must dispatch its selected builder and reviewer even if an
  unused roster member is disabled. Disabled selected members must still be
  rejected, for both new threads and continued messages.

## Changes

Pipeline keeps the final specialist's role-specific brief and work kind, and
adds the final-result responsibility to that brief. Its synthesizer flag still
identifies the aggregate result owner. Lead-led synthesis remains unchanged.

Team roster resolution retains team authorization, enabled-team checks and
roster integrity checks. The existing agent router validates enabled status
after participants are selected. Disabled selected members now produce
`agent_disabled`, including scheduler rejection, instead of `team_disabled`.

## RED and GREEN

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest \
  backend/tests/unit/test_team_dispatch.py \
  backend/tests/api/test_team_routes.py -q \
  -k 'pipeline_result_owner or team_message_defaults'
```

RED: **10 failed, 2 passed**. Four Pipeline cases lost their specialist briefs;
two unused-lead cases rejected dispatch; four selected-member cases still
reported the old team-wide error. Checkpoint: `381693f4`.

GREEN: **12 passed** after the fix. Checkpoint: `f26832a2`.

| Guarantee | Test |
| --- | --- |
| Final implementer, fixer, tester and reviewer retain specialist work while owning the final result | `test_pipeline_result_owner_keeps_its_specialist_work` |
| New and continued team threads ignore disabled unused leads and reject disabled builders/reviewers before issuing commands | `test_team_message_defaults_to_build_review` |
| Scheduler still rejects disabled selected members without dispatching work | `test_scheduler_dispatches_all_team_members_lead_first`, `test_scheduler_records_team_unavailable_without_claiming` |

## Broader validation

```sh
COVERAGE_FILE=/tmp/relay-team-mode.coverage UV_CACHE_DIR=.uv-cache \
  uv run --project backend --extra dev --with pytest-cov pytest \
  backend/tests/unit/test_team_dispatch.py \
  backend/tests/unit/test_collaboration_service.py \
  backend/tests/unit/test_collaboration_styles.py \
  backend/tests/unit/test_collaboration_work.py \
  backend/tests/unit/test_collaboration_policy.py \
  backend/tests/unit/test_daemon_registry.py \
  backend/tests/api/test_team_routes.py \
  --cov=relay.services.team_dispatch --cov=relay.collaboration.service \
  --cov-report=term-missing -q
```

**488 passed**; combined statement coverage **90%** (`team_dispatch.py`: 96%,
`collaboration/service.py`: 88%). Real local stores and simulated daemon events
are used; no live model execution was performed.

`npm test` was attempted and retried with escalation. The Next.js build still
failed when its Turbopack worker attempted to bind a local port (`EPERM`).
The suites were therefore run separately:

- `npm run test:py`: 1,948 passed, 10 skipped, 3 failed. Two failures were
  scheduler expectations for the old error code. After updating those
  expectations, all **31 scheduler tests passed**. The remaining installer
  terminal test passed when rerun with access to `/dev/tty`.
- Package and web TypeScript compilation both passed.
- Compiled Node suites, rerun with process/network permissions: **1,740 passed,
  5 failed**. Remaining failures are unchanged web source checks for composer
  readout markup, spacing, breakpoints and avatar sizes.
- `npm run test:react -w web`: **330 passed, 4 failed**. Remaining failures are
  unchanged project/task navigation expectations (links versus buttons).
- `git diff --check` passed.

Dependency audits made no changes: npm reported no vulnerabilities; pip-audit
reported the existing AnyIO 4.13.0 advisories CVE-2026-63374 and CVE-2026-64847.
The complete repository verification is not green because of the unrelated
web checks and the production-build environment restriction.
