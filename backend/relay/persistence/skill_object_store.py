from __future__ import annotations

import hashlib
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Protocol


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class SkillObjectStore(Protocol):
    """Content-addressed storage for immutable skill bundle objects."""

    def put(self, digest: str, content: bytes) -> None: ...

    def get(self, digest: str) -> bytes | None: ...

    def exists(self, digest: str) -> bool: ...


class LocalSkillObjectStore:
    """Filesystem-backed object storage, replaceable by an object-store adapter."""

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def path_for(self, digest: str) -> Path:
        _validate_digest(digest)
        return self.root / digest[:2] / digest[2:]

    def put(self, digest: str, content: bytes) -> None:
        _validate_digest(digest)
        if not isinstance(content, bytes):
            raise TypeError("skill object content must be bytes")
        if not hashlib.sha256(content).hexdigest() == digest:
            raise ValueError("skill object digest does not match content")
        destination = self.path_for(digest)
        if destination.exists() or destination.is_symlink():
            self._verify(destination, digest)
            return
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{digest}.", dir=destination.parent
        )
        temporary = Path(temporary_name)
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                temporary.unlink()

    def get(self, digest: str) -> bytes | None:
        path = self.path_for(digest)
        if not path.exists() and not path.is_symlink():
            return None
        self._ensure_regular(path)
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise OSError(f"skill object {digest} failed digest verification")
        return content

    def exists(self, digest: str) -> bool:
        path = self.path_for(digest)
        if not path.exists() and not path.is_symlink():
            return False
        self._ensure_regular(path)
        return True

    @staticmethod
    def _verify(path: Path, digest: str) -> None:
        LocalSkillObjectStore._ensure_regular(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise OSError(f"skill object {digest} failed digest verification")

    @staticmethod
    def _ensure_regular(path: Path) -> None:
        if path.is_symlink() or not stat.S_ISREG(path.lstat().st_mode):
            raise OSError(f"skill object path is not a regular file: {path}")


def _validate_digest(digest: str) -> None:
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise ValueError("invalid skill object digest")
