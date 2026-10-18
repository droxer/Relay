"""Supervise the API and control-plane worker in one deployment container.

Both processes need the same local skill objects when R2 is not configured.
They share a filesystem and environment, but keep separate Python event loops.
An unexpected child exit stops its sibling and fails the container so the
platform restarts the complete service.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys

from loguru import logger


async def serve_with_worker(
    *, host: str, port: int, data_dir: str | None = None,
    shutdown_timeout: float = 30.0,
) -> int:
    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()
    signals = (signal.SIGTERM, signal.SIGINT)
    previous = {sig: signal.getsignal(sig) for sig in signals}
    children: dict[str, asyncio.subprocess.Process] = {}
    waits: dict[str, asyncio.Task[int]] = {}
    stop_wait = asyncio.create_task(stopping.wait())
    environment = {**os.environ, "RELAY_BACKGROUND_MODE": "external"}
    data_args = ["--data-dir", data_dir] if data_dir is not None else []

    for sig in signals:
        loop.add_signal_handler(sig, stopping.set)
    try:
        commands = {
            "worker": ["worker", *data_args],
            "serve": ["serve", "--host", host, "--port", str(port), *data_args],
        }
        for role, args in commands.items():
            if stopping.is_set():
                return 0
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "relay", *args, env=environment,
            )
            children[role] = process
            waits[role] = asyncio.create_task(process.wait())
            logger.info("Started backend process: {} (pid {})", role, process.pid)

        await asyncio.wait([stop_wait, *waits.values()], return_when=asyncio.FIRST_COMPLETED)
        if stopping.is_set():
            return 0
        for role, wait in waits.items():
            if wait.done():
                code = wait.result()
                logger.error("Backend process {} exited unexpectedly (code {})", role, code)
                # Even a clean child exit means half the service is missing.
                return code if code > 0 else 1
        return 1
    finally:
        for process in children.values():
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
        try:
            await asyncio.wait_for(
                asyncio.gather(*(process.wait() for process in children.values())),
                timeout=shutdown_timeout,
            )
        except TimeoutError:
            logger.warning("Backend shutdown exceeded {} seconds; stopping remaining processes", shutdown_timeout)
            for process in children.values():
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
            await asyncio.gather(*(process.wait() for process in children.values()))
        finally:
            stop_wait.cancel()
            await asyncio.gather(stop_wait, *waits.values(), return_exceptions=True)
            for sig, handler in previous.items():
                loop.remove_signal_handler(sig)
                signal.signal(sig, handler)
