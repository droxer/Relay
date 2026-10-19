"""One-time, non-destructive import of the retired file-backed stores.

Daemon nodes, agents, teams, agent placements, and chat integrations used to
have JSON twins under the data directory. They are database-only now; this
module moves an existing install's files into the configured database once,
at boot (``import_local_file_stores_before_serving``) or by hand
(``relay migrate-local-file-stores --data-dir <dir> [--dry-run]``).

Legacy layout read (relative to the data directory)::

    daemon/nodes/<id>.json            node records (token hashes, tombstones)
    daemon/commands/<id>.json         command queue and its terminal history
    daemon/runs/<runId>.json          run records
    daemon/run-requests/<id>.json     run requests
    daemon/events/events.jsonl        daemon event log
    agents/<id>/{snapshot.json,events.jsonl}
    teams/<id>/{snapshot.json,events.jsonl}
    agent-placements/<id>/{snapshot.json,events.jsonl}
    chat/{integrations,secrets,conversations}.json, chat/audit.jsonl

Every record is read with ``read_json``/``read_jsonl``, which upgrade the
pre-rename ``employee*`` names on read, exactly as the file stores did.

Imported in full: nodes (with their per-agent settings, token hashes,
capabilities, and ``retiredAt`` tombstones), commands (queued and terminal),
runs, run requests, agents, teams, and placements with their event logs, and
every chat document. Secrets are encrypted with ``RELAY_CHAT_SECRET_KEY`` the
way the database chat store keeps them, so importing chat secrets requires it.

Deliberately skipped:

* Prunable daemon events (``daemon.command.*``, ``daemon.run_request.*``,
  ``daemon.node.seen``) other than workspace responses. They are a bounded
  audit trail retention deletes anyway and nothing reads them back. Node
  lifecycle events are kept: ``historical_managed_runtime_ids`` reads them.
* Workspace responses whose command is not imported -- nothing can ask for
  them.
* Commands, runs, run requests, and placements whose daemon node is gone, and
  placements whose agent is gone. The database cascades those away when a
  node or agent is deleted, so importing them would create rows the database
  could never have held. A run whose command was pruned keeps its row with no
  command, as ``ON DELETE SET NULL`` would leave it.

The import is idempotent and atomic. A marker keyed by a hash of the source
root (a ``managed_node_records`` row of kind ``file-store-imports``) makes a
second run a no-op; without a marker, a row already in the database must
match the file exactly or the whole import rolls back with a ``ValueError``
naming the record. Source files are never modified or deleted.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from loguru import logger
from sqlalchemy import insert, select, text
from sqlalchemy.exc import DBAPIError

from ..agent.placements import _normalized_placement_snapshot, _placement_event_row, _placement_row
from ..agent.store import _agent_event_row, _agent_row, _normalized_agent_snapshot
from ..daemon.rows import (
    command_to_row,
    daemon_event_to_row,
    node_agent_rows,
    node_to_row,
    run_request_to_row,
    run_to_row,
)
from ..daemon.rules import _NODE_LIVENESS_COLUMNS, _node_for_storage, daemon_event_is_prunable
from ..db_time import format_db_time, parse_db_time
from .files import read_json, read_jsonl
from ..engine import create_all_tables, shared_engine, store_transaction
from ...core.ids import new_database_id, now_iso
from ..tables import agent_placements as placement_tables
from ..tables import agents as agent_tables
from ..tables import chat as chat_tables
from ..tables import daemon as daemon_tables
from ..tables import managed_nodes as managed_node_tables
from ..tables import teams as team_tables
from ..team.store import _normalized_team_snapshot, _team_event_row, _team_row

IMPORT_MARKER_KIND = "file-store-imports"
CLI_COMMAND = "relay migrate-local-file-stores --data-dir <data-dir>"
_IMPORT_LOCK_KEY = 0x52454C4159  # pg advisory lock: one importer at a time
_CHAT_DOCUMENTS = (
    ("integrations", "integrations.json"),
    ("conversations", "conversations.json"),
)
_COUNT_KEYS = (
    "nodes",
    "commands",
    "runs",
    "runRequests",
    "daemonEvents",
    "agents",
    "teams",
    "placements",
    "chatDocuments",
)


def source_id(root: Path) -> str:
    """The import marker's key for one data directory."""
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()


