from __future__ import annotations

import base64

from relay.daemon_registry.artifacts import (
    daemon_reported_generated_files,
    is_produced_file_path,
    is_snapshotable_path,
)


def test_candidacy_accepts_any_path_but_never_a_credential_name() -> None:
    assert is_produced_file_path("src/main.py")
    assert is_produced_file_path("checkout/README.md")
    assert is_produced_file_path("report.md")
    assert not is_produced_file_path(".env")
    assert not is_produced_file_path("config/.env.local")
    assert not is_produced_file_path("deploy/credentials.json")
    assert not is_produced_file_path("keys/private_key.pem")


def test_storage_allowlist_is_unchanged_by_the_wider_candidacy() -> None:
    # Documents and binaries anywhere.
    assert is_snapshotable_path("decks/quarterly.pptx")
    assert is_snapshotable_path("chart.png")
    # Text documents only near a workspace root.
    assert is_snapshotable_path("report.md")
    assert is_snapshotable_path("output/summary.txt")
    assert not is_snapshotable_path("checkout/README.md")
    # Source is never storable.
    assert not is_snapshotable_path("src/main.py")


def _raw(relative: str, *, content: bytes | None = None, skipped: str | None = None) -> dict:
    raw: dict = {"relativePath": relative, "title": relative.split("/")[-1], "bytes": 12, "contentType": "text/plain"}
    if content is not None:
        raw["contentBase64"] = base64.b64encode(content).decode("ascii")
    if skipped is not None:
        raw["snapshotSkipped"] = skipped
    return raw


def test_produced_files_capability_widens_which_reports_are_indexed() -> None:
    raw = [_raw("src/main.py", skipped="not-snapshotable-type"), _raw("report.md", content=b"# Report")]

    narrow = daemon_reported_generated_files("/ws", raw)
    assert [item["relativePath"] for item in narrow] == ["report.md"]

    wide = daemon_reported_generated_files("/ws", raw, produced_files=True)
    assert [item["relativePath"] for item in wide] == ["src/main.py", "report.md"]
    assert wide[0]["content"] is None
    assert wide[0]["snapshotSkipped"] == "not-snapshotable-type"
    assert wide[1]["content"] == b"# Report"
    assert wide[1]["snapshotSkipped"] is None


def test_content_for_a_non_snapshotable_path_is_discarded() -> None:
    # A daemon must not be able to widen what the backend stores by sending
    # bytes for a path the storage allowlist rejects.
    raw = [_raw("src/main.py", content=b"print('hi')")]
    items = daemon_reported_generated_files("/ws", raw, produced_files=True)
    assert items[0]["content"] is None
    assert items[0]["snapshotSkipped"] == "not-snapshotable-type"


def test_a_credential_named_file_is_dropped_even_when_reported() -> None:
    raw = [_raw("deploy/credentials.json", content=b"{}"), _raw("report.md", content=b"ok")]
    items = daemon_reported_generated_files("/ws", raw, produced_files=True)
    assert [item["relativePath"] for item in items] == ["report.md"]


def test_an_unknown_skip_reason_is_normalised_away() -> None:
    raw = [_raw("src/main.py", skipped="because-i-said-so")]
    items = daemon_reported_generated_files("/ws", raw, produced_files=True)
    # The backend re-derives the reason it can prove rather than echoing input.
    assert items[0]["snapshotSkipped"] == "not-snapshotable-type"


def test_a_private_key_filename_earns_no_record_at_all() -> None:
    raw = [_raw("deploy/id_rsa", content=b"-----BEGIN")]
    items = daemon_reported_generated_files("/ws", raw, produced_files=True)
    assert items == []
