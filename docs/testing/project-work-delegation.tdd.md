# Project work delegation and handoff

Journeys were derived from the requirement to retain delegation and handoff
for Project Tasks and Automations, within the enabled Project Agent roster.

## Evidence

The initial reproducer run reported **4 failed, 1 passed**: manual/scheduled
Project Tasks lacked delegation candidates; removed-member coverage reached
the same missing-candidate assertion; an outsider handoff was accepted. The
enabled-member handoff already worked. RED checkpoint: `578a4cfd`.

Final validation used the existing Python environment with this checkout on
`PYTHONPATH`, and coverage installed separately under `/tmp`:

```sh
python -m coverage run --data-file=/tmp/relay-project-work.coverage \
  --source=backend/relay -m pytest -o addopts='' \
  backend/tests/api/test_project_work_delegation.py \
  backend/tests/api/test_direct_delegation_api.py \
  backend/tests/api/test_project_execution_policy.py \
  backend/tests/unit/test_layering.py \
  backend/tests/unit/test_module_size.py -q
```

Result: **43 passed**, including 11 Project work regression cases.

| Guarantee | Test | Result |
| --- | --- | --- |
| Manual and scheduled Tasks and Automation occurrences offer enabled members only; delegate results return to the requester | `test_project_work_delegates_and_returns_only_among_members` | PASS, four entry paths |
| Removing or disabling a member before the proposal refuses delegation | `test_member_changed_before_delegate_proposal_is_refused` | PASS, two changes |
| Removing a member between delegation admission and delivery prevents its execution | `test_project_member_removed_between_delegate_admission_and_delivery` | PASS |
| Task and Automation handoffs retain Thread and Task scope, accepting members and refusing outsiders | `test_project_task_handoff_keeps_task_scope_and_member_boundary` | PASS, four cases |
| Existing direct delegation, Project execution policy, layering and module size constraints remain valid | Other four files in the command above | PASS |

Coverage JSON compared with added executable production lines in `git diff
--unified=0`: **27/29 (93.1%)**. The two uncovered lines are defensive returns
for a nonmember requester and a missing Project. This is changed-line coverage,
not whole-backend coverage. Existing Starlette deprecation and SQLite index
reflection warnings remain.

Additional checks: mypy passed for all 503 backend source files; Ruff and
`git diff --check` passed. `npm audit --registry=https://registry.npmjs.org`
found zero vulnerabilities (the configured mirror does not implement audit).
`pip-audit` against dependencies exported from the frozen backend lockfile
found no known vulnerabilities. No dependencies were changed.