def _daemon_files(root: Path) -> Iterator[Path]:
    for directory in ("nodes", "commands", "runs", "run-requests"):
        yield from sorted((root / "daemon" / directory).glob("*.json"))


def local_file_stores_present(root: str | Path) -> bool:
    """Whether the data directory still holds any retired file-store record."""
    base = Path(root)
    if any(True for _ in _daemon_files(base)):
        return True
    if (base / "daemon" / "events" / "events.jsonl").exists():
        return True
    for directory in ("agents", "teams", "agent-placements"):
        if any((base / directory).glob("*/snapshot.json")):
            return True
    chat = base / "chat"
    return any(
        (chat / name).exists()
        for name in ("integrations.json", "secrets.json", "conversations.json", "audit.jsonl")
    )


def _comparable(value: Any) -> Any:
    if isinstance(value, datetime):
        return format_db_time(value)
    if isinstance(value, (dict, list)):
        return json.loads(json.dumps(value, sort_keys=True))
    return value


class RowImporter:
    """Inserts rows into one open transaction, accepting identical ones.

    Shared by every one-time import of a retired file store, so they agree on
    what counts as the same record and on how a dry run behaves.
    """

    def __init__(self, conn: Any, *, dry_run: bool, count_keys: tuple[str, ...]) -> None:
        self.conn = conn
        self.dry_run = dry_run
        self.counts = dict.fromkeys(count_keys, 0)
        self.skipped: dict[str, int] = {}

    def _skip(self, reason: str, count: int = 1) -> None:
        if count:
            self.skipped[reason] = self.skipped.get(reason, 0) + count

    def _existing(self, table: Any, row_id: str) -> Any:
        return (
            self.conn.execute(select(table).where(table.c.id == row_id))
            .mappings()
            .first()
        )

    def _execute(self, label: str, statement: Any, values: Any = None) -> None:
        if self.dry_run:
            return
        try:
            if values is None:
                self.conn.execute(statement)
            else:
                self.conn.execute(statement, values)
        except DBAPIError as error:
            raise ValueError(f"Could not import {label}: {error.orig}") from error

    def _put(
        self,
        table: Any,
        values: dict[str, Any],
        label: str,
        *,
        ignore: frozenset[str] = frozenset(),
    ) -> bool:
        """Insert a row, or accept an identical one. Returns True if inserted."""
        existing = self._existing(table, values["id"])
        if existing is None:
            self._execute(label, insert(table).values(**values))
            return True
        for key, value in values.items():
            if key in ignore:
                continue
            if _comparable(existing[key]) != _comparable(value):
                raise ValueError(
                    f"Conflicting {label}: the database already holds a different "
                    f"record ({key} differs)."
                )
        return False


