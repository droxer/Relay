"""Task Thread titles are independent from the full execution prompt."""
from store_fixtures import make_session_store, make_task_store
from relay.sessions.controller import SessionController


def test_task_thread_uses_full_task_title_and_keeps_goal(tmp_path):
    tasks = make_task_store(tmp_path)
    sessions = make_session_store(tmp_path)
    title = "修复任务标题 " * 30
    task = tasks.create_task({"title": title})
    controller = SessionController(sessions, task_store=tasks, task_id=task["id"])
    goal = f"{title}\n\nDetailed execution instructions"
    session = controller.create_session(goal)
    persisted = sessions.get_session(session["id"])
    assert persisted.get("title") == task["title"]
    assert persisted["taskGoal"] == goal
    assert tasks.get_task(task["id"])["linkedSessionIds"] == [session["id"]]


def test_automation_thread_numbers_are_stable_after_later_runs(tmp_path):
    tasks = make_task_store(tmp_path)
    sessions = make_session_store(tmp_path)
    routine = tasks.create_task({"title": "每日检查", "isRoutine": True, "routineState": "active", "assignedAgent": "codex"})
    occurrences = [tasks.create_triggered_occurrence(
        routine["id"], run_date="2026-11-12", trigger_kind=kind, depth=0, context=""
    ) for kind in ("manual", "schedule", "event")]
    for number, occurrence in enumerate(occurrences, 1):
        assert occurrence is not None
        controller = SessionController(sessions, task_store=tasks, task_id=occurrence["id"])
        for _ in range(2):
            session = controller.create_session("Full automation prompt")
            assert sessions.get_session(session["id"]).get("title") == f"每日检查 #{number}"
            assert session["taskGoal"] == "Full automation prompt"


def test_standalone_thread_has_no_task_title(tmp_path):
    session = SessionController(make_session_store(tmp_path)).create_session("Hello")
    assert session.get("title") is None
    assert session["taskGoal"] == "Hello"


def test_legacy_occurrence_without_automation_keeps_task_title(tmp_path):
    tasks = make_task_store(tmp_path)
    task = tasks.create_task({"title": "Historical run", "sourceRoutineId": "missing"})
    controller = SessionController(make_session_store(tmp_path), task_store=tasks, task_id=task["id"])
    assert controller.create_session("Execution prompt")["title"] == "Historical run"


def test_idempotent_creation_preserves_user_rename(tmp_path):
    tasks = make_task_store(tmp_path)
    sessions = make_session_store(tmp_path)
    task = tasks.create_task({"title": "Original title"})
    controller = SessionController(sessions, task_store=tasks, task_id=task["id"])
    session = controller.create_session("Execution prompt", session_id="e398189c-3782-4dd1-859b-a987f1ef408f")
    controller.rename_session(session["id"], "User title")
    retried = controller.create_session("Execution prompt", session_id=session["id"])
    assert retried["title"] == "User title"
    assert len([event for event in retried["events"] if event["type"] == "session.created"]) == 1
