"""The Project Manager's bounded view of Thread conversation evidence."""

from __future__ import annotations

from typing import Any

from sqlalchemy import case, func, literal, select, true, type_coerce, union_all

from ..engine import store_transaction
from .rows import _canonical_database_session_id
from .state import SessionStoreState


class SessionMessageRows(SessionStoreState):
    def thread_message_page(
        self, session_id: str, *, include_goal: bool, offset: int | None, limit: int, max_chars: int,
    ) -> tuple[list[dict[str, Any]], int, int]:
        session_pk = _canonical_database_session_id(session_id)
        sessions, events = self.sessions, self.events
        snapshot, payload = sessions.c.snapshot, events.c.payload
        user_message = events.c.type == "user.message"
        recorded = select(
            payload["id"].as_string().label("id"),
            payload["timestamp"].as_string().label("timestamp"),
            case((user_message, "user"), else_="agent_report").label("kind"),
            case((~user_message, payload["runId"].as_string())).label("runId"),
            func.substr(case((user_message, payload["text"].as_string()), else_=payload["agentLog"].as_string()),
                        1, max_chars + 1).label("text"),
            literal(False).label("unfinished"),
        ).where(events.c.session_id == session_pk, events.c.type.in_(("user.message", "agent.completed")))

        runs = snapshot["agentRuns"]
        if self.engine.dialect.name == "postgresql":
            values = func.jsonb_array_elements(case((func.jsonb_typeof(runs) == "array", runs)))
        else:
            values = func.json_each(runs)
        entries = values.table_valued("value").alias("run_entry")
        run = type_coerce(entries.c.value, snapshot.type)
        run_id = run["id"].as_string()
        completion = select(events.c.id).where(
            events.c.session_id == session_pk, events.c.type == "agent.completed",
            payload["runId"].as_string() == run_id,
        ).correlate(entries).exists()
        unfinished = select(
            run_id, run["startedAt"].as_string(), literal("agent_report"), run_id,
            literal(""), literal(True),
        ).select_from(sessions.join(entries, true())).where(sessions.c.id == session_pk, ~completion)
        sources = [recorded, unfinished]
        if include_goal:
            goal = snapshot["taskGoal"].as_string()
            sources.append(select(
                literal(f"{session_id}:goal"), snapshot["createdAt"].as_string(), literal("user"),
                literal(None), func.substr(goal, 1, max_chars + 1), literal(False),
            ).where(sessions.c.id == session_pk, goal != ""))
        messages = union_all(*sources).subquery()

        with store_transaction(self.engine) as conn:
            total = int(conn.scalar(select(func.count()).select_from(messages)) or 0)
            start = max(0, total - limit) if offset is None else offset
            if start >= total:
                return [], total, start
            rows = conn.execute(select(messages).order_by(
                messages.c.timestamp, messages.c.id,
            ).offset(start).limit(limit)).mappings().all()
            output = self._message_output(
                conn, session_pk, {row["runId"] for row in rows if row["unfinished"]}, max_chars + 1,
            )

        page = []
        for row in rows:
            message = {key: row[key] for key in ("id", "timestamp", "kind")}
            if row["runId"] is not None:
                message["runId"] = row["runId"]
            content = (output.get(row["runId"]) if row["unfinished"] else row["text"]) or ""
            message["text"] = content[:max_chars]
            message["truncated"] = len(content) > max_chars
            page.append(message)
        return page, total, start

    def _message_output(self, conn: Any, session_pk: str, run_ids: set[str], limit: int) -> dict[str, str]:
        """Read output only for unfinished reports on the page, stopping at the text cap."""
        events = self.events
        payload = events.c.payload
        run_id = payload["runId"].as_string()
        output: dict[str, str] = {}
        sequence = -1
        while run_ids:
            rows = conn.execute(select(events.c.sequence, run_id, events.c.type, case(
                (events.c.type == "agent.output", func.substr(payload["text"].as_string(), 1, limit)),
            ), payload["entries"]).where(
                events.c.session_id == session_pk, events.c.sequence > sequence,
                events.c.type.in_(("agent.output", "agent.output.batch")), run_id.in_(run_ids),
            ).order_by(events.c.sequence).limit(32)).all()
            if not rows:
                break
            sequence = rows[-1][0]
            for _, key, event_type, chunk, entries in rows:
                remaining = limit - len(output.get(key, ""))
                if remaining <= 0:
                    continue
                parts = (chunk or "",) if event_type == "agent.output" else (
                    str(entry.get("text", "")) for entry in (entries or ())
                )
                for part in parts:
                    output[key] = output.get(key, "") + part[:remaining]
                    remaining -= len(part)
                    if remaining <= 0:
                        run_ids.discard(key)
                        break
            if len(rows) < 32:
                break
        return output
