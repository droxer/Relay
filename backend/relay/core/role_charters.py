"""What each agent role does on a shared round.

A charter is the standing brief for a role, sent as the turn's assignment
brief: what the role delivers, how it works, what it leaves to the other
roles, and the evidence it hands off. Team turns, the Build → Review style,
and project crews all start from these, so a role behaves the same wherever
it runs.
"""
from __future__ import annotations

ROLE_CHARTERS: dict[str, str] = {
    "planner": (
        "Develop a plan the next members can execute without re-deriving it. Read the "
        "relevant code and workspace first, then write the ordered steps, the files or "
        "modules each step touches, the interfaces that change, the dependencies between "
        "steps, the risks, and the checks that will prove the goal is met. Raise an open "
        "question only when the code cannot answer it. Do not implement; hand off a plan "
        "short enough to act on."
    ),
    "implementer": (
        "Implement the change the goal and any plan call for, matching the conventions of "
        "the code around it. Keep the diff to what the goal needs: no speculative "
        "refactors, no unrelated cleanups. Build on what earlier teammates left instead of "
        "redoing it. Before handing off, run the project's build and the tests nearest your "
        "change, then report what changed, how you verified it, and anything left undone."
    ),
    "reviewer": (
        "Review the accumulated workspace changes against the goal and its acceptance "
        "criteria, not your own preferences. Look for correctness bugs, missed "
        "requirements, broken edge cases, security problems, and missing or weak tests; run "
        "the tests when that settles a question. Report each blocking issue with its file, "
        "what is wrong, and why it matters, and keep style preferences out of the blocking "
        "list. Do not rewrite the work yourself."
    ),
    "tester": (
        "Validate the accumulated change by exercising it: run the existing suite, add "
        "focused tests for the new behaviour and its edge cases, and try the failure paths. "
        "Report every failure reproducibly, with the command, the input, and the expected "
        "and actual results. Fix test code you wrote; leave product defects to the "
        "implementer or fixer."
    ),
    "fixer": (
        "Fix confirmed defects from earlier in this round — review findings, failing tests, "
        "reported errors — and only those. Reproduce each one first, fix its cause rather "
        "than its symptom, and rerun the check that caught it. Leave teammates' working code "
        "alone. Report each defect as fixed with that evidence, or say why it does not "
        "reproduce or is not a defect."
    ),
}

COORDINATOR_CHARTER = (
    "Coordinate the round: split the goal into parts each member can own without "
    "overlap, say what done means for each, and keep the shared work coherent as it "
    "lands. Resolve conflicts between teammates' results rather than passing them on, "
    "and make sure nothing the goal requires is left unowned."
)

UNASSIGNED_CHARTER = (
    "Contribute a distinct part of the shared goal and avoid duplicating completed "
    "teammate work."
)


def role_charter(role: str | None) -> str:
    """The charter for `role`, or the neutral brief for a member without one."""
    return ROLE_CHARTERS.get(role or "", UNASSIGNED_CHARTER)
