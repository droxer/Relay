from __future__ import annotations

import asyncio
import concurrent.futures
from enum import Enum
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date, datetime, UTC
from typing import Any

from loguru import logger

from ..automations.service import AutomationService
from ..collaboration.assignments import assignment_team_snapshot
from ..collaboration.manifest import compile_assignment_work_graph, create_round_manifest
from ..core.human_waits import WaitKind, new_question_id, wait_record
from ..core.ids import new_database_id
from ..core.models import AgentName
from ..persistence.protocols import TaskDispatchAssignment
from ..core.validation import valid_agent
from ..persistence.task.rows import task_claim_sort_key
from ..persistence.task.rules import compact_task_writes
from .claims import dispatch_claim_active
from ..agents.routing import (
    AgentRoutingError,
    dispatch_failure_code,
    dispatch_reason_code,
    persist_legacy_session_computer_id,
    resolve_agent_assignments,
)
from ..tasks.dispatch_failure import (
    record_dispatch_failure,
    safe_dispatch_error_message,
)
from ..tasks.issue_triage import issue_needs_project
from ..projects.runtime import (
    ProjectDispatchError,
    resolve_project_task_assignments,
)
from ..tasks.rounds import (
    awaits_continuation,
    budget_exhausted_message,
    continuation_budget_exhausted,
    continuation_session_id,
)
from ..tasks.workspace import (
    recorded_task_workspace,
    resolve_task_workspace,
    task_workspace_nodes,
)
from ..teams.dispatch import (
    TEAM_UNAVAILABLE_MESSAGE,
    TeamDispatchError,
    resolve_team_task_assignments,
    task_execution_user_id,
)
from ..tasks.placement import (
    ensure_managed_capacity_for_task,
    materialize_legacy_task_assignment,
    task_goal_text,
)
from ..tasks.dispatch_results import dispatch_result_scope

PERMANENT_DISPATCH_CODES = {
    "agent_disabled",
    "agent_forbidden",
    "agent_not_found",
    "agent_policy_unsupported",
    "executor_mismatch",
}


# A dispatch that outlives this keeps going (abandoning it would lose the
# success bookkeeping that follows), but every interval it is logged so a hung
# daemon backend is visible instead of silently stalling the scheduler.
DISPATCH_WAIT_WARNING_SECONDS = 60.0


def _await_dispatch(future: concurrent.futures.Future[Any], task_id: str) -> Any:
    waited = 0.0
    while True:
        try:
            return future.result(timeout=DISPATCH_WAIT_WARNING_SECONDS)
        except TimeoutError:
            waited += DISPATCH_WAIT_WARNING_SECONDS
            logger.warning(
                "Task dispatch still waiting on the daemon backend",
                task_id=task_id,
                waited_seconds=waited,
            )


class CandidateOutcome(Enum):
    """What one pass over an assigned task did."""

    IGNORED = "ignored"  # not dispatchable yet; not counted
    SKIPPED = "skipped"  # held back for a recorded reason
    ATTEMPTED = "attempted"  # claimed and handed to a daemon, which refused it
    DISPATCHED = "dispatched"


@dataclass(frozen=True)
class _Route:
    """Where a routed task runs and with which assignments."""

    agent: Any
    assignments: list[dict[str, Any]]
    project_snapshot: dict[str, Any] | None
    node: dict[str, Any] | None


@dataclass(frozen=True)
class SchedulerTickResult:
    fired: int = 0
    promoted: int = 0
    dispatched: int = 0
    skipped: int = 0


