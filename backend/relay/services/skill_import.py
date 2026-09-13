"""Fenced, in-memory import of skill bundles from supported Git providers."""

from __future__ import annotations

import gzip
import http.client
import io
import ipaddress
import socket
import ssl
import tarfile
import time
from collections.abc import Iterable, Iterator
from pathlib import PurePosixPath
from queue import Empty, Queue
from threading import BoundedSemaphore, Thread, Timer
from urllib.parse import quote, urlsplit

MAX_FILES = 300
MAX_FILE_BYTES = 1024 * 1024
MAX_BUNDLE_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 1000
MAX_EXPANDED_ARCHIVE_BYTES = 64 * 1024 * 1024
_DNS_SLOTS = BoundedSemaphore(4)


class SkillImportError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def fetch_skill_bundle(
    url: str,
    ref: str,
    subpath: str,
    *,
    allowed_hosts: list[str],
    timeout_seconds: float = 30.0,
) -> list[dict[str, object]]:
    """Download a GitHub tarball and return the selected skill files in memory."""
    owner, repository = _validate_repository_url(url, allowed_hosts)
    safe_ref = _validate_ref(ref)
    selected_path = _validate_subpath(subpath)
    if timeout_seconds <= 0:
        raise SkillImportError("timeout", "Import deadline expired")
    deadline = time.monotonic() + timeout_seconds

    download_host = "codeload.github.com"
    download_url = f"https://{download_host}/{owner}/{repository}/tar.gz/{quote(safe_ref, safe='/')}"
    try:
        addresses = _resolve_before_deadline(download_host, deadline)
    except (OSError, socket.gaierror) as error:
        raise SkillImportError("network-error", "Could not resolve download host") from error
    if not addresses:
        raise SkillImportError("network-error", "Download host did not resolve")
    for address in addresses:
        try:
            parsed_address = ipaddress.ip_address(address)
        except ValueError as error:
            raise SkillImportError("network-error", "Download host returned an invalid address") from error
        if not parsed_address.is_global:
            raise SkillImportError("unsafe-address", "Download host resolved to a non-global address")

    _check_deadline(deadline)
    try:
        status, headers, chunks = _download_archive(download_url, addresses[0], deadline)
        if 300 <= status < 400:
            _close_stream(chunks)
            raise SkillImportError("redirect-rejected", "Archive redirects are not followed")
        if status != 200:
            _close_stream(chunks)
            raise SkillImportError("download-failed", f"Archive download returned HTTP {status}")
        content_length = headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError:
                declared_length = 0
            if declared_length > MAX_ARCHIVE_BYTES:
                _close_stream(chunks)
                raise SkillImportError("archive-too-large", "Compressed archive exceeds the size limit")
        archive = bytearray()
        try:
            for chunk in chunks:
                _check_deadline(deadline)
                archive.extend(chunk)
                if len(archive) > MAX_ARCHIVE_BYTES:
                    raise SkillImportError("archive-too-large", "Compressed archive exceeds the size limit")
        finally:
            _close_stream(chunks)
    except SkillImportError:
        raise
    except TimeoutError as error:
        raise SkillImportError("timeout", "Import deadline expired") from error
    except (OSError, http.client.HTTPException, ssl.SSLError) as error:
        _check_deadline(deadline)
        raise SkillImportError("network-error", "Archive download failed") from error

    return _read_bundle(bytes(archive), selected_path, deadline)


def _resolve_before_deadline(host: str, deadline: float) -> list[str]:
    # OS DNS calls have no portable cancellation API. Bound both their caller's
    # wait and the number of outstanding resolver threads.
    if not _DNS_SLOTS.acquire(timeout=max(0, deadline - time.monotonic())):
        raise SkillImportError("timeout", "Import deadline expired")
    result: Queue[tuple[list[str] | None, Exception | None]] = Queue(maxsize=1)
    def resolve() -> None:
        try:
            result.put((_resolve_host(host), None))
        except Exception as error:  # noqa: BLE001 - propagate resolver failures to the caller thread.
            result.put((None, error))
        finally:
            _DNS_SLOTS.release()
    Thread(target=resolve, daemon=True, name="skill-import-dns").start()
    try:
        addresses, error = result.get(timeout=max(0, deadline - time.monotonic()))
    except Empty as error:
        raise SkillImportError("timeout", "Import deadline expired") from error
    if error is not None:
        raise error
    _check_deadline(deadline)
    return addresses or []


