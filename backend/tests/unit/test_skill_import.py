from __future__ import annotations

import http.client
import io
import socket
import tarfile
import threading
import time
from types import SimpleNamespace

import pytest
from relay.services import skill_import
from relay.services.skill_import import SkillImportError, fetch_skill_bundle


def test_deadline_includes_dns_resolution(monkeypatch):
    release = threading.Event()
    def resolve(host):
        release.wait(1)
        return ["140.82.112.10"]
    monkeypatch.setattr(skill_import, "_resolve_host", resolve)
    started = time.monotonic()
    try:
        assert _error_code(lambda: fetch_skill_bundle(
            "https://github.com/acme/tools", "main", "",
            allowed_hosts=["github.com"], timeout_seconds=0.05,
        )) == "timeout"
        assert time.monotonic() - started < 0.3
    finally:
        release.set()


def test_response_reads_only_available_data_with_remaining_deadline():
    timeouts = []
    response = SimpleNamespace(read1=lambda size: b"chunk", read=lambda size: pytest.fail("read can wait for a whole block"))
    connection = SimpleNamespace(sock=SimpleNamespace(settimeout=timeouts.append), close=lambda: None)
    chunks = skill_import._ResponseChunks(connection, response, time.monotonic() + 0.5)
    assert next(chunks) == b"chunk"
    assert 0 < timeouts[0] <= 0.5


def test_transport_timeout_is_reported_as_timeout(monkeypatch):
    monkeypatch.setattr(skill_import, "_resolve_host", lambda host: ["140.82.112.10"])
    def timeout(*args):
        raise TimeoutError("slow peer")
    monkeypatch.setattr(skill_import, "_download_archive", timeout)
    assert _error_code(lambda: fetch_skill_bundle("https://github.com/acme/tools", "main", "", allowed_hosts=["github.com"])) == "timeout"


def test_absolute_deadline_interrupts_trickling_http_headers(monkeypatch):
    reader, writer = socket.socketpair()
    class Connection:
        sock = reader
        def __init__(self, *args):
            pass
        def request(self, *args, **kwargs):
            pass
        def getresponse(self):
            response = http.client.HTTPResponse(reader)
            response.begin()
            return response
        def close(self):
            reader.close()
    def trickle():
        try:
            for byte in b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n":
                writer.send(bytes([byte]))
                time.sleep(0.01)
        except OSError:
            pass
        finally:
            writer.close()
    thread = threading.Thread(target=trickle, daemon=True)
    monkeypatch.setattr(skill_import, "_PinnedHTTPSConnection", Connection)
    thread.start()
    start = time.monotonic()
    try:
        with pytest.raises(SkillImportError, match="Import deadline expired"):
            skill_import._download_archive("https://codeload.github.com/a/b", "140.82.112.10", start + 0.05)
        assert time.monotonic() - start < 0.3
    finally:
        reader.close()
        thread.join(timeout=1)


def test_compressed_metadata_cannot_bypass_expansion_limit(monkeypatch):
    import gzip
    # Tar's PAX/header parsing must not receive unbounded decompressed bytes.
    monkeypatch.setattr(skill_import, "MAX_EXPANDED_ARCHIVE_BYTES", 2048)
    data = gzip.compress(b"\0" * 16384)
    _install_network(monkeypatch, data)
    assert _error_code(lambda: fetch_skill_bundle("https://github.com/acme/tools", "main", "", allowed_hosts=["github.com"])) == "archive-too-large"


def _archive(entries: list[tuple[str, bytes | None, str]]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "file":
                payload = content or b""
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            elif kind == "dir":
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "target"
                archive.addfile(info)
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = "root-main/SKILL.md"
                archive.addfile(info)
            elif kind == "fifo":
                info.type = tarfile.FIFOTYPE
                archive.addfile(info)
    return output.getvalue()


def _install_network(monkeypatch: pytest.MonkeyPatch, archive: bytes, *, addresses: list[str] | None = None):
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(skill_import, "_resolve_host", lambda host: addresses or ["140.82.112.10"])

    def download(url: str, address: str, deadline: float):
        calls.append((url, address))
        return 200, {}, iter([archive[:7], archive[7:]])

    monkeypatch.setattr(skill_import, "_download_archive", download)
    return calls


def _fetch(monkeypatch: pytest.MonkeyPatch, entries: list[tuple[str, bytes | None, str]], **kwargs):
    _install_network(monkeypatch, _archive(entries))
    ref = kwargs.pop("ref", "main")
    subpath = kwargs.pop("subpath", "skills/review")
    return fetch_skill_bundle(
        "https://github.com/acme/tools",
        ref,
        subpath,
        allowed_hosts=["github.com"],
        **kwargs,
    )


def _error_code(call) -> str:
    with pytest.raises(SkillImportError) as caught:
        call()
    return caught.value.code


def test_imports_only_selected_subpath_and_strips_archive_prefix(monkeypatch: pytest.MonkeyPatch):
    calls = _install_network(
        monkeypatch,
        _archive([
            ("tools-main/skills/review/SKILL.md", b"skill", "file"),
            ("tools-main/skills/review/docs/guide.md", b"guide", "file"),
            ("tools-main/other/ignored.txt", b"ignored", "file"),
        ]),
    )
    files = fetch_skill_bundle(
        "https://github.com/acme/tools", "main", "skills/review", allowed_hosts=["github.com"]
    )
    assert files == [
        {"path": "SKILL.md", "content": b"skill"},
        {"path": "docs/guide.md", "content": b"guide"},
    ]
    assert calls == [("https://codeload.github.com/acme/tools/tar.gz/main", "140.82.112.10")]


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("http://github.com/acme/tools", "invalid-url"),
        ("https://user@github.com/acme/tools", "invalid-url"),
        ("https://github.com:443/acme/tools", "invalid-url"),
        ("https://github.com/acme/tools?q=x", "invalid-url"),
        ("https://github.com/acme/tools#x", "invalid-url"),
        ("https://github.com.evil/acme/tools", "host-not-allowed"),
        ("https://gitlab.com/acme/tools", "unsupported-provider"),
        ("https://github.com/acme/tools/extra", "invalid-repository"),
    ],
)
def test_rejects_unsafe_or_unsupported_repository_urls(monkeypatch: pytest.MonkeyPatch, url: str, code: str):
    monkeypatch.setattr(skill_import, "_resolve_host", lambda host: pytest.fail("must not resolve"))
    assert _error_code(lambda: fetch_skill_bundle(url, "main", "", allowed_hosts=["github.com", "gitlab.com"])) == code


