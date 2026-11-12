from io import StringIO
from loguru import logger
from relay.core.logging_config import setup_logging


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
