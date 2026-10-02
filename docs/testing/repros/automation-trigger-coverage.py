"""Measure executable-line coverage of the automation modules without extra dependencies.

Run from the repository root using uv run --project backend --extra dev python.
Worker threads are traced because FastAPI TestClient executes routes there.
This is line coverage, not branch coverage.
"""

from pathlib import Path
import sys, trace, pytest, threading
root = Path.cwd()
files = [root / 'backend/relay/automations/trigger.py', root / 'backend/relay/automations/matcher.py',
         root / 'backend/relay/persistence/automation_store.py', root / 'backend/relay/api/automation_routes.py']
executed = {str(f): set() for f in files}
def record(frame, event, arg):
    filename = frame.f_code.co_filename
    if filename not in executed:
        return None
    if event == 'line':
        executed[filename].add(frame.f_lineno)
    return record
sys.settrace(record)
threading.settrace_all_threads(record)
status = pytest.main(['backend/tests/unit/test_automation_trigger.py', 'backend/tests/unit/test_automation_outbox.py',
                     'backend/tests/unit/test_automation_matcher.py', 'backend/tests/api/test_automation_triggers_api.py',
                     'backend/tests/api/test_automation_webhook.py', '-q'])
sys.settrace(None)
threading.settrace_all_threads(None)
for file in files:
    lines = trace._find_executable_linenos(str(file))
    hit = len(set(lines) & executed[str(file)])
    print(f'{file.relative_to(root)}: {hit}/{len(lines)} executable lines ({100*hit/len(lines):.1f}%)')
raise SystemExit(status)
