"""Durable streamed-output cursors, committed with their thread events."""
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from sqlalchemy import select, update

from ..engine import store_transaction
from .state import DaemonStoreState

OUTPUT_SEQUENCES = "_outputSequences"


class CommandOutputRows(DaemonStoreState):
    @contextmanager
    def output_sequence_scope(
        self, command_id: str, initial: Callable[[], dict[str, int]]
    ) -> Iterator[dict[str, int]]:
        """Lock after the thread row; seed old commands from retained events.

        The caller's thread transaction encloses the event append and this
        cursor update, so a failed append or commit never consumes output.
        Internal command metadata needs no wire or schema change.
        """
        with store_transaction(self.engine) as conn:
            command = conn.execute(
                select(self.commands.c.command).where(self.commands.c.id == command_id).with_for_update()
            ).scalar_one()
            stored = command.get(OUTPUT_SEQUENCES)
            seen = dict(stored) if isinstance(stored, dict) else initial()
            yield seen
            if seen != stored:
                conn.execute(update(self.commands).where(self.commands.c.id == command_id).values(
                    command={**command, OUTPUT_SEQUENCES: seen},
                ))