class _Importer(RowImporter):
    """Writes one source root into one open transaction."""

    def __init__(self, conn: Any, root: Path, *, dry_run: bool) -> None:
        super().__init__(conn, dry_run=dry_run, count_keys=_COUNT_KEYS)
        self.root = root
        self.node_ids: set[str] = set()
        self.command_ids: set[str] = set()
        self.agent_ids: set[str] = set()

    # -- daemon -----------------------------------------------------------------

    def import_nodes(self) -> None:
        nodes = daemon_tables.nodes
        agents = daemon_tables.node_agents
        for path in sorted((self.root / "daemon" / "nodes").glob("*.json")):
            node = _node_for_storage(read_json(path))
            label = f"daemon node {node['id']}"
            inserted = self._put(
                nodes, node_to_row(node), label, ignore=_NODE_LIVENESS_COLUMNS
            )
            desired = node_agent_rows(node, node["id"])
            if inserted:
                if desired:
                    self._execute(label, insert(agents), desired)
            else:
                current = (
                    self.conn.execute(
                        select(agents)
                        .where(agents.c.node_id == node["id"])
                        .order_by(agents.c.agent)
                    )
                    .mappings()
                    .all()
                )
                if [_comparable(dict(row)) for row in current] != [
                    _comparable(row) for row in desired
                ]:
                    raise ValueError(
                        f"Conflicting {label}: the database already holds "
                        "different per-agent settings."
                    )
            self.node_ids.add(node["id"])
            self.counts["nodes"] += 1

    def _node_known(self, node_id: Any) -> bool:
        if not node_id:
            return False
        if node_id in self.node_ids:
            return True
        return self._existing(daemon_tables.nodes, str(node_id)) is not None

    def import_commands(self) -> None:
        for path in sorted((self.root / "daemon" / "commands").glob("*.json")):
            record = read_json(path)
            if not self._node_known(record.get("nodeId")):
                self._skip("commandsForMissingNode")
                continue
            self._put(
                daemon_tables.commands,
                command_to_row(record, node_pk=record["nodeId"]),
                f"daemon command {record['id']}",
            )
            self.command_ids.add(record["id"])
            self.counts["commands"] += 1

    def import_runs(self) -> None:
        for path in sorted((self.root / "daemon" / "runs").glob("*.json")):
            run = read_json(path)
            if not self._node_known(run.get("nodeId")):
                self._skip("runsForMissingNode")
                continue
            command_id = run.get("commandId")
            if command_id and command_id not in self.command_ids and not self._existing(
                daemon_tables.commands, command_id
            ):
                run = {key: value for key, value in run.items() if key != "commandId"}
            self._put(daemon_tables.runs, run_to_row(run), f"daemon run {run['runId']}")
            self.counts["runs"] += 1

    def import_run_requests(self) -> None:
        for path in sorted((self.root / "daemon" / "run-requests").glob("*.json")):
            record = read_json(path)
            if not self._node_known(record.get("nodeId")):
                self._skip("runRequestsForMissingNode")
                continue
            self._put(
                daemon_tables.run_requests,
                run_request_to_row(record, node_pk=record["nodeId"]),
                f"run request {record['id']}",
            )
            self.counts["runRequests"] += 1

    def import_daemon_events(self) -> None:
        path = self.root / "daemon" / "events" / "events.jsonl"
        if not path.exists():
            return
        events = daemon_tables.events
        for event in read_jsonl(path):
            event_type = str(event.get("type") or "")
            if event_type == "daemon.workspace.response":
                if event.get("commandId") not in self.command_ids:
                    self._skip("workspaceResponsesWithoutCommand")
                    continue
            elif daemon_event_is_prunable(event_type):
                self._skip("prunableDaemonEvents")
                continue
            if not event.get("timestamp"):
                self._skip("daemonEventsWithoutTimestamp")
                continue
            row = daemon_event_to_row(event)
            duplicates = self.conn.execute(
                select(events.c.payload)
                .where(events.c.type == row["type"])
                .where(events.c.timestamp == row["timestamp"])
            ).scalars()
            if any(_comparable(payload) == _comparable(event) for payload in duplicates):
                continue
            self._execute(f"daemon event {event_type}", insert(events).values(**row))
            self.counts["daemonEvents"] += 1

    # -- event-sourced aggregates -----------------------------------------------

    def _aggregate(
        self,
        directory: str,
        *,
        table: Any,
        events_table: Any,
        normalize: Any,
        row: Any,
        event_row: Any,
        kind: str,
    ) -> Iterator[dict[str, Any]]:
        for snapshot_path in sorted((self.root / directory).glob("*/snapshot.json")):
            snapshot = normalize(read_json(snapshot_path))
            yield snapshot
            events_path = snapshot_path.parent / "events.jsonl"
            history = read_jsonl(events_path) if events_path.exists() else []
            label = f"{kind} {snapshot['id']}"
            values = row(snapshot, event_version=len(history))
            if not self._put(table, values, label, ignore=frozenset({"event_version"})):
                continue
            for sequence, event in enumerate(history):
                event = {
                    **event,
                    "id": event.get("id") or new_database_id(),
                    "timestamp": event.get("timestamp") or snapshot["updatedAt"],
                }
                self._execute(
                    label,
                    insert(events_table).values(**event_row(snapshot["id"], sequence, event)),
                )

    def import_agents(self) -> None:
        for agent in self._aggregate(
            "agents",
            table=agent_tables.agents,
            events_table=agent_tables.events_table,
            normalize=_normalized_agent_snapshot,
            row=_agent_row,
            event_row=_agent_event_row,
            kind="agent",
        ):
            self.agent_ids.add(agent["id"])
            self.counts["agents"] += 1

    def import_teams(self) -> None:
        for _team in self._aggregate(
            "teams",
            table=team_tables.teams,
            events_table=team_tables.events_table,
            normalize=_normalized_team_snapshot,
            row=_team_row,
            event_row=_team_event_row,
            kind="team",
        ):
            self.counts["teams"] += 1

    def import_placements(self) -> None:
        directory = self.root / "agent-placements"
        for snapshot_path in sorted(directory.glob("*/snapshot.json")):
            placement = _normalized_placement_snapshot(read_json(snapshot_path))
            if not self._node_known(placement.get("daemonNodeId")):
                self._skip("placementsForMissingNode")
                continue
            agent_id = placement.get("agentId")
            if agent_id not in self.agent_ids and not self._existing(
                agent_tables.agents, str(agent_id)
            ):
                self._skip("placementsForMissingAgent")
                continue
            events_path = snapshot_path.parent / "events.jsonl"
            history = read_jsonl(events_path) if events_path.exists() else []
            label = f"agent placement {placement['id']}"
            values = _placement_row(placement, event_version=len(history))
            if self._put(
                placement_tables.placements,
                values,
                label,
                ignore=frozenset({"event_version"}),
            ):
                for sequence, event in enumerate(history):
                    event = {
                        **event,
                        "id": event.get("id") or new_database_id(),
                        "timestamp": event.get("timestamp") or placement["updatedAt"],
                        "placement": event.get("placement") or placement,
                    }
                    self._execute(
                        label,
                        insert(placement_tables.events_table).values(
                            **_placement_event_row(placement["id"], sequence, event)
                        ),
                    )
            self.counts["placements"] += 1

    # -- chat ---------------------------------------------------------------------

    def _put_document(
        self,
        key: str,
        payload: Any,
        *,
        expected: Any = None,
        decode: Callable[[Any], Any] = lambda value: value,
    ) -> None:
        """Insert a chat document, or accept one whose decoded value matches."""
        documents = chat_tables.documents
        existing = self.conn.scalar(
            select(documents.c.payload).where(documents.c.document_key == key)
        )
        if existing is not None:
            wanted = payload if expected is None else expected
            if _comparable(decode(existing)) != _comparable(wanted):
                raise ValueError(
                    f"Conflicting chat document {key}: the database already "
                    "holds a different value."
                )
            return
        self._execute(
            f"chat document {key}",
            insert(documents).values(
                id=new_database_id(),
                document_key=key,
                payload=payload,
                updated_at=parse_db_time(now_iso()),
            ),
        )
        self.counts["chatDocuments"] += 1

    def import_chat(self) -> None:
        chat = self.root / "chat"
        for key, filename in _CHAT_DOCUMENTS:
            path = chat / filename
            if path.exists():
                value = read_json(path)
                self._put_document(key, value if isinstance(value, list) else [])
        audit = chat / "audit.jsonl"
        if audit.exists():
            self._put_document("audit", read_jsonl(audit))
        secrets_path = chat / "secrets.json"
        if secrets_path.exists():
            secrets = read_json(secrets_path)
            if isinstance(secrets, dict) and secrets:
                self._import_chat_secrets(secrets)

    def _import_chat_secrets(self, secrets: dict[str, Any]) -> None:
        raw_key = os.environ.get("RELAY_CHAT_SECRET_KEY", "").strip()
        if not raw_key:
            raise ValueError(
                "chat/secrets.json holds chat provider secrets; set "
                "RELAY_CHAT_SECRET_KEY so they can be encrypted into the database."
            )
        cipher = Fernet(raw_key.encode())

        def decrypt(document: Any) -> Any:
            if isinstance(document, dict) and isinstance(document.get("ciphertext"), str):
                try:
                    return json.loads(cipher.decrypt(document["ciphertext"].encode()))
                except InvalidToken as error:
                    raise ValueError(
                        "RELAY_CHAT_SECRET_KEY cannot decrypt database chat secrets."
                    ) from error
            return document

        ciphertext = cipher.encrypt(
            json.dumps(secrets, separators=(",", ":")).encode()
        ).decode()
        self._put_document(
            "secrets", {"ciphertext": ciphertext}, expected=secrets, decode=decrypt
        )

    def run(self) -> None:
        self.import_nodes()
        self.import_commands()
        self.import_runs()
        self.import_run_requests()
        self.import_daemon_events()
        self.import_agents()
        self.import_teams()
        self.import_placements()
        self.import_chat()


