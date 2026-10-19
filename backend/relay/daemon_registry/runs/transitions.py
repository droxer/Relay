"""Applying collaboration policy after a turn: work transitions, lead plans, context suggestions, project setup results, and repairs.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from loguru import logger
from ...collaboration.models import (
    COLLABORATION_MANIFEST_STATE_KEY,
)
from ...collaboration.work import (
    WORK_PLAN_ERROR,
    compile_proposed_plan,
)
from ...collaboration.policy import (
    REPAIR_COUNT_STATE_KEY,
    advance_after_success,
    decide_failure,
    next_work_transition,
)
from ...core.ids import now_iso
from ...projects.context import (
    context_suggestions_from_run,
    merge_context_suggestions,
)
from ...collaboration.manifest import compile_assignment_work_graph, create_round_manifest
from ...projects.setup_result import completed_setup
from .run_cursor import advanced_run_cursor
from .. import config
from ..records import (
    TERMINAL_CLAIM_ID_STATE_KEY,
    is_human_started_round,
)
from ..state import RegistryState


class RunTransitionMixin(RegistryState):
    def _owes_round_result(self, run_request: dict[str, Any]) -> bool:
        """Whether the turn that just finished had to file the round's verdict."""
        return self._round_result_was_required(run_request) and self._assignment_reports_round_result(
            run_request["assignments"], run_request.get("currentIndex", 0)
        )

    def _apply_work_transition(
        self,
        run_request: dict[str, Any],
        controller: Any,
        assignment: dict[str, Any],
        work_result: Any,
        next_state: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
        """Apply the work protocol's transition, adopting a lead plan if it carries one."""
        assignments = run_request["assignments"]
        transition = next_work_transition(run_request, assignment, work_result, next_state)
        next_state = transition.state
        if transition.plan is not None:
            assignments, next_state = self._adopt_lead_plan(
                run_request, controller, assignments, transition.plan, next_state
            )
            if WORK_PLAN_ERROR in next_state:
                transition = replace(transition, next_index=None)
        next_index = (
            len(assignments) if transition.next_index is None else transition.next_index
        )
        return assignments, next_index, next_state

    @staticmethod
    def _adopt_lead_plan(
        run_request: dict[str, Any],
        controller: Any,
        assignments: list[dict[str, Any]],
        plan: list[Any],
        next_state: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Compile the coordinator's plan into the round, or record why it was refused."""

        parent = next_state.get(COLLABORATION_MANIFEST_STATE_KEY) or {}
        parent_round_id = parent.get("roundId") or run_request["id"]
        try:
            planned = compile_assignment_work_graph(
                compile_proposed_plan(assignments, plan, parent_round_id),
                purpose="accomplish",
                team_snapshot=parent.get("teamSnapshot"),
            )
        except ValueError as error:
            return assignments, {**next_state, WORK_PLAN_ERROR: str(error)}
        manifest = {
            **create_round_manifest(
                source="lead_plan",
                purpose="accomplish",
                address=parent.get("address") or {"kind": "room"},
                assignments=planned,
                team_snapshot=parent.get("teamSnapshot"),
                project_snapshot=parent.get("projectSnapshot"),
                collaboration_id=parent.get("collaborationId"),
                round_id=f"{parent_round_id}_plan",
            ),
            "parentRoundId": parent.get("roundId"),
            "workScope": parent.get("workScope", {"kind": "thread"}),
            # The plan replaces the manifest; keep who started the round, or a
            # person's round would spend the unattended continuation budget.
            "humanStarted": is_human_started_round(parent),
        }
        controller.record_collaboration_round_started(run_request["sessionId"], manifest)
        return planned, {**next_state, COLLABORATION_MANIFEST_STATE_KEY: manifest}

    def _record_context_suggestions(
        self,
        run_request: dict[str, Any],
        event: dict[str, Any],
        assignment: dict[str, Any],
    ) -> None:
        """Keep the context lines a project run proposed for its owner to review."""
        reported = (event.get("roundResult") or {}).get("contextSuggestions")
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        ) or {}
        project_id = (manifest.get("projectSnapshot") or {}).get("projectId")
        if not reported or not project_id or manifest.get("projectSetup") or not self.project_store:
            return
        incoming = context_suggestions_from_run(
            reported,
            thread_id=run_request["sessionId"],
            run_id=event["runId"],
            agent_id=assignment.get("agentId"),
            created_at=now_iso(),
        )
        if not incoming:
            return
        try:
            self.project_store.add_context_suggestions(
                project_id,
                lambda latest: merge_context_suggestions(
                    latest.get("contextSuggestions"), incoming, latest.get("context") or ""
                ),
            )
        except Exception:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
            # Advice is optional; the run's completion must not depend on it.
            logger.exception(
                "Could not record project context suggestions",
                project_id=project_id,
                run_id=event.get("runId"),
            )

    def _record_project_setup_result(
        self, run_request: dict[str, Any], event: dict[str, Any]
    ) -> None:
        """Fold a finished setup round's proposal into its project.

        Recorded for every terminal outcome so a failed or stopped draft
        never leaves the project waiting on a setup that will not come.
        """
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        ) or {}
        project_id = (manifest.get("projectSnapshot") or {}).get("projectId")
        if not manifest.get("projectSetup") or not project_id or not self.project_store:
            return

        exit_code = (
            event.get("exitCode", 0)
            if event["type"] == "run.completed"
            else event.get("exitCode") or 1
        )

        def change(project: dict[str, Any]) -> dict[str, Any] | None:
            current = project.get("setup") or {}
            draft_id = manifest["projectSetup"].get("draftId")
            if current.get("draftId") != draft_id:
                return None
            if current.get("threadId") not in (None, run_request["sessionId"]):
                return None
            updated = completed_setup(
                current, event.get("projectSetup"), exit_code=exit_code
            )
            return {**updated, "threadId": run_request["sessionId"]} if updated else None

        try:
            self.project_store.mutate_setup(project_id, change)
        except Exception:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
            # The run's own completion must not fail because its project
            # moved on; the setup panel still reads the thread's status.
            logger.exception(
                "Could not record project setup result",
                project_id=project_id,
                run_id=event.get("runId"),
            )

    def _send_back_for_repair(
        self,
        run_request: dict[str, Any],
        terminal_claim_id: str,
        next_state: dict[str, Any],
        outcome: str,
        agent_label: str,
    ) -> bool:
        """Give the lead a turn to fix a teammate's failure. True if it was sent.

        A failed member used to end the whole run, discarding the work every
        earlier member already committed to the shared workspace. The lead owns
        the task, so it gets a bounded chance to repair. Every member then
        revalidates its contribution against the repaired workspace.
        """
        decision = decide_failure(
            run_request,
            next_state,
            outcome=outcome,
            agent_label=agent_label,
            mode=(
                run_request["assignments"][run_request.get("currentIndex", 0)].get(
                    "mode"
                )
                or "action"
            ),
            max_runtime_repairs=config.DAEMON_RUN_MAX_REPAIRS,
        )
        if decision.kind != "repair" or decision.next_index is None:
            return False
        updated = self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            advanced_run_cursor(decision.next_index, decision.state),
        )
        if not updated:
            return False
        logger.info(
            "Sending the lead back to repair a failed teammate",
            request_id=run_request["id"],
            session_id=run_request["sessionId"],
            failed_index=run_request.get("currentIndex", 0),
            repair=decision.state[REPAIR_COUNT_STATE_KEY],
        )
        self._follow_up_run_request(updated)
        return True

    def _next_index_after_success(
        self, run_request: dict[str, Any], next_state: dict[str, Any]
    ) -> tuple[int, dict[str, Any]]:
        """Advance one step, or resume at the member whose failure was repaired."""
        return advance_after_success(run_request, next_state)

    def _continue_after_non_action_failure(
        self,
        run_request: dict[str, Any],
        terminal_claim_id: str,
        next_state: dict[str, Any],
        outcome: str,
        agent_label: str,
        mode: str,
    ) -> bool:
        """Keep collecting discussion/review results after one member fails."""
        decision = decide_failure(
            run_request,
            next_state,
            outcome=outcome,
            agent_label=agent_label,
            mode=mode,
            max_runtime_repairs=config.DAEMON_RUN_MAX_REPAIRS,
        )
        if decision.kind != "continue" or decision.next_index is None:
            return False
        updated = self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            advanced_run_cursor(decision.next_index, decision.state),
        )
        if not updated:
            return False
        self._follow_up_run_request(
            updated, "The round completed with one or more participant failures."
        )
        return True
