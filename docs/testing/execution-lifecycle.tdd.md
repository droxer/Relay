# Execution lifecycle and zombie prevention

The implementation follows the execution-lifecycle design discussed with the
user: durable stop-and-delete intent, shared status, periodic recovery, terminal
result replay, and lease expiry protection. Existing command lease IDs and task
execution generations remain the ownership fences.

## Behavior and ownership

- `services/execution_lifecycle.py` derives execution status and runs independent
  recovery every five seconds, including immediately at startup. Database outages
  are retried. Deletion batches rotate so unreachable computers cannot starve
  other pending deletions.
- `daemon_registry/registry.py` recovers bounded batches, isolates failures per
  request, and retries finalization with exponential backoff. Five failed attempts
  expose `recovery_required`; the terminal event and execution reservation remain.
- `session.deletion_requested` is authoritative, replayable deletion intent.
  Admission rejects it. Database admission and final deletion synchronize on the
  session row; file-backed admission and deletion share an interprocess lock.
- Daemon terminal results are fsynced to private `terminal-events/` files before
  sending, including an already-aborted delivery signal. Replay runs independently
  of heartbeat delivery. Only acknowledgement removes a pending record. HTTP
  rejection retains evidence. No credentials are stored in the event files.
- The daemon's lease watchdog runs independently of network retry loops. It aborts
  expired executions through the existing process-group termination / BoxLite kill
  paths. It does not release backend ownership before exit acknowledgement.
- Thread controls, lists, and linked backlog records display backend execution
  state. Stop and delete keeps the thread visible while cleanup is pending. SSE
  start events invalidate an older terminal status snapshot.

## Boundaries and rollout

No schema migration or new dependency is required. Deletion and retry metadata
live in existing event/snapshot and request-state fields. Deploy the backend
before the daemon and web updates. Drain pending deletions before rolling back to
an older backend that does not understand deletion intent. Old daemon terminal
messages retain their existing compatibility behavior; new daemons send lease IDs.

A daemon crash or unreachable computer does not prove that its processes stopped.
Such executions retain ownership and appear unresponsive; this change deliberately
does not redeliver them or force-delete their threads. The watchdog is in the daemon
process, so it cannot kill a surviving process after the daemon itself has crashed.
Restoring the daemon/evidence or operator recovery of the execution host is still
needed in that case. No external-side-effect exactly-once guarantee is claimed.

The reaper processes at most 100 requests per pass, but the current stores still
load the active-request list to rotate that batch. This is not a claim of bounded
database scan cost. PostgreSQL concurrency relies on existing row locks and
conditional claims; a live multi-replica deployment was not exercised locally.

## Evidence

RED: `uv run --project backend --extra dev pytest backend/tests/api/test_session_delete.py -q`
returned **2 failed, 6 passed**: stop-and-delete returned 409 instead of 202 and
execution status returned 404. Checkpoint: `55374842`.

Focused GREEN: 260 backend tests passed (lifecycle, deletion, and daemon registry),
including both local and database daemon stores, rejected admission during
pending deletion, recovered terminal acknowledgement, and bounded finalization.

Further RED/GREEN: adding completed sessions with stale running agent records
produced **2 failed, 9 passed** in the deletion suite. Repair from retained terminal
command evidence passed for both store backends. A missing terminal event still
blocks deletion. Stop requests older than 60 seconds without termination evidence
now surface `termination_unconfirmed`, retaining their reservations.

| Verification | Result |
| --- | --- |
| Full Python suite (`npm run test:py`, final rerun) | 1,521 passed, 5 skipped |
| Backend after terminal-evidence repair (deletion, lifecycle, daemon API, registry) | 341 passed |
| Final backend regression run including stop deadline | 263 passed |
| Full built Node suites (final rerun) | 1,509 passed |
| React interaction suite | 68 passed |
| Final focused Node tests including SSE invalidation | 54 passed |
| Package TypeScript and web `tsc --noEmit` | Passed |
| New lifecycle service coverage | 86% (23 focused tests passed) |
| `git diff --check` | Passed |
| `npm audit --registry=https://registry.npmjs.org` | No known vulnerabilities |
| `pip-audit` | No known vulnerabilities; local Relay package is not published on PyPI |

The final full Python and Node runs include the terminal-evidence, stop-deadline,
and SSE regressions. Node process/signal tests passed with sandbox permission to
spawn their fixtures. The final React rerun passed all 68 interaction tests.

`npm run build` passed on the verification retry, including TypeScript and static
page generation. A subsequent `npm test` attempt, including an escalated retry,
hit an intermittent Google Fonts download failure (Noto Sans SC). The constituent
Python, Node, React, and typecheck suites above were run separately. No font assets
or build configuration were changed to conceal this external dependency.
PostgreSQL-only tests are among the skipped tests; the database
admission/deletion regression ran against SQLite.
