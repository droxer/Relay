"""A collaboration round's plan and the agent runs that carry it out."""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..persistence.events import relay_event
from .agent_state import merge_agent_state
from .controller_state import SessionControllerState


class SessionAgentRunMixin(SessionControllerState):
    def record_collaboration_round_started(
        self, session_id: str, manifest: dict[str, Any]
    ) -> dict[str, Any]:
        """Persist the immutable collaboration plan before daemon delivery."""
        round_id = manifest.get("roundId")
        current = self.store.get_session(session_id)
        if round_id and any(
            event.get("type") == "collaboration.round.started"
            and (event.get("manifest") or {}).get("roundId") == round_id
            for event in current.get("events", [])
        ):
            return current
        scope = manifest.get("workScope") or {}
        if (
            self.task_execution_owner is not None
            and scope.get("kind") == "task"
            and scope.get("taskId") == self.task_id
        ):
            # Retain the claim with the round even after daemon request pruning.
            manifest = {**manifest, "taskExecutionOwner": dict(self.task_execution_owner)}
        return self._append(
            session_id,
            relay_event(
                "collaboration.round.started",
                session_id,
                {"manifest": manifest},
            ),
        )

    def record_agent_started(
        self, session_id: str, step: dict[str, Any]
    ) -> dict[str, Any]:
        self.active_session_id = session_id
        self._link_task_session(session_id)
        role = step.get("role")
        logger.info(
            "Agent run started",
            session_id=session_id,
            run_id=step["runId"],
            agent=step["agent"],
            role=role,
        )
        session = self._append(
            session_id,
            relay_event(
                "agent.started",
                session_id,
                {
                    "runId": step["runId"],
                    **({"consultation": True} if step.get("consultation") else {}),
                    **(
                        {"assignmentId": step["assignmentId"]}
                        if step.get("assignmentId")
                        else {}
                    ),
                    **(
                        {"workItemId": step["workItemId"]}
                        if step.get("workItemId")
                        else {}
                    ),
                    "agent": step["agent"],
                    **({"role": role} if role else {}),
                    **(
                        {"teamPhase": step["teamPhase"]}
                        if step.get("teamPhase")
                        else {}
                    ),
                    **(
                        {"logicalAgentId": step["logicalAgentId"]}
                        if step.get("logicalAgentId")
                        else {}
                    ),
                    **(
                        {"placementId": step["placementId"]}
                        if step.get("placementId")
                        else {}
                    ),
                    **(
                        {"daemonNodeId": step["daemonNodeId"]}
                        if step.get("daemonNodeId")
                        else {}
                    ),
                    **(
                        {"managedNodeId": step["managedNodeId"]}
                        if step.get("managedNodeId")
                        else {}
                    ),
                    **(
                        {"agentVersion": step["agentVersion"]}
                        if step.get("agentVersion") is not None
                        else {}
                    ),
                    **(
                        {"workspaceIdentity": step["workspaceIdentity"]}
                        if step.get("workspaceIdentity")
                        else {}
                    ),
                    **({"brief": step["brief"]} if step.get("brief") else {}),
                    **(
                        {"delegationAuthority": step["delegationAuthority"]}
                        if step.get("delegationAuthority")
                        else {}
                    ),
                    **(
                        {"dependsOnWorkItemIds": step["dependsOnWorkItemIds"]}
                        if "dependsOnWorkItemIds" in step
                        else {}
                    ),
                    **({"workKind": step["workKind"]} if step.get("workKind") else {}),
                    **(
                        {"coordinator": True} if step.get("coordinator") is True else {}
                    ),
                    **(
                        {"synthesizer": True} if step.get("synthesizer") is True else {}
                    ),
                    **(
                        {"teamSnapshot": step["teamSnapshot"]}
                        if isinstance(step.get("teamSnapshot"), dict)
                        else {}
                    ),
                },
            ),
        )
        self._update_task_status(
            "running",
            f"{step['agent']} started.",
            {
                "agent": step["agent"],
                "sessionId": session_id,
            },
        )
        return session

    def record_agent_output(
        self, session_id: str, run_id: str, agent: str, stream: str, text: str
    ) -> None:
        self._append(
            session_id,
            relay_event(
                "agent.output",
                session_id,
                {
                    "runId": run_id,
                    "agent": agent,
                    "stream": stream,
                    "text": text,
                },
            ),
        )

    def record_agent_completed(
        self, session_id: str, state: dict[str, Any], step_result: dict[str, Any],
        *, fail_task: bool = True,
    ) -> dict[str, Any]:
        logger.info(
            "Agent run completed",
            session_id=session_id,
            run_id=step_result["runId"],
            agent=step_result["agent"],
            status=step_result["status"],
            exit_code=step_result["exitCode"],
        )
        state_patch = {
            "agent_logs": [step_result.get("agentLog", "")],
            "last_exit_code": step_result["exitCode"],
            "token_usage": step_result.get("tokenUsage"),
        }
        completed_payload = {
            "runId": step_result["runId"],
            **(
                {"assignmentId": step_result["assignmentId"]}
                if step_result.get("assignmentId")
                else {}
            ),
            "agent": step_result["agent"],
            "status": step_result["status"],
            "exitCode": step_result["exitCode"],
            "agentLog": step_result.get("agentLog", ""),
        }
        if step_result.get("workResult"):
            completed_payload["workResult"] = step_result["workResult"]
        if step_result.get("tokenUsage"):
            completed_payload["tokenUsage"] = step_result["tokenUsage"]
        if step_result.get("outputTruncated"):
            completed_payload["outputTruncated"] = True
        if step_result.get("runtimeSessionId"):
            completed_payload["runtimeSessionId"] = step_result["runtimeSessionId"]
        self._append(
            session_id, relay_event("agent.completed", session_id, completed_payload)
        )
        # A handled human question may have a failed CLI exit. Keep the run's
        # exit evidence without triggering task failure automations.
        if step_result["status"] == "failed" and fail_task:
            self._update_task_status(
                "blocked",
                f"{step_result['agent']} failed with exit code {step_result['exitCode']}.",
                {
                    "code": "agent_exit_failed",
                    "runId": step_result["runId"],
                    "agent": step_result["agent"],
                    "sessionId": session_id,
                },
            )
        elif self.task_store and self.task_id:
            # A finished turn is not a task transition. The round's closeout
            # (or the next assignment) picks the status; writing one here made
            # every round pass through waiting_for_human, which automations
            # matching on status changes then saw as a real stop.
            self.task_store.record_activity(
                self.task_id,
                f"{step_result['agent']} completed.",
                {"agent": step_result["agent"], "sessionId": session_id},
                execution_owner=self.task_execution_owner,
            )
        return merge_agent_state(state, state_patch)
