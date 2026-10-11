"""An in-memory BlobStore for tests that should not need R2."""

from __future__ import annotations


class MemoryBlobStore:
    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}
        self.puts: list[str] = []

    def put(self, key: str, data: bytes, *, content_type: str | None) -> None:
        self.puts.append(key)
        self.blobs[key] = data

    def get(self, key: str) -> bytes | None:
        return self.blobs.get(key)

    def exists(self, key: str) -> bool:
        return key in self.blobs

    def delete(self, key: str) -> None:
        self.blobs.pop(key, None)

    def delete_prefix(self, prefix: str) -> None:
        for key in [k for k in self.blobs if k.startswith(prefix)]:
            del self.blobs[key]
