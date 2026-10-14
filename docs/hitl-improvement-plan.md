# Human-in-the-loop: review fixes and improvement plan

Status: phase 0 implemented (2026-10-14). Phases 1–4 are proposals.

## Where the design stands

A Relay agent asks its human by ending its round: it writes
`.relay/round-result.json` (`status: "blocked"`, `note`, 2–6 `options`), the
daemon consumes and bounds the file, and the backend closes the thread
`completed` / `workOutcome: "blocked"` while parking the task at
`waiting_for_human` with `waitingSessionId` and a structured `waitingRequest`.
A reply in that thread resumes the task as its next round, and
`conversation.py` replays the question to the answering run.

This park-and-resume shape is right for Relay. Its runs are long, they live on
remote computers, and a person may answer hours later. Claude Code's design
blocks the running turn on a tool call, which suits an operator at a terminal
and not a work queue. What Relay should take from Claude Code is the set of
guarantees around a question, not its blocking shape:

| Claude Code guarantee | Relay before this work | Relay after phase 0 |
|---|---|---|
| The answer is the result of the question's own call | Matched by thread + task status, re-derived on the web | Unchanged; phase 1 |
| A malformed question fails loudly and the model retries | Every bad verdict file degraded to a generic wait | Rejections are logged and named on the task |
| Only the human approves | Already held: the token that acts as an employee is minted in their browser; agents hold only the node token | Unchanged (verified) |
| A denial is feedback to the same work | Reject wiped the question; a review task was stranded | Question kept; a reject that would strand a task is refused |
| Decisions are auditable | Decisions recorded no actor | Every decision records `actorEmployeeId` |
| Gates come before an action, enforced outside the model | Not built (ADR-007 approval, `toolPolicy`) | Unchanged; phase 3 |

## Phase 0 — review fixes (done)

Backend:

- **Who decided.** `approve`, `reject`, `cancel`, `mark_done`, `rerun` and
  `handoff` decisions, and the cancel route, record `actorEmployeeId`
  (`_decided_by` in `sessions/controller.py`). Delivered Stop requests keep
  their initiating employee in durable run-request state until exit is
  acknowledged, including after a backend restart and when an admin stops
  another employee's run. Repeated Stop requests preserve the first actor.
- **Who may decide (verified, unchanged).** `POST /threads/{id}/decisions`
  accepts a login session or a node's UI token. The UI token is minted in the
  employee's browser and stored only as a hash. The daemon, and every agent
  it runs, holds only the node token, which never authenticates as a person.
  So an agent cannot answer or approve its own wait. The review finding that
  it could was a false positive.
- **Reject.** It is refused with 409 while a run is in flight
  (`session_run_in_flight`), and while the round's task awaits review
  (`task_review_pending`). The task's own review is where changes are
  requested. A reject keeps the question the thread waits on, instead of
  erasing it (`_apply_session_status`). Validation and the decision append
  share the admission locks and session row lock, so a concurrent run cannot
  slip between them.
