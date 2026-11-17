"""Background artifact indexer: drains the durable pending-indexing queue.

A completed run enqueues its reported workspace files (with inline snapshot
bytes) in the receipt transaction. This loop claims those batches — at most
``ARTIFACT_INDEX_BATCH_LIMIT`` items each — and uploads snapshots and writes
``artifact.created`` events outside any request, so ``run.completed`` never
performs per-file blob uploads or storage transactions and a slow or blocked
blob store cannot stall completion acknowledgement, cancellation, or reads.

Idempotency is by re-checking the thread's already-indexed paths before each
insert, so a crashed indexer re-claims a batch after its lease expires and
never duplicates an artifact or event.
"""

from __future__ import annotations

import asyncio
import base64
import time
from typing import Any

from loguru import logger

from ..persistence.events import relay_event
from ..persistence.session.artifact_indexing import ARTIFACT_INDEX_BATCH_LIMIT


def _decode_content(encoded: Any) -> bytes | None:
    if not isinstance(encoded, str) or not encoded:
        return None
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        return None


class ArtifactIndexWorker:
    def __init__(
        self,
        session_store: Any,
        *,
        interval_seconds: float = 5.0,
        lease_seconds: float = 300.0,
        max_attempts: int = 5,
    ):
        self.store = session_store
        self.interval_seconds = interval_seconds
        self.lease_seconds = lease_seconds
        self.max_attempts = max_attempts
        self.batch_limit = ARTIFACT_INDEX_BATCH_LIMIT
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def _index_batch(self, batch: dict[str, Any]) -> int:
        session_id = batch["sessionId"]
        run_id = batch["runId"]
        try:
            seen = self.store.run_indexed_relative_paths(session_id, run_id)
        except KeyError:
            raise
        indexed = 0
        for item in batch["items"]:
            relative = item.get("workspaceRelativePath")
            if relative in seen:
                continue
            artifact = {
                key: value for key, value in item.items() if key != "contentBase64"
            }
            content = _decode_content(item.get("contentBase64"))
            index = getattr(self.store, "index_workspace_artifact", None)
            if index is None:
                self.store.append_event(
                    session_id,
                    relay_event("artifact.created", session_id, {"artifact": artifact}),
                    hydrate_events=False,
                )
            else:
                index(session_id, artifact, content)
            seen.add(relative)
            indexed += 1
        return indexed

    def _process_batch(self, batch: dict[str, Any]) -> None:
        started = time.monotonic()
        lease_token = batch.get("leaseToken")
        try:
            indexed = self._index_batch(batch)
        except KeyError:
            # The thread was deleted after the batch was claimed; the FK
            # cascade already removed the row, so there is nothing to mark.
            logger.info(
                "Artifact index batch abandoned: thread deleted",
                session_id=batch["sessionId"],
                run_id=batch["runId"],
            )
            return
        except Exception as error:  # noqa: BLE001 - recorded and retried below
            attempts = int(batch.get("attempts") or 0) + 1
            if attempts >= self.max_attempts:
                applied = self.store.fail_artifact_index_batch(
                    batch["id"],
                    str(error),
                    attempts=attempts,
                    lease_token=lease_token,
                )
                if not applied:
                    logger.info(
                        "Artifact index batch claim superseded; failure left to the newer claim",
                        session_id=batch["sessionId"],
                        run_id=batch["runId"],
                    )
                    return
                logger.error(
                    "Artifact index batch failed permanently",
                    session_id=batch["sessionId"],
                    run_id=batch["runId"],
                    attempts=attempts,
                    error=str(error),
                )
            else:
                applied = self.store.requeue_artifact_index_batch(
                    batch["id"], attempts=attempts, lease_token=lease_token
                )
                if not applied:
                    logger.info(
                        "Artifact index batch claim superseded; requeue left to the newer claim",
                        session_id=batch["sessionId"],
                        run_id=batch["runId"],
                    )
                    return
                logger.warning(
                    "Artifact index batch failed; requeued",
                    session_id=batch["sessionId"],
                    run_id=batch["runId"],
                    attempts=attempts,
                    error=str(error),
                )
            return
        elapsed_ms = (time.monotonic() - started) * 1000
        if not self.store.complete_artifact_index_batch(
            batch["id"], lease_token=lease_token
        ):
            logger.info(
                "Artifact index batch claim superseded after indexing; newer claim left untouched",
                session_id=batch["sessionId"],
                run_id=batch["runId"],
            )
            return
        logger.info(
            "Artifact index batch indexed",
            session_id=batch["sessionId"],
            run_id=batch["runId"],
            items=indexed,
            duration_ms=round(elapsed_ms, 1),
            pending=self.store.pending_artifact_index_batch_count(),
        )

    def tick(self) -> int:
        """Claim and process one batch; returns the number of batches processed."""
        batches = self.store.claim_artifact_index_batches(
            limit=1, lease_seconds=self.lease_seconds
        )
        for batch in batches:
            self._process_batch(batch)
        return len(batches)

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="relay-artifact-indexer")

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.to_thread(self.tick)
            except Exception:  # noqa: BLE001 - recovery loop supervisor: logs and retries next tick
                logger.exception("Artifact index tick failed; retrying")
            try:
                await asyncio.wait_for(self._stop.wait(), self.interval_seconds)
            except TimeoutError:
                pass

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await self._task  # Don't abandon a thread still mutating stores.
            self._task = None
