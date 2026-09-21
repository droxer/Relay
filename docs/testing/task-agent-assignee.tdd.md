# Assigned agents on every task

The user requested that each task show its assigned agent as its assignee.
Cards, list rows, routine rows, and task detail facts now use the agent/team
identity rather than the responsible employee. Unassigned work has an explicit
label; missing roster entries use localized unavailable labels. Legacy tasks
with only an executor kind show that kind. Assignee sorting uses the same label.
The tablet breakpoint preserves the assignee column, and mobile labels truncate
within their available width.

## Evidence

- RED: `npm run test:react -w web -- --run interaction-tests/taskAssignee.test.tsx`
  produced 10 failed, 2 passed before implementation. Assigned tasks displayed
  “Unassigned” in the employee identity slot rather than the assigned agent.
  Checkpoint: `4ac5825b`.
- GREEN: same target passed all 12 original cases. Four additional availability
  cases pass too: 16 total.
- Full React suite: 36 files, 216 tests passed before the four additional cases.
- Component coverage: 100% statements/functions/lines, 92.85% branches, using
  `npm run test:react -w web -- --run interaction-tests/taskAssignee.test.tsx --coverage --coverage.include=src/components/TaskAssignee.tsx`.
- `npm test`: production build and TypeScript compilation passed; Node tests
  reported 1,701 passed and the previously observed Kimi live-inventory failure.
- `npm audit`: configured npmmirror registry does not provide the advisory endpoint.
- `git diff --check` passed. The existing `web/next-env.d.ts` modification was
  restored after Next.js regenerated it during the build.

No API, persistence, assignment ownership, or dispatch behavior changed.