- **Mark done is the human's acceptance.** `complete_session(...,
  accepted_by_human=True)` closes a human-acceptance task as `done` rather
  than sending it to `review`.
- **Repair is reachable.** When finalization is retried on an already
  completed thread, `_complete_run_request` now calls
  `SessionController.repair_completion`. That parks a task whose write was
  lost, and never overwrites a newer completion.
- **A question survives a bad exit.** A blocked verdict that carries a
  question routes the run as a finished turn, even when the CLI then exits
  non-zero. The run's own record keeps the real exit code. The handled question
  does not emit an intermediate task execution failure that could fire a
  task-status automation.
- **A lone option is not lost.** A blocked verdict with no note and one option
  becomes the question `Proposed answer: …`.
- **Rejected verdict files are named.** The daemon reports
  `roundResultRejected: {reason}`. The task's activity then says why, for
  example "its runId did not match this run", instead of "did not write" the
  file.
- **Human recoveries open a fresh budget.** A rerun or handoff (`source:
  "recovery"`, a person-only route) resets the continuation budget, the same
  way an answer does.
- **Replayed questions are quoted.** Each line is replayed as `> …`, so a
  question containing `[User]` cannot forge a human turn.
- **One preamble, pinned limits.** `BLOCKED_ROUND_PREAMBLE` lives in
  `collaboration/policy.py`. `tests/unit/test_round_result_parity.py` pins the
  daemon, backend and web limits, the preamble, and the rejection codes
  together.

Daemon and core:

- **Readable rejections.** `readRoundResult` names why a present file was
  rejected (`oversize`, `malformed`, `not_object`, `invalid_status`,
  `run_id_mismatch`). It logs the reason without the file's contents and
  reports the reason on `run.completed`.
- **Clearer prompt.** The `[Finishing]` prompt now spells out that the
  question goes in `note`, that options must be 2–6 or omitted, and that
  `runId` must be copied exactly.

Web:

- **One waiting rule.** "Needs you" grouping, the thread prompt, and the task
  panel share one rule (`threadWait` / `threadAwaitsHuman` /
  `taskWaitingThreadId` in `web/src/lib/awaitingInput.ts`).
- **Right thread link.** The task panel links a waiting task to the thread it
  waits in.
- **Unknown tasks don't hide questions.** A task missing from the client's
  list (not loaded, or not the viewer's) no longer hides the question; the
  thread's own record stands.
- **Safer number keys.** Keys 1–6 act only when focus is on the page body or
  the prompt itself, and never with a modifier held.
- **Option picks are plain text.** A failed pick restores the composer
  exactly. Picks bypass @mention parsing.
- **Announced prompt.** The prompt is announced once through a polite live
  region.

## Phase 1 — a question has an id (highest value)

The remaining fragility comes from one fact: an answer is matched to its
question by thread plus task status, and the web re-derives that rule.

1. **Question id.** Mint a `questionId` when `_complete_run_request` parks a
   task. Store it on `session.completed`, in `waitingRequest`, and on the
   `task.status` event.
2. **Structured answer.** Add `POST /threads/{id}/answers` with
   `{questionId, option?: number, text?: string, idempotencyKey}`. The
   conductor resumes the task only when `questionId` matches the task's
   current wait. Otherwise it answers 409 `question_superseded`. This closes
   the two-quick-replies race and the "status question resumed the task"
   ambiguity (today `purpose` decides, and the client chooses the purpose).
3. **One backend projection.** Expose `awaiting` on the thread and the task:
   `{questionId, kind, text, options, notes, taskId, sessionId}`, computed
   once by the backend's `_awaiting_task` rule. The web then renders it and
   drops `waitingTask`, the preamble parsing, and the gate-text rewriting from
   `awaitingInput.ts`. A legacy record without an id keeps today's rule
   behind the projection, so only one place knows it.
4. **Retire the legacy preamble.** Once every waiting task carries
   `waitingRequest`, the outcome-string fallback in `conversation.py` and the
   web can go.

## Phase 2 — one meaning for "waiting on a human"

- The scheduler's budget-exhausted park (`_park_for_human`) leaves a task
  waiting with no structured question while its thread reads `unfinished`.
  Give it a `waitingRequest` (`kind: "budget"`, with options "Continue" and
  "Stop here") so every wait is a question with a thread.
- Thread reject is reachable in the web only after an earlier reject: the
  decision bar mounts only on a pending feedback decision. Either remove it,
  or rebuild it as "request changes" bound to the task's review. A changes
  request on a review task would move it back to `waiting_for_human` in that
  thread, with the reason as the question.
- Keep `done → review` in one helper. It is currently written in
  `_complete_run_request`, `_update_task_status`, and the repair expectation.

## Phase 3 — gates before actions (ADR-007)

This is Claude Code's permission model, enforced where Relay already keeps
authority outside the sandbox (ADR-009): the daemon.

- **Policy.** Per agent or project, a `toolPolicy` of allow/deny/ask rules,
  scoped to actions (`shell:git push*`, `mcp:<server>/<tool>`, `net:<host>`).
  Deny wins. Org settings can impose rules that agents and projects cannot
  loosen.
- **Ask becomes an approval wait.** The runtime's permission hook (Claude
  Code's `PreToolUse`/`--permission-prompt-tool`, and its equivalent for each
  runtime) calls the daemon. The daemon parks the run with an
  `approval.requested` event carrying the exact action. A person approves or
  denies in the thread, with an optional reason. A denial returns to the same
  run as feedback.
- **Modes.** `ask` (default), `accept-edits`, and `plan-first`. Plan-first
  makes the first round read-only and turns its output into an approval.
- **Fail closed.** With no live human channel, for example in an automation,
  an `ask` rule denies and records why.
- The agent-model capability pattern applies: a daemon without the
  `tool-policy` capability fails a run that carries a policy, rather than
  silently ignoring it. `toolPolicy` stays rejected on write until this
  ships.

## Phase 4 — operations

- Metrics: time-to-answer, waits per task, and rejected verdicts by reason
  and runtime. Rejected verdicts point at prompt or runtime regressions.
- Notifications: a wait notifies its task owner through their configured
  channel, with the question and options inline. An answer from a channel
  goes through the same answer endpoint and `questionId`.

## Known limits of phase 0

- A dashboard workspace brief (`WorkspacePrimitives.tsx`) still opens a task's
  first link, because the brief does not carry `waitingSessionId`. Phase 1's
  projection fixes it.
- `isAwaitingHuman` in `web/src/lib/workflow.ts` is no longer used by the web.
  The backend's `session_awaits_human` still counts a reject or blocked thread
  for the workspace metrics, without consulting the task.