@contextmanager
def import_transaction(engine: Any) -> Iterator[Any]:
    with store_transaction(engine) as conn:
        if engine.dialect.name == "postgresql":
            # Replicas booting together import one at a time; the loser then
            # finds the marker. SQLite already serializes writers.
            conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _IMPORT_LOCK_KEY})
        yield conn


def import_marker(conn: Any, kind: str, marker_id: str) -> Any:
    """The marker an earlier import of ``kind`` left for one source, if any."""
    records = managed_node_tables.records
    return conn.scalar(
        select(records.c.snapshot).where(records.c.kind == kind, records.c.id == marker_id)
    )


def write_import_marker(
    conn: Any, kind: str, marker_id: str, root: Path, details: dict[str, Any]
) -> None:
    conn.execute(
        insert(managed_node_tables.records).values(
            kind=kind,
            id=marker_id,
            node_id=None,
            snapshot={
                "id": marker_id,
                "sourceRoot": str(root.resolve()),
                "importedAt": now_iso(),
                **details,
            },
        )
    )


def file_stores_imported(root: str | Path, database_url: str) -> bool:
    engine = shared_engine(database_url)
    with store_transaction(engine) as conn:
        return import_marker(conn, IMPORT_MARKER_KIND, source_id(Path(root))) is not None


