# Handoff redesign, step 1: explicit work scope

The design review identified task links being used as execution ownership.
This step makes scope durable in each new round and limits completion effects
in both directions. Structured receipts and transfer revisions are later steps.

## Contract

- Task admission writes `workScope: {kind: task, taskId}` from the authorized
  task ID; thread admission writes `workScope: {kind: thread}`.
- Recovery inherits the active round's scope. Additional reference links do not
  change the task owner. A fresh message creates thread work.
- Prepared replay restores the persisted request's task ID.
- Unscoped session controllers never update linked tasks. Task completion only
  closes threads executing that task, serialized with local admission.
- Legacy task-linked rounds without scope fail explicitly and require a task
  run to establish ownership. No migration guesses ownership from old links.

## Evidence

RED checkpoint: `fe8269b1`. Ten focused cases failed for implicit task mutation,
missing scope, and the old ambiguity behavior. An additional message/recovery
test failed for missing thread scope. The reverse-direction completion test
failed because completing a task closed an unscoped reference thread.

After implementation, 78 controller, regression API, and team API cases passed.
Both reverse-direction completion cases also passed. Shared replay/SSE coverage
asserts that task scope survives alongside handoff context.

The final task/team API run passed 94 cases. Coverage was measured with:

```sh
uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.collaboration.service --data-file=/tmp/relay-work-scope-coverage -m pytest backend/tests/api/test_team_routes.py backend/tests/api/test_tasks.py -q --tb=short
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-work-scope-coverage -m
```

The collaboration service reports 81% combined statement/branch coverage;
none of the new recovery-scope helper lines are missing. TypeScript compilation
and all four handoff replay/status tests passed after adding scope projection
coverage.

Final verification: `npm run test:py` passed 1,207 backend tests. The earlier
`npm test` run passed the production build, 1,405 TypeScript tests and 19 React
tests; its missing-task failure was corrected and covered by the final backend
run. Dependency audit reports existing Next.js, sharp, and
baseline-browser-mapping advisories; no dependency versions changed.

Tests use persisted session/task events and daemon delivery/result handling,
without executing a live agent. Existing task verdict checks remain intact.
