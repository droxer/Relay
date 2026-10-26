from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from relay.persistence.run_once import initialize_run_once, run_once
from store_fixtures import make_agent_store


def test_failed_work_keeps_original_cutoff(tmp_path: Path) -> None:
    engine = make_agent_store(tmp_path).engine
    initialize_run_once(engine, "test-job")
    with pytest.raises(RuntimeError, match="interrupted"):
        with run_once(engine, "test-job") as original_cutoff:
            assert original_cutoff is not None
            raise RuntimeError("interrupted")

    initialize_run_once(engine, "test-job")
    with run_once(engine, "test-job") as retry_cutoff:
        assert retry_cutoff == original_cutoff
    with run_once(engine, "test-job") as completed:
        assert completed is None


def test_concurrent_workers_execute_job_once(tmp_path: Path) -> None:
    engine = make_agent_store(tmp_path).engine
    ready = Barrier(2)

    def worker():
        ready.wait(timeout=5)
        initialize_run_once(engine, "test-job")
        with run_once(engine, "test-job") as cutoff:
            return cutoff is not None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: worker(), range(2)))

    assert sorted(results) == [False, True]
