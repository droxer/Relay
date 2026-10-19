"""What a run in a project is told about the project.

Kept free of service imports: the daemon registry renders this while building
run state, and the dispatch services import the registry.
"""

from __future__ import annotations

from typing import Any


def project_context_brief(
    snapshot: dict[str, Any] | None, agent_names: dict[str, str] | None = None
) -> str | None:
    """Render what every run in a project should know about the project.

    The snapshot is the one the round pinned, so a brief edited mid-round
    reaches the next round rather than half of this one. Older snapshots
    carry no name or brief and render nothing.
    """
    if not snapshot or not snapshot.get("name"):
        return None
    names = agent_names or {}
    lines = [f"Project: {snapshot['name']}"]
    if snapshot.get("goal"):
        lines.append(f"Goal: {snapshot['goal']}")
    if snapshot.get("description"):
        lines.append(f"Summary: {snapshot['description']}")
    crew = [
        _crew_line(member, names, lead=member["agentId"] == snapshot.get("leadAgentId"))
        for member in snapshot.get("members", [])
        if member.get("enabled", True)
    ]
    if crew:
        lines.append("Crew:")
        lines.extend(crew)
    if snapshot.get("context"):
        lines.append("Project context (standing conventions and constraints):")
        lines.append(snapshot["context"])
    return "\n".join(lines)


def _crew_line(member: dict[str, Any], names: dict[str, str], *, lead: bool) -> str:
    marker = ", lead" if lead else ""
    name = names.get(member["agentId"])
    label = f"{name} ({member['role']}{marker})" if name else f"{member['role']}{marker}"
    return f"- {label}: {member['responsibilities']}"


CONTEXT_SUGGESTIONS_PER_RUN = 3
CONTEXT_SUGGESTIONS_MAX_PENDING = 20
CONTEXT_SUGGESTION_MAX_CHARS = 500


def context_suggestions_from_run(
    raw: Any, *, thread_id: str, run_id: str, agent_id: str | None, created_at: str
) -> list[dict[str, Any]]:
    """Hold a run's proposed context lines to a bounded, attributed shape.

    Suggestions are advice: they wait on the project until the owner adopts
    or dismisses them, and never change the context on their own.
    """
    if not isinstance(raw, list):
        return []
    suggestions: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        text = " ".join(item["text"].split())[:CONTEXT_SUGGESTION_MAX_CHARS]
        if not text:
            continue
        evidence = item.get("evidence")
        suggestions.append(
            {
                "id": f"{run_id}:{index}",
                "text": text,
                **(
                    {"evidence": " ".join(evidence.split())[:CONTEXT_SUGGESTION_MAX_CHARS]}
                    if isinstance(evidence, str) and evidence.strip()
                    else {}
                ),
                "threadId": thread_id,
                "runId": run_id,
                **({"agentId": agent_id} if agent_id else {}),
                "createdAt": created_at,
            }
        )
        if len(suggestions) == CONTEXT_SUGGESTIONS_PER_RUN:
            break
    return suggestions


def merge_context_suggestions(
    pending: list[dict[str, Any]] | None,
    incoming: list[dict[str, Any]],
    context: str,
) -> list[dict[str, Any]]:
    """Add new suggestions, skipping lines already pending or already in the
    context; the oldest fall off past the pending cap."""
    current = list(pending or [])
    seen = {item["text"].casefold() for item in current}
    known_context = context.casefold()
    for item in incoming:
        key = item["text"].casefold()
        if key in seen or key in known_context:
            continue
        seen.add(key)
        current.append(item)
    return current[-CONTEXT_SUGGESTIONS_MAX_PENDING:]
