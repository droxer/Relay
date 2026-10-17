from __future__ import annotations

import asyncio
import signal
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from relay.processes import serve_with_worker


class Process:
    def __init__(self):
        self.returncode = None
        self.finished = asyncio.Event()
        self.terminated = False
        self.killed = False
        self.ignore_terminate = False

    def exit(self, code):
        self.returncode = code
        self.finished.set()

    async def wait(self):
        await self.finished.wait()
        return self.returncode

    def terminate(self):
        self.terminated = True
        if not self.ignore_terminate:
            self.exit(0)

    def kill(self):
        self.killed = True
        self.exit(-signal.SIGKILL)


@pytest.mark.parametrize("failed_role", ["serve", "worker"])
@pytest.mark.parametrize("code", [0, 7, -signal.SIGTERM])
def test_child_exit_stops_its_sibling_and_fails_the_container(monkeypatch, failed_role, code):
    async def run():
        children, calls = {}, []

        async def spawn(*args, **kwargs):
            role = args[3]
            process = children[role] = Process()
            calls.append((args, kwargs))
            if role == failed_role:
                process.exit(code)
            return process

        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        assert await serve_with_worker(host="0.0.0.0", port=8790, data_dir="/data") != 0
        sibling = "worker" if failed_role == "serve" else "serve"
        assert children[sibling].terminated
        for args, kwargs in calls:
            assert args[:3] == (sys.executable, "-m", "relay")
            assert kwargs["env"]["RELAY_BACKGROUND_MODE"] == "external"
            assert args[-2:] == ("--data-dir", "/data")
        api_args = next(args for args, kwargs in calls if args[3] == "serve")
        assert api_args[4:8] == ("--host", "0.0.0.0", "--port", "8790")

    asyncio.run(run())


def test_sigterm_stops_both_children_and_restores_signal_handlers(monkeypatch):
    async def run():
        loop = asyncio.get_running_loop()
        callbacks = {}
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        original = loop.add_signal_handler

        def add_signal_handler(sig, callback):
            callbacks[sig] = callback
            original(sig, callback)

        monkeypatch.setattr(loop, "add_signal_handler", add_signal_handler)
        children = []

        async def spawn(*args, **kwargs):
            child = Process()
            children.append(child)
            if len(children) == 2:
                loop.call_soon(callbacks[signal.SIGTERM])
            return child

        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        assert await serve_with_worker(host="0.0.0.0", port=8790) == 0
        assert all(child.terminated for child in children)
        assert all(signal.getsignal(sig) == handler for sig, handler in previous.items())

    asyncio.run(run())


def test_failed_second_spawn_cleans_up_the_first_process(monkeypatch):
    async def run():
        first = Process()
        spawn = AsyncMock(side_effect=[first, OSError("could not start child")])
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        with pytest.raises(OSError):
            await serve_with_worker(host="0.0.0.0", port=8790)
        assert first.terminated

    asyncio.run(run())


def test_shutdown_kills_a_child_that_ignores_termination(monkeypatch):
    async def run():
        hanging, failed = Process(), Process()
        hanging.ignore_terminate = True
        failed.exit(1)
        monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(side_effect=[hanging, failed]))
        assert await serve_with_worker(host="0.0.0.0", port=8790, shutdown_timeout=0.01) != 0
        assert hanging.killed

    asyncio.run(run())


def test_cancellation_stops_the_children(monkeypatch):
    async def run():
        entered = asyncio.Event()
        children = []

        async def spawn(*args, **kwargs):
            child = Process()
            children.append(child)
            if len(children) == 2:
                entered.set()
            return child

        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        task = asyncio.create_task(serve_with_worker(host="0.0.0.0", port=8790))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(child.terminated for child in children)

    asyncio.run(run())