@pytest.mark.parametrize("value", ["../main", "/main", "main?x", "main#x", "main//x"])
def test_rejects_unsafe_refs(monkeypatch: pytest.MonkeyPatch, value: str):
    assert _error_code(lambda: _fetch(monkeypatch, [], ref=value)) == "invalid-ref"


@pytest.mark.parametrize("value", ["../secret", "/root", "skills/../../secret", "skills//review"])
def test_rejects_unsafe_subpaths(monkeypatch: pytest.MonkeyPatch, value: str):
    assert _error_code(lambda: _fetch(monkeypatch, [], subpath=value)) == "invalid-subpath"


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.1.1", "::1", "fc00::1"])
def test_rejects_non_global_download_addresses(monkeypatch: pytest.MonkeyPatch, address: str):
    monkeypatch.setattr(skill_import, "_resolve_host", lambda host: [address])
    monkeypatch.setattr(skill_import, "_download_archive", lambda *args: pytest.fail("must not connect"))
    assert _error_code(
        lambda: fetch_skill_bundle("https://github.com/acme/tools", "main", "", allowed_hosts=["github.com"])
    ) == "unsafe-address"


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "fifo"])
def test_rejects_special_archive_members(monkeypatch: pytest.MonkeyPatch, kind: str):
    assert _error_code(
        lambda: _fetch(monkeypatch, [("tools-main/skills/review/bad", None, kind)])
    ) == "unsafe-archive"


@pytest.mark.parametrize("name", ["/absolute", "../escape", "tools-main/../../escape"])
def test_rejects_absolute_and_traversing_members(monkeypatch: pytest.MonkeyPatch, name: str):
    assert _error_code(lambda: _fetch(monkeypatch, [(name, b"x", "file")])) == "unsafe-archive"


def test_enforces_selected_file_and_bundle_caps(monkeypatch: pytest.MonkeyPatch):
    assert _error_code(
        lambda: _fetch(monkeypatch, [("tools-main/skills/review/big", b"x" * (1024 * 1024 + 1), "file")])
    ) == "file-too-large"
    entries = [(f"tools-main/skills/review/{index}", b"x", "file") for index in range(301)]
    assert _error_code(lambda: _fetch(monkeypatch, entries)) == "too-many-files"
    entries = [(f"tools-main/skills/review/{index}", b"x" * (1024 * 1024), "file") for index in range(5)]
    assert _error_code(lambda: _fetch(monkeypatch, entries)) == "bundle-too-large"


def test_counts_unselected_entries_and_expanded_bytes(monkeypatch: pytest.MonkeyPatch):
    entries = [(f"tools-main/other/{index}", b"x", "file") for index in range(1001)]
    assert _error_code(lambda: _fetch(monkeypatch, entries)) == "archive-too-large"

    monkeypatch.setattr(skill_import, "MAX_EXPANDED_ARCHIVE_BYTES", 2)
    entries = [("tools-main/other/a", b"xx", "file"), ("tools-main/other/b", b"x", "file")]
    assert _error_code(lambda: _fetch(monkeypatch, entries)) == "archive-too-large"


def test_rejects_oversized_compressed_stream_and_redirect(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(skill_import, "MAX_ARCHIVE_BYTES", 8)
    _install_network(monkeypatch, b"123456789")
    assert _error_code(
        lambda: fetch_skill_bundle("https://github.com/acme/tools", "main", "", allowed_hosts=["github.com"])
    ) == "archive-too-large"

    monkeypatch.setattr(skill_import, "MAX_ARCHIVE_BYTES", 64 * 1024 * 1024)
    monkeypatch.setattr(skill_import, "_resolve_host", lambda host: ["140.82.112.10"])
    monkeypatch.setattr(skill_import, "_download_archive", lambda *args: (302, {"location": "https://evil"}, iter(())))
    assert _error_code(
        lambda: fetch_skill_bundle("https://github.com/acme/tools", "main", "", allowed_hosts=["github.com"])
    ) == "redirect-rejected"


def test_wraps_dns_and_transport_failures(monkeypatch: pytest.MonkeyPatch):
    def dns_failure(host: str):
        raise socket.gaierror("offline")

    monkeypatch.setattr(skill_import, "_resolve_host", dns_failure)
    assert _error_code(
        lambda: fetch_skill_bundle("https://github.com/acme/tools", "main", "", allowed_hosts=["github.com"])
    ) == "network-error"