def _validate_repository_url(url: str, allowed_hosts: list[str]) -> tuple[str, str]:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise SkillImportError("invalid-url", "Invalid repository URL") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SkillImportError("invalid-url", "Repository URL must be plain HTTPS without credentials, port, query, or fragment")
    host = parsed.hostname.rstrip(".").lower()
    allowed = {item.rstrip(".").lower() for item in allowed_hosts}
    if host not in allowed:
        raise SkillImportError("host-not-allowed", "Repository host is not allowed")
    if host != "github.com":
        raise SkillImportError("unsupported-provider", "Only github.com imports are supported")
    parts = parsed.path.strip("/").split("/")
    if len(parts) != 2 or not all(_safe_component(part) for part in parts):
        raise SkillImportError("invalid-repository", "Expected a GitHub owner/repository URL")
    owner, repository = parts
    repository = repository.removesuffix(".git")
    if not repository or not _safe_component(repository):
        raise SkillImportError("invalid-repository", "Invalid GitHub repository name")
    return owner, repository


def _safe_component(value: str) -> bool:
    return bool(value) and value not in {".", ".."} and all(
        character.isascii() and (character.isalnum() or character in "._-") for character in value
    )


def _validate_ref(ref: str) -> str:
    if not ref or ref.startswith("/") or "//" in ref or any(part in {"", ".", ".."} for part in ref.split("/")):
        raise SkillImportError("invalid-ref", "Invalid Git ref")
    if not all(character.isascii() and (character.isalnum() or character in "._/-") for character in ref):
        raise SkillImportError("invalid-ref", "Invalid Git ref")
    return ref


def _validate_subpath(subpath: str) -> PurePosixPath:
    if not subpath:
        return PurePosixPath()
    if subpath.startswith("/") or "//" in subpath:
        raise SkillImportError("invalid-subpath", "Invalid skill subpath")
    parts = subpath.split("/")
    if any(
        part in {"", ".", ".."}
        or not all(character.isascii() and (character.isalnum() or character in "._- ") for character in part)
        for part in parts
    ):
        raise SkillImportError("invalid-subpath", "Invalid skill subpath")
    return PurePosixPath(*parts)


