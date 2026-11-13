import logging
from io import StringIO

from loguru import logger
from relay.core import logging_config
from relay.core.logging_config import setup_logging
from relay.core.repeat_log import RepeatedFailureLog, RepeatGate


def test_default_streams_preserve_severity_and_context(monkeypatch):
    out, err = StringIO(), StringIO()
    monkeypatch.setattr('sys.stdout', out)
    monkeypatch.setattr('sys.stderr', err)
    setup_logging()
    try:
        logger.info('permission', request_id='request-1', token='private-token')
        logger.warning('warning')
        logger.error('failure')
        assert 'permission' in out.getvalue()
        assert 'request-1' in out.getvalue()
        assert 'private-token' not in out.getvalue()
        assert 'permission' not in err.getvalue()
        assert 'failure' in err.getvalue()
        assert '\x1b[' not in out.getvalue()
    finally:
        setup_logging(sink=StringIO())


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _levels(sink: StringIO) -> list[str]:
    return [line.split(' | ')[1].strip() for line in sink.getvalue().splitlines() if ' | ' in line]


def _fail_repeatedly(failures: RepeatedFailureLog, times: int, *, key=('node', 'run', 'run.completed')) -> None:
    for _ in range(times):
        try:
            secret_local = 'private-local-value'  # noqa: F841 - must never be dumped
            raise RuntimeError('store rejected the event')
        except RuntimeError as error:
            failures.failure('Daemon node event failed', key, error,
                             sandbox_id='node', run_id='run', event_type='run.completed',
                             session_id='ses', command_id='cmd')


def test_hundred_identical_failures_log_one_error_and_counts():
    sink = StringIO()
    setup_logging(level='DEBUG', sink=sink)
    try:
        _fail_repeatedly(RepeatedFailureLog(RepeatGate(clock=_Clock())), 100)
    finally:
        setup_logging(sink=StringIO())
    levels = _levels(sink)
    assert levels.count('ERROR') == 1
    # The counts land at 10 and 100; everything else is debug.
    assert levels.count('WARNING') == 2
    assert levels.count('DEBUG') == 97
    text = sink.getvalue()
    assert text.count('Traceback') == 1
    first = next(line for line in text.splitlines() if '| ERROR' in line)
    assert 'RuntimeError: store rejected the event' in first
    for field in ("'sandbox_id': 'node'", "'run_id': 'run'", "'session_id': 'ses'",
                  "'command_id': 'cmd'", "'event_type': 'run.completed'"):
        assert field in first
    assert 'repeated: 100 times in this window, 90 not logged' in text
    # diagnose=False: no local-variable dump.
    assert 'private-local-value' not in text


def test_info_level_keeps_repeated_failures_to_a_few_lines():
    sink = StringIO()
    setup_logging(level='INFO', sink=sink)
    try:
        _fail_repeatedly(RepeatedFailureLog(RepeatGate(clock=_Clock())), 1000)
    finally:
        setup_logging(sink=StringIO())
    lines = sink.getvalue().splitlines()
    assert _levels(sink).count('ERROR') == 1
    assert len(lines) < 30, sink.getvalue()


def test_distinct_keys_and_a_quiet_window_log_again():
    clock = _Clock()
    gate = RepeatGate(quiet_seconds=600, summary_seconds=60, clock=clock)
    assert gate.observe('a').first
    assert gate.observe('b').first
    assert not gate.observe('a').report
    clock.now = 61
    summary = gate.observe('a')
    assert summary.report and summary.count == 3 and summary.suppressed == 2
    clock.now = 61 + 600
    assert gate.observe('a').first


def test_gate_forgets_the_oldest_key_past_its_bound():
    gate = RepeatGate(max_keys=2, clock=_Clock())
    gate.observe('a')
    gate.observe('b')
    gate.observe('c')
    assert gate.observe('a').first
    assert not gate.observe('c').first


def _stdlib_record(name: str, message: str, args=None, **extra) -> logging.LogRecord:
    record = logging.LogRecord(name, logging.INFO, __file__, 1, message, args, None)
    record.__dict__.update(extra)
    return record


def test_routine_worker_ticks_drop_to_debug_but_lifecycle_and_failures_stay():
    routed = logging_config._routed
    for action in ('periodic_task_deferred', 'start_job', 'job_success', 'jobs_deferred', 'loaded_job_info'):
        assert routed(_stdlib_record('procrastinate.worker', 'tick', action=action))[0] == 'DEBUG'
    assert routed(_stdlib_record('procrastinate.worker', 'Starting worker', action='start_worker'))[0] == 'INFO'
    assert routed(_stdlib_record('procrastinate.worker', 'Stop worker', action='stop_worker'))[0] == 'INFO'
    failed = _stdlib_record('procrastinate.worker', 'ended with status: Error', action='job_error')
    failed.levelno, failed.levelname = logging.ERROR, 'ERROR'
    assert routed(failed)[0] == 'ERROR'


def test_daemon_wire_access_lines_are_debug_and_repeated_failures_collapse(monkeypatch):
    monkeypatch.setattr(logging_config, '_access_failures', RepeatGate(clock=_Clock()))
    routed = logging_config._routed

    def access(path: str, status: int) -> logging.LogRecord:
        return _stdlib_record('uvicorn.access', '%s - "%s %s HTTP/%s" %d',
                              ('127.0.0.1:1', 'POST', path, '1.1', status))

    assert routed(access('/api/v1/daemon-nodes/n/heartbeat', 200))[0] == 'DEBUG'
    assert routed(access('/api/v1/threads', 200))[0] == 'INFO'
    levels = [routed(access('/api/v1/daemon-nodes/n/events', 500))[0] for _ in range(100)]
    assert levels.count('INFO') == 3  # first, 10th, 100th
    assert levels.count('DEBUG') == 97
