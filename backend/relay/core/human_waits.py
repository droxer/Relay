"""The record of a task waiting on its human.

Every `waiting_for_human` park carries one as `waitingRequest`: an id that an
answer must name, the kind of wait, and — for an agent's own question — its
words, offered answers, and the gate reasons it stood in front of. The id is
what makes an answer the answer to *this* question: a reply that names an
older id is refused instead of resuming whatever the task waits on now.
"""

from __future__ import annotations

from typing import Any, Literal

from .ids import new_relay_id

WaitKind = Literal["question", "check", "budget"]
# `question`: the agent stopped to ask. `check`: a gate stopped the round
# (missing evidence, no verdict, an unblocked run) and a person decides what
# happens next. `budget`: the task used its continuation rounds.
WAIT_KINDS: tuple[str, ...] = ("question", "check", "budget")
QUESTION_ID_PREFIX = "q"


def new_question_id() -> str:
    return new_relay_id(QUESTION_ID_PREFIX)


def question_id_for_run(run_request_id: str) -> str:
    """The id of the question a run's closeout asks.

    Derived, not minted: a retried finalization must write the same wait, or
    its repair would see a different question and park the task twice.
    """
    return f"{QUESTION_ID_PREFIX}_{run_request_id}"


def wait_record(
    kind: WaitKind,
    question_id: str,
    *,
    question: str | None = None,
    options: list[str] | None = None,
    notes: list[str] | None = None,
) -> dict[str, Any]:
    if kind not in WAIT_KINDS:
        raise ValueError(f"Unknown wait kind: {kind}")
    return {
        "questionId": question_id,
        "kind": kind,
        **({"inputQuestion": question} if question else {}),
        **({"inputOptions": list(options)} if options else {}),
        **({"inputNotes": list(notes)} if notes else {}),
    }


def ensure_wait_record(request: Any) -> dict[str, Any]:
    """A park's wait record, minting an id for a park that brought none.

    A wait without an id has nothing an answer could name, so every park gets
    one; a caller that must stay idempotent (a run's closeout) passes its own.
    """
    if isinstance(request, dict) and request.get("questionId"):
        return dict(request)
    base = dict(request) if isinstance(request, dict) else {}
    kind = base.get("kind") if base.get("kind") in WAIT_KINDS else (
        "question" if base.get("inputQuestion") or base.get("inputOptions") else "check"
    )
    return {**base, "questionId": new_question_id(), "kind": kind}
