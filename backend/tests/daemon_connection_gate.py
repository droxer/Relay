"""Test-only ASGI fault boundary around the actual server, never production."""
import asyncio
import gzip
import json
import time


class ConnectionGate:
    def __init__(self, app):
        self.app = app
        self.fault = None
        self.requests = []

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        entry = {"path": path, "at": time.monotonic()}
        self.requests.append(entry)
        fault = self.fault
        matches = fault and path.endswith(fault["suffix"]) and fault.get("remaining", 1) > 0
        if matches:
            fault["remaining"] = fault.get("remaining", 1) - 1
            entry["fault"] = fault["kind"]
            if fault["kind"] == "status":
                await send({"type": "http.response.start", "status": fault["status"],
                    "headers": [(b"content-type", b"application/json"),
                                (b"retry-after", str(fault.get("retry_after", 0)).encode())]})
                await send({"type": "http.response.body", "body": b'{"detail":"E2E proxy fault"}'})
                return
            if fault["kind"] == "hold":
                while self.fault is fault:
                    await asyncio.sleep(0.02)
            if fault["kind"] == "drop":
                # Let the real queue commit a command delivery, but withhold
                # its response so the client must recover an unacknowledged lease.
                frames = []

                async def retain(message):
                    frames.append(message)

                await self.app(scope, receive, retain)
                body = b"".join(frame.get("body", b"") for frame in frames)
                headers = dict(next(frame for frame in frames if frame["type"] == "http.response.start")["headers"])
                if headers.get(b"content-encoding") == b"gzip":
                    body = gzip.decompress(body)
                entry["response"] = json.loads(body)
                entry["response_committed"] = True
                while self.fault is fault:
                    await asyncio.sleep(0.02)
                for frame in frames:
                    await send(frame)
                return
        await self.app(scope, receive, send)
