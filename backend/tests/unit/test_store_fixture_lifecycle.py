"""Test database pools live for one test, while stores in it share an engine."""

import pytest
from store_fixtures import isolated_store_engines, make_session_store, make_task_store, sqlite_url

from relay.persistence import engine as engine_module


@pytest.mark.parametrize("fail", [False, True])
def test_test_database_engines_are_released_even_on_failure(tmp_path, monkeypatch, fail):
    outer = make_session_store(tmp_path / "outer").engine
    url = sqlite_url(tmp_path / "inner")
    disposed = []
    try:
        with isolated_store_engines():
            inner = make_session_store(tmp_path / "inner").engine
            assert make_task_store(tmp_path / "inner").engine is inner
            dispose = inner.dispose

            def record_dispose():
                disposed.append(inner)
                dispose()

            monkeypatch.setattr(inner, "dispose", record_dispose)
            if fail:
                raise RuntimeError("test failure")
    except RuntimeError:
        if not fail:
            raise
    assert disposed == [inner]
    assert url not in engine_module._ENGINES
    assert make_session_store(tmp_path / "outer").engine is outer
    assert engine_module.shared_engine(url) is not inner