class TaskScheduler:
    def __init__(
        self,
        *,
        task_store: Any,
        registry: Any,
        backend: Any,
        team_store: Any | None = None,
        project_store: Any | None = None,
        managed_node_store: Any | None = None,
        org_settings_store: Any | None = None,
        automations: AutomationService | None = None,
        interval_seconds: float = 10.0,
        max_dispatches_per_tick: int = 5,
        today: Callable[[], date] = date.today,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.task_store = task_store
        self.registry = registry
        self.backend = backend
        self.team_store = team_store
        self.project_store = project_store
        self.managed_node_store = managed_node_store
        self.org_settings_store = org_settings_store
        self.interval_seconds = interval_seconds
        self.max_dispatches_per_tick = max_dispatches_per_tick
        self._today = today
        self._now = now
        self.automations = automations
        self._loop_task: asyncio.Task[None] | None = None
        self._tick_lock = asyncio.Lock()

    def start(self) -> None:
        if self._loop_task and not self._loop_task.done():
            return
        self._loop_task = asyncio.create_task(
            self._run_loop(), name="relay-task-scheduler"
        )
        logger.info("Task scheduler started", interval_seconds=self.interval_seconds)

    async def stop(self) -> None:
        if not self._loop_task:
            return
        self._loop_task.cancel()
        try:
            await self._loop_task
        except asyncio.CancelledError:
            pass
        self._loop_task = None
        logger.info("Task scheduler stopped")

    async def tick(self) -> SchedulerTickResult:
        async with self._tick_lock:
            # All store transactions stay on one worker thread. Only the
            # asynchronous daemon backend call returns to the application loop.
            work = asyncio.create_task(
                asyncio.to_thread(self._tick_sync, asyncio.get_running_loop())
            )
            try:
                return await asyncio.shield(work)
            except asyncio.CancelledError:
                # Shutdown must not abandon a worker still mutating stores.
                await work
                raise

    def _tick_sync(self, loop: asyncio.AbstractEventLoop) -> SchedulerTickResult:
        with compact_task_writes():
            fired = self.automations.tick(self._now()) if self.automations else 0
            dispatched, skipped = self._dispatch_assigned_tasks(loop)
            return SchedulerTickResult(
                fired=fired,
                promoted=0,
                dispatched=dispatched,
                skipped=skipped,
            )

    async def _run_loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - converted to a recorded dispatch failure or logged tick failure
                logger.exception("Task scheduler tick failed")
            await asyncio.sleep(self.interval_seconds)

    def _dispatch_assigned_tasks(self, loop: asyncio.AbstractEventLoop) -> tuple[int, int]:
        dispatched = skipped = attempts = 0
        for candidate in self._dispatchable_tasks():
            if attempts >= self.max_dispatches_per_tick:
                break
            try:
                outcome = self._dispatch_candidate(loop, candidate)
            except Exception:  # noqa: BLE001 - one malformed task must not starve the queue behind it
                logger.exception("Task dispatch candidate failed", task_id=candidate.get("id"))
                skipped += 1
                continue
            if outcome is CandidateOutcome.SKIPPED:
                skipped += 1
            elif outcome in (CandidateOutcome.ATTEMPTED, CandidateOutcome.DISPATCHED):
                attempts += 1
                dispatched += outcome is CandidateOutcome.DISPATCHED
        return dispatched, skipped

    def _dispatch_candidate(
        self, loop: asyncio.AbstractEventLoop, candidate: dict[str, Any]
    ) -> CandidateOutcome:
        """Route, claim, and dispatch one assigned task."""
        held = self._held_back(candidate)
        if held is not None:
            return held
        task = self._materialize_legacy_assignment(candidate) or candidate
        unroutable = self._unroutable(task)
        if unroutable is not None:
            return unroutable
        # A project task's team runs inside the project room, so the thread
        # it creates is the project's, never the team's.
        team_id = None if task.get("projectId") else task.get("assignedTeamId")
        # A continuation resumes its own thread, so routing has to respect
        # that thread's workspace affinity rather than pick a node afresh.
        resume_session_id = (
            continuation_session_id(task) if awaits_continuation(task) else None
        )
        try:
            route = self._route(task, team_id, resume_session_id)
        except (ProjectDispatchError, TeamDispatchError, AgentRoutingError) as error:
            if self._record_routing_failure(task, error):
                return CandidateOutcome.SKIPPED
            route = None
        if route is None or route.node is None:
            self._ensure_managed_capacity(task)
            return CandidateOutcome.SKIPPED
        claimed = self.task_store.claim_task_for_dispatch(
            task["id"],
            route.agent,
            expected_assignment=TaskDispatchAssignment.capture(task),
        )
        if not claimed:
            return CandidateOutcome.SKIPPED
        dispatched = self._dispatch_claimed_task(
            loop,
            claimed,
            route.agent,
            route.node["id"],
            route.assignments,
            team_id=team_id,
            project_snapshot=route.project_snapshot,
            session_id=resume_session_id,
        )
        return CandidateOutcome.DISPATCHED if dispatched else CandidateOutcome.ATTEMPTED

    def _held_back(self, candidate: dict[str, Any]) -> CandidateOutcome | None:
        """Why an assigned task must not be routed this tick, if it must not."""
        # Legacy projectless work that was already Ready waits for triage.
        if issue_needs_project(candidate):
            return CandidateOutcome.IGNORED
        # Admitted work stays assigned until the daemon starts executing.
        # Do not re-route it, block it, or enqueue another execution.
        if dispatch_claim_active(candidate) or (
            self.registry.daemon_store.active_run_request_for_task(candidate["id"])
        ):
            return CandidateOutcome.SKIPPED
        outcome = candidate.get("dispatchOutcome") or {}
        retry = candidate.get("dispatchRetry") or {}
        if retry or (
            outcome.get("state") == "queued"
            and outcome.get("code") in ("task_wip_limit", "dispatch_failed")
        ):
            self._fail_legacy_retry(candidate, outcome, retry)
            return CandidateOutcome.SKIPPED
        return None

    def _fail_legacy_retry(
        self, candidate: dict[str, Any], outcome: dict[str, Any], retry: dict[str, Any]
    ) -> None:
        # Older versions left failed dispatches in the queue. Do not revive
        # them when their deadline or claim lease expires.
        with self.task_store.task_write_scope(candidate["id"]) as current:
            if (
                current.get("status") == "assigned"
                and not dispatch_claim_active(current)
                and current.get("executionOwner") == candidate.get("executionOwner")
                and current.get("dispatchOutcome") == candidate.get("dispatchOutcome")
                and current.get("dispatchRetry") == candidate.get("dispatchRetry")
            ):
                record_dispatch_failure(
                    self.task_store, current,
                    code=outcome.get("code") or retry.get("code") or "dispatch_failed",
                    message=outcome.get("message") or retry.get("message") or "Previous dispatch failed.",
                )

    def _unroutable(self, task: dict[str, Any]) -> CandidateOutcome | None:
        """Why a task names nothing the scheduler can route, if it does not."""
        if (
            valid_agent(task.get("assignedAgent"))
            and not task.get("assignedAgentId")
            and not task.get("assignedTeamId")
        ):
            self._record_dispatch_deferred(
                task,
                "agent_not_found",
                "Select a named agent before this task can be dispatched.",
            )
            return CandidateOutcome.SKIPPED
        if not (
            (valid_agent(task.get("assignedAgent")) and task.get("assignedAgentId"))
            or task.get("assignedTeamId")
            or task.get("projectId")
        ):
            return CandidateOutcome.IGNORED
        if self._continuation_refused(task):
            return CandidateOutcome.SKIPPED
        return None

    def _route(
        self, task: dict[str, Any], team_id: str | None, resume_session_id: str | None
    ) -> _Route:
        """Resolve the task's assignments and the node they run on."""
        resume_session = (
            self._session_for_continuation(resume_session_id) if resume_session_id else None
        )
        daemon_nodes = task_workspace_nodes(
            task, self.registry.monitor_nodes(), self.registry.store
        )
        if resume_session:
            resume_session = persist_legacy_session_computer_id(
                resume_session,
                session_store=self.registry.store,
                placement_store=self.backend.agent_placement_store,
                nodes={node["id"]: node for node in daemon_nodes},
                daemon_store=self.registry.daemon_store,
            )
        project_snapshot: dict[str, Any] | None = None
        agent = valid_agent(task.get("assignedAgent"))
        if task.get("projectId"):
            if self.project_store is None:
                raise ProjectDispatchError("project_store_unavailable")
            assignments, project_snapshot = resolve_project_task_assignments(
                task,
                project_store=self.project_store,
                agent_store=self.backend.agent_store,
                placement_store=self.backend.agent_placement_store,
                daemon_nodes=daemon_nodes,
                session_store=self.registry.store,
                team_store=self.team_store,
            )
            agent = assignments[0]["agent"]
        elif team_id:
            assignments = resolve_team_task_assignments(
                task,
                team_store=self.team_store,
                agent_store=self.backend.agent_store,
                placement_store=self.backend.agent_placement_store,
                daemon_nodes=daemon_nodes,
                session_store=self.registry.store,
            )
            agent = assignments[0]["agent"]
        else:
            assignments = resolve_agent_assignments(
                [{"agent": agent, "agentId": task["assignedAgentId"]}],
                user_id=task_execution_user_id(task),
                is_admin=False,
                agent_store=self.backend.agent_store,
                placement_store=self.backend.agent_placement_store,
                daemon_nodes=daemon_nodes,
                session=resume_session,
                daemon_store=self.registry.daemon_store,
                session_store=self.registry.store,
            )
        assignments = compile_assignment_work_graph(
            [
                {**assignment, "assignmentId": assignment.get("assignmentId") or new_database_id()}
                for assignment in assignments
            ],
            purpose="accomplish",
            team_snapshot=assignment_team_snapshot(assignments),
        )
        return _Route(
            agent=agent,
            assignments=assignments,
            project_snapshot=project_snapshot,
            node=self.registry.get(assignments[0]["daemonNodeId"]),
        )

    def _record_routing_failure(
        self, task: dict[str, Any], error: ProjectDispatchError | TeamDispatchError | AgentRoutingError
    ) -> bool:
        """Record why routing failed. True when the task is held back; False
        when it may still wait for managed capacity."""
        if isinstance(error, ProjectDispatchError):
            message = f"The project cannot execute this task ({error.code})."
            self._record_dispatch_deferred(
                task, error.code, message, state="rejected" if error.permanent else "queued"
            )
            if error.permanent:
                self._block(task, message, error.code)
            return True
        if isinstance(error, TeamDispatchError):
            message = (
                f"The assigned team cannot execute this task ({error.code})."
                if error.permanent
                else TEAM_UNAVAILABLE_MESSAGE
            )
            self._record_dispatch_deferred(
                task, error.code, message, state="rejected" if error.permanent else "queued"
            )
            if error.permanent:
                self._block(task, message, error.code)
            return True
        permanent = error.code in PERMANENT_DISPATCH_CODES
        self._record_dispatch_deferred(
            task, dispatch_reason_code(error.code), str(error),
            state="rejected" if permanent else "queued",
        )
        if permanent:
            self._block(task, str(error), dispatch_reason_code(error.code))
        return permanent

    def _block(self, task: dict[str, Any], message: str, code: str) -> None:
        self.task_store.update_task(
            task["id"],
            {
                "status": "blocked",
                "blockerReason": message,
                "attention": {"code": code, "source": "dispatch"},
            },
        )

    def _session_for_continuation(self, session_id: str) -> dict[str, Any] | None:
        store = getattr(self.backend, "registry", None)
        store = getattr(store, "store", None)
        if store is None:
            return None
        try:
            return store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            return None

    def _continuation_refused(self, task: dict[str, Any]) -> bool:
        """Stop a task that keeps asking for another round. True if refused.

        This is the only bound on automatic continuation: an agent that always
        reports "continue" would otherwise re-dispatch itself indefinitely. A
        refused task waits for a person rather than failing — the work so far
        is intact, and continuing it is a judgement call.
        """
        if not awaits_continuation(task):
            return False
        if not continuation_session_id(task):
            # Nothing to resume into: a fresh thread would start without the
            # work already done, so a human has to decide what happens next.
            self._park_for_human(
                task,
                "round_continuation_unavailable",
                "The round asked to continue, but its thread is no longer known.",
            )
            return True
        if continuation_budget_exhausted(task, self.org_settings_store):
            self._park_for_human(
                task,
                "round_budget_exhausted",
                budget_exhausted_message(task, self.org_settings_store),
            )
            return True
        return False

    def _park_for_human(self, task: dict[str, Any], code: str, message: str) -> None:
        # Read before the round record clears it: the thread the work was in
        # is where a person answers, and the message is what they answer.
        session_id = continuation_session_id(task)
        self.task_store.record_round(task["id"], clear_continuation=True)
        # A spent budget is its own kind of wait, so a surface can offer to
        # continue rather than quote it as an agent's question.
        kind: WaitKind = "budget" if code == "round_budget_exhausted" else "check"
        self.task_store.update_task(task["id"], {
            "status": "waiting_for_human",
            "statusReason": message,
            "statusRequest": wait_record(kind, new_question_id()),
            **({"statusSessionId": session_id} if session_id else {}),
        })
        self._record_dispatch_deferred(task, code, message, state="rejected")
        self.task_store.record_activity(task["id"], message)
        logger.info("Task continuation refused", task_id=task["id"], code=code)

    def _materialize_legacy_assignment(
        self, task: dict[str, Any]
    ) -> dict[str, Any] | None:
        return materialize_legacy_task_assignment(
            task,
            task_store=self.task_store,
            registry=self.registry,
            agent_store=self.backend.agent_store,
            placement_store=self.backend.agent_placement_store,
        )

    def _record_dispatch_deferred(
        self,
        task: dict[str, Any],
        code: str,
        message: str,
        *,
        state: str = "queued",
    ) -> None:
        current = task.get("dispatchOutcome") or {}
        if current.get("state") == state and current.get("code") == code:
            return
        self.task_store.record_dispatch_outcome(
            task["id"], state, code=code, message=message
        )

    def _ensure_managed_capacity(self, task: dict[str, Any]) -> None:
        capacity = ensure_managed_capacity_for_task(
            task, self.registry, self.managed_node_store
        )
        if capacity and capacity.provisioning_requested:
            logger.info(
                "Managed node provisioning requested for queued task",
                task_id=task["id"],
                user_id=(
                    task.get("assigneeUserId") or task.get("ownerUserId")
                ),
            )

    def _dispatch_claimed_task(
        self,
        loop: asyncio.AbstractEventLoop,
        task: dict[str, Any],
        agent: AgentName,
        node_id: str,
        assignments: list[dict[str, Any]],
        *,
        team_id: str | None = None,
        project_snapshot: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> bool:
        claim = task.get("dispatchClaim") or {}

        claim_id = claim.get("id")
        try:
            collaboration = {
                "manifest": create_round_manifest(
                    source="task",
                    purpose="accomplish",
                    address=(
                        {"kind": "room"}
                        if team_id
                        else {
                            "kind": "members",
                            "agentIds": [
                                assignment["agentId"]
                                for assignment in assignments
                                if assignment.get("agentId")
                            ],
                        }
                    ),
                    assignments=assignments,
                    team_snapshot=assignment_team_snapshot(assignments),
                    project_snapshot=project_snapshot,
                )
            }
            layout, subpath = resolve_task_workspace(
                task,
                node=self.registry.get(node_id),
                project_snapshot=project_snapshot,
                session_store=self.registry.store,
            )
            binding = recorded_task_workspace(
                task, self.registry.store, self.registry.monitor_nodes()
            )
            if binding and layout in ("thread", "node-root"):
                session_id = binding["sessionId"]
            workspace_fields: dict[str, Any] = {"workspaceLayout": layout}
            if subpath:
                workspace_fields["workspaceSubpath"] = subpath
            if project_snapshot:
                workspace_fields["projectId"] = project_snapshot["projectId"]
            session = _await_dispatch(asyncio.run_coroutine_threadsafe(
                self.backend.run(
                    node_id,
                    {
                        "taskGoal": task_goal_text(task),
                        "assignments": assignments,
                        "taskId": task["id"],
                        "actorIsAdmin": True,
                        "agentFirst": True,
                        **({"teamId": team_id} if team_id else {}),
                        **workspace_fields,
                        "collaboration": collaboration,
                        **({"sessionId": session_id} if session_id else {}),
                        **({"idempotencyKey": claim_id} if claim_id else {}),
                    },
                ),
                loop,
            ), task["id"])
        except Exception as error:  # noqa: BLE001 - converted to a recorded dispatch failure
            with dispatch_result_scope(
                self.task_store, task, claim_id, success=False
            ) as current:
                if current is None:
                    return False
                task = current
                code = dispatch_failure_code(error)
                if claim_id and code != "dispatch_failed":
                    self.task_store.release_dispatch_claim(task["id"], claim_id)
                record_dispatch_failure(
                    self.task_store, task, code=code,
                    message=safe_dispatch_error_message(error),
                )
                logger.warning(
                    "Scheduled task dispatch failed",
                    task_id=task["id"],
                    agent=agent,
                    error=str(error),
                )
                return False
        with dispatch_result_scope(self.task_store, task, claim_id, success=True) as current:
            if current is None:
                return True
            task = current
            self.task_store.clear_dispatch_retry(task["id"])
            if claim_id:
                self.task_store.release_dispatch_claim(task["id"], claim_id)
            self.task_store.record_dispatch_outcome(task["id"], "started")
            self.task_store.record_activity(
                task["id"],
                f"Scheduled dispatch to {agent}; waiting for agent execution.",
                {"agent": agent, "sessionId": session["id"]},
            )
            logger.info(
                "Scheduled task dispatched",
                task_id=task["id"],
                session_id=session["id"],
                agent=agent,
                node_id=node_id,
            )
            return True

    def _dispatchable_tasks(self) -> Iterator[dict[str, Any]]:
        if hasattr(self.task_store, "list_dispatchable_tasks"):
            after = None
            page_size = max(25, min(200, self.max_dispatches_per_tick))
            while True:
                page = self.task_store.list_dispatchable_tasks(
                    limit=page_size, after=after
                )
                if not page:
                    return
                # Capture cursor before routing mutates any task in this page.
                after = dict(page[-1])
                yield from page
                if len(page) < page_size:
                    return
        else:
            tasks = [
                task
                for task in self.task_store.list_tasks()
                if task.get("status") == "assigned"
                and not task.get("isRoutine")
                and (
                    task.get("assignedAgent")
                    or task.get("assignedTeamId")
                    or task.get("projectId")
                )
            ]
            yield from sorted(tasks, key=task_claim_sort_key)
