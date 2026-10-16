# Human-in-the-loop: review fixes and improvement plan

Status: phases 0 and 1 implemented (2026-10-14, 2026-10-16); phase 2 partly
(budget waits, one acceptance helper). Phases 3–4 are proposals.

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

| Claude Code guarantee | Relay before this work | Relay now |
|---|---|---|
| The answer is the result of the question's own call | Matched by thread + task status, re-derived on the web | An answer names its `questionId`; a stale one is refused (phase 1) |
| A malformed question fails loudly and the model retries | Every bad verdict file degraded to a generic wait | Rejections are logged and named on the task |
| Only the human approves | Already held: the token that acts as a user is minted in their browser; agents hold only the node token | Unchanged (verified) |
| A denial is feedback to the same work | Reject wiped the question; a review task was stranded | Question kept; a reject that would strand a task is refused |
| Decisions are auditable | Decisions recorded no actor | Every decision records `actorUserId` |
| Gates come before an action, enforced outside the model | Not built (ADR-007 approval, `toolPolicy`) | Unchanged; phase 3 |

## Phase 0 — review fixes (done)

Backend:

- **Who decided.** `approve`, `reject`, `cancel`, `mark_done`, `rerun` and
  `handoff` decisions, and the cancel route, record `actorUserId`
  (`_decided_by` in `sessions/controller.py`). Delivered Stop requests keep
  their initiating user in durable run-request state until exit is
  acknowledged, including after a backend restart and when an admin stops
  another user's run. Repeated Stop requests preserve the first actor.
- **Who may decide (verified, unchanged).** `POST /threads/{id}/decisions`
  accepts a login session or a node's UI token. The UI token is minted in the
  user's browser and stored only as a hash. The daemon, and every agent
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

## Phase 1 — a question has an id (done)

The remaining fragility came from one fact: an answer was matched to its
question by thread plus task status, and the web re-derived that rule. The
design as built differs from the proposal in three places, each noted below.

- **Every wait is a record with an id.** `backend/relay/core/human_waits.py`
  owns the shape stored as the task's `waitingRequest`:
  `{questionId, kind, inputQuestion?, inputOptions?, inputNotes?}`, with
  `kind` one of `question` (the agent asked), `check` (a gate stopped the
  round, the verdict was missing, or an unblocked run needs direction) and
  `budget` (continuation rounds ran out). Every `waiting_for_human` park
  writes one, not just agent questions, so there is no id-less wait to fall
  back on.
- **Ids are derived where retries happen.** A run's closeout uses
  `q_<runRequestId>` (`question_id_for_run`), so a retried finalization writes
  the identical wait and the repair path stays a no-op. Scheduler parks and
  unblocks mint one (`ensure_wait_record`). The thread's `session.completed`
  keeps only the question fields; the id lives on the task, which is the
  authority for what is being waited on.
- **Answers ride the message route** (deviation: no separate
  `/threads/{id}/answers`). `POST /threads/{id}/messages` accepts
  `questionId`. With it, the message must be `intent: accomplish` (else 400
  `answer_requires_accomplish`), and the conductor
  (`_assert_current_question`) admits it only while the task waiting in this
  thread still waits on that id — otherwise 409 `question_superseded`. That
  closes the two-tab and quick-round races. One route keeps one admission
  path: idempotency keys, mentions, team addressing and the run-in-flight
  check all apply unchanged. The id is part of the request fingerprint (an
  unset id is omitted, so older fingerprints still match).
- **The projection lives on the task** (deviation: not on the thread). Task
  responses — list, summary, detail, mutation results, and the workspace
  brief — carry `awaiting: {questionId, kind, text, options, notes,
  sessionId, resumable}` from `task_awaiting`
  (`backend/relay/collaboration/awaiting.py`). The web reduces thread events
  client-side but refetches tasks, so a thread-side projection would go stale
  between refetches; the task-side one does not. The legacy reading (outcome
  preamble, pre-rename gate wording, waits without `waitingSessionId`) now
  exists only in that module.
- **The web renders, and names the question it shows.** `awaitingInput.ts`
  finds the task whose `awaiting.sessionId` is this thread and renders it; the
  preamble parsing, gate-text rewriting and `waitingTask` matching are gone.
  Only a thread with no task behind it still reads its own completion fields.
  `ThreadsView` attaches the shown `questionId` to every `accomplish` message
  sent while the prompt is up — a picked option or a typed answer — and a
  `question_superseded` refusal says so and refetches tasks so the prompt
  shows what the task waits on now.
- **Kept:** a message without `questionId` still resumes a task waiting in its
  thread (the chat gateway and older clients send none). The legacy preamble
  fallback in `conversation.py` stays until no waiting task predates
  `waitingRequest`.

## Phase 2 — one meaning for "waiting on a human"

- Done: the scheduler's budget-exhausted park writes a `budget` wait with an
  id and the thread it stopped in, so it reads as a wait everywhere; the
  prompt offers the same next steps as a gate stop ("Keep going" resumes,
  "Status" asks without resuming) under its own title.
- Done: `done → review` is decided in one helper, `acceptance_status`
  (`persistence/task_lifecycle.py`), used by the closeout, the task status
  write, and the completion-repair expectation.
- Done: the workspace brief's "active threads" metric and its task links use
  the task's wait (`session_awaits_human(session, tasks)`, `awaiting.sessionId`).
- Open: thread reject is reachable in the web only after an earlier reject:
  the decision bar mounts only on a pending feedback decision. Either remove
  it, or rebuild it as "request changes" bound to the task's review. A changes
  request on a review task would move it back to `waiting_for_human` in that
  thread, with the reason as a `check` wait.
- Open: a `budget` wait could offer a one-click "grant N more rounds" that
  raises the task's own round limit, instead of relying on the fresh budget a
  human-started round opens.

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
  goes through the same message route with the wait's `questionId`, so a
  late channel reply cannot answer a newer question.
- Metrics by wait `kind`: how often rounds stop on gates or budgets rather
  than questions says whether evidence rules or round limits are tuned right.

## Known limits

- A thread with no task (a plain conversation round that stopped to ask) has
  no wait record and therefore no `questionId`; its prompt still reads the
  thread's own completion fields, and a reply there is matched by the thread
  rule. Giving it one needs a thread-side wait, which phase 3's approval waits
  will want anyway.
- `isAwaitingHuman` in `web/src/lib/workflow.ts` is unused by the web.
- Waits recorded before this change carry no `questionId`; they project with
  `questionId: null` and are answered by the thread rule until they resolve.