def _read_bundle(data: bytes, selected_path: PurePosixPath, deadline: float) -> list[dict[str, object]]:
    files: list[dict[str, object]] = []
    selected_bytes = 0
    expanded_bytes = 0
    archive_root: str | None = None
    try:
        expanded = bytearray()
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
            while chunk := compressed.read(64 * 1024):
                _check_deadline(deadline)
                if len(expanded) + len(chunk) > MAX_EXPANDED_ARCHIVE_BYTES:
                    raise SkillImportError("archive-too-large", "Expanded archive exceeds the size limit")
                expanded.extend(chunk)
        with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
            for entry_count, member in enumerate(archive, start=1):
                _check_deadline(deadline)
                if entry_count > MAX_ARCHIVE_ENTRIES:
                    raise SkillImportError("archive-too-large", "Archive contains too many entries")
                member_path = _safe_archive_path(member.name)
                if archive_root is None:
                    archive_root = member_path.parts[0]
                elif member_path.parts[0] != archive_root:
                    raise SkillImportError("unsafe-archive", "Archive contains more than one root")
                if not (member.isdir() or member.isreg()):
                    raise SkillImportError("unsafe-archive", "Archive contains a link or special file")
                if member.isreg():
                    expanded_bytes += member.size
                    if expanded_bytes > MAX_EXPANDED_ARCHIVE_BYTES:
                        raise SkillImportError("archive-too-large", "Expanded archive exceeds the size limit")
                relative = PurePosixPath(*member_path.parts[1:])
                if member.isdir() or not _is_beneath(relative, selected_path):
                    continue
                output_path = relative.relative_to(selected_path).as_posix()
                if not output_path or output_path == ".":
                    continue
                if member.size > MAX_FILE_BYTES:
                    raise SkillImportError("file-too-large", f"Imported file exceeds 1 MiB: {output_path}")
                if len(files) >= MAX_FILES:
                    raise SkillImportError("too-many-files", "Skill bundle exceeds 300 files")
                selected_bytes += member.size
                if selected_bytes > MAX_BUNDLE_BYTES:
                    raise SkillImportError("bundle-too-large", "Skill bundle exceeds 4 MiB")
                source = archive.extractfile(member)
                if source is None:
                    raise SkillImportError("unsafe-archive", "Could not read archive member")
                content = source.read(MAX_FILE_BYTES + 1)
                if len(content) != member.size or len(content) > MAX_FILE_BYTES:
                    raise SkillImportError("file-too-large", f"Imported file exceeds 1 MiB: {output_path}")
                files.append({"path": output_path, "content": content})
    except SkillImportError:
        raise
    except (tarfile.TarError, OSError, EOFError) as error:
        raise SkillImportError("invalid-archive", "Downloaded content is not a valid gzip tar archive") from error
    files.sort(key=lambda item: str(item["path"]))
    return files


def _safe_archive_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise SkillImportError("unsafe-archive", "Archive contains an unsafe path")
    return path


def _is_beneath(path: PurePosixPath, parent: PurePosixPath) -> bool:
    if not parent.parts:
        return True
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise SkillImportError("timeout", "Import deadline expired")


def _close_stream(chunks: Iterable[bytes]) -> None:
    close = getattr(chunks, "close", None)
    if callable(close):
        close()


def _resolve_host(host: str) -> list[str]:
    addresses = {entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    return sorted(addresses)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, address: str, timeout: float):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self) -> None:
        raw_socket = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)


class _ResponseChunks(Iterator[bytes]):
    def __init__(self, connection: http.client.HTTPSConnection, response: http.client.HTTPResponse, deadline: float, timer: Timer | None = None, transport_socket=None):
        self._connection = connection
        self._response = response
        self._deadline = deadline
        self._closed = False
        self._timer = timer
        self._socket = transport_socket or connection.sock

    def __iter__(self) -> _ResponseChunks:
        return self

    def __next__(self) -> bytes:
        if self._closed:
            raise StopIteration
        _check_deadline(self._deadline)
        if self._socket is not None:
            self._socket.settimeout(max(0.001, self._deadline - time.monotonic()))
        chunk = self._response.read1(64 * 1024)
        _check_deadline(self._deadline)
        if chunk:
            return chunk
        self.close()
        raise StopIteration

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            if self._timer:
                self._timer.cancel()
            self._connection.close()


def _download_archive(url: str, address: str, deadline: float) -> tuple[int, dict[str, str], Iterable[bytes]]:
    parsed = urlsplit(url)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SkillImportError("timeout", "Import deadline expired")
    connection = _PinnedHTTPSConnection(parsed.hostname or "", address, remaining)
    transport_socket = None

    def expire():
        # A socket's timeout is an idle timeout; a trickling peer can evade it.
        # Interrupt even a blocking header/body read at the absolute deadline.
        sock = transport_socket or connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    timer = Timer(remaining, expire)
    timer.daemon = True
    timer.start()
    try:
        connection.request("GET", parsed.path, headers={"Accept": "application/x-gzip", "User-Agent": "Relay/skill-import"})
        transport_socket = connection.sock
        response = connection.getresponse()
        _check_deadline(deadline)
    except Exception:
        timer.cancel()
        connection.close()
        _check_deadline(deadline)
        raise
    return response.status, {key.lower(): value for key, value in response.getheaders()}, _ResponseChunks(connection, response, deadline, timer, transport_socket)
