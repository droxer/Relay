# Handoff continuity regression evidence

Journeys were derived from the agent-handoff review: a receiving agent must
recover partial work, retain earlier handoff instructions, and receive bounded
context; a later run must never inherit an earlier run's completion verdict.

## Changes

- The daemon clears old verdicts before execution and consumes them on normal,
  cancelled, failed, and output-delivery-failure exits. Agent-written verdicts
  must include the current `runId`, supplied in the finishing prompt.
- Legacy node-root workspaces use the existing workspace execution gate, so
  concurrent runs cannot consume each other's control file. Separate thread
  workspaces still execute concurrently.
- Cancellation events optionally carry the partial agent log. The backend
  persists it before clearing output, with buffered-output fallback for older
  daemons.
- Historical handoff notes enter conversation history with their original
  executor and logical-agent target. They remain subject to the history budget.
- The current-turn bridge retains at most 24 result blocks and 16,000 characters,
  including an omission marker; oversized latest results retain attribution
  and their tail.
- Every thread has a stable progress-file path. Agents are instructed to create
  a checklist for substantial work and checkpoint milestones, verification,
  decisions, blockers, and the next action. Simple exchanges need no file.

## Regression evidence

Before the fixes, focused tests reproduced the oversized bridge, missing
historical handoff instruction, lost cancellation log, and stale verdict.
The additional node-root concurrency test reproduced overlapping executions.

After the fixes:

- `PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests/unit/test_bridge.py backend/tests/unit/test_conversation.py backend/tests/unit/test_handoff.py backend/tests/unit/test_daemon_registry.py -q`:
  226 passed, including terminal-log and buffered-log cancellation recovery.
- Focused daemon regression tests: 6 passed, covering stale verdicts, run-ID
  validation, cancellation cleanup, output-delivery-failure cleanup, and task
  and node-root serialization.
- `npm run test:py`: 1,155 passed, 3 PostgreSQL schema-drift tests skipped.
- `npm run test:ts`: production build passed, 1,382 compiled TypeScript tests
  passed, and 15 React tests passed, including the final node-root extension.
- `git diff --check`: passed.

## Limits

Checkpoint contents are agent-maintained; the runtime does not verify that every
checklist item is accurate. Hard process termination cannot send a final log,
but the next run rejects stale verdicts. Conversation and bridge truncation still
require consulting checkpoint files and stored logs for older detail.

Coverage percentages were not measured. No database schema or migration changed.
Changes are left in the working tree for review; no checkpoint commits were made.