def migrate_local_file_stores(
    root_dir: str | Path, database_url: str, *, dry_run: bool = False
) -> dict[str, Any]:
    """Import the retired file stores under ``root_dir`` into the database.

    Returns a report of what was (or, with ``dry_run``, would be) imported and
    what was skipped. Raises ``ValueError`` on a conflicting record; nothing is
    written in that case.
    """
    root = Path(root_dir)
    marker_id = source_id(root)
    engine = shared_engine(database_url)
    if engine.dialect.name == "sqlite":
        create_all_tables(engine)
    with import_transaction(engine) as conn:
        if import_marker(conn, IMPORT_MARKER_KIND, marker_id) is not None:
            return {
                "alreadyImported": True,
                "dryRun": dry_run,
                **dict.fromkeys(_COUNT_KEYS, 0),
                "skipped": {},
            }
        importer = _Importer(conn, root, dry_run=dry_run)
        importer.run()
        if not dry_run:
            write_import_marker(
                conn, IMPORT_MARKER_KIND, marker_id, root, {"counts": importer.counts}
            )
    return {
        "alreadyImported": False,
        "dryRun": dry_run,
        **importer.counts,
        "skipped": importer.skipped,
    }


def import_local_file_stores_before_serving(root_dir: str | Path, database_url: str) -> None:
    """Boot-time import: a no-op without legacy files or once imported."""
    root = Path(root_dir)
    if not local_file_stores_present(root) or file_stores_imported(root, database_url):
        return
    try:
        report = migrate_local_file_stores(root, database_url)
    except ValueError as error:
        raise RuntimeError(
            f"Importing the file-backed stores under {root} failed: {error} "
            f"Resolve the conflict, then rerun {CLI_COMMAND} (use --dry-run to "
            "preview) against the configured database."
        ) from error
    logger.info(
        "Imported file-backed stores into the database",
        root_dir=str(root),
        **{key: report[key] for key in _COUNT_KEYS},
        skipped=report["skipped"],
    )
