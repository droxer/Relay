"""relay backup-database: pg_dump the database into an R2 bucket."""

from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from relay.persistence import blob_store as blob_store_module
from relay.persistence.database_backup import (
    backup_database,
    backup_keys,
    backup_target_from_env,
    pg_env_from_url,
)

URL = "postgresql+psycopg://relay:s3cret%40pw@db.internal:6543/relay_prod?sslmode=require"
JUNE_2 = datetime(2026, 6, 2, 3, 0, 5, tzinfo=timezone.utc)
JULY_1 = datetime(2026, 7, 1, 3, 0, 5, tzinfo=timezone.utc)


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.copies: list[tuple[str, str]] = []

    def upload_file(self, Filename: str, Bucket: str, Key: str, ExtraArgs: dict | None = None) -> None:
        self.objects[Key] = Path(Filename).read_bytes()

    def copy_object(self, *, Bucket: str, Key: str, CopySource: dict[str, str]) -> None:
        self.copies.append((CopySource["Key"], Key))
        self.objects[Key] = self.objects[CopySource["Key"]]


class FakeRunner:
    """Stands in for subprocess.run: pg_dump writes a file, pg_restore lists it."""

    def __init__(self, *, dump_rc: int = 0, dump_bytes: bytes = b"PGDMP fake archive", list_rc: int = 0):
        self.dump_rc, self.dump_bytes, self.list_rc = dump_rc, dump_bytes, list_rc
        self.calls: list[tuple[list[str], dict[str, str]]] = []

    def __call__(self, argv: list[str], *, env: dict[str, str], capture_output: bool, text: bool, check: bool) -> Any:
        self.calls.append((argv, env))
        if argv[0] == "pg_dump":
            target = next(arg.split("=", 1)[1] for arg in argv if arg.startswith("--file="))
            Path(target).write_bytes(self.dump_bytes)
            return subprocess.CompletedProcess(argv, self.dump_rc, "", "dump failed" if self.dump_rc else "")
        return subprocess.CompletedProcess(argv, self.list_rc, "", "bad archive" if self.list_rc else "")


def test_connection_details_travel_in_the_environment_not_argv() -> None:
    env = pg_env_from_url(URL)
    assert env == {
        "PGHOST": "db.internal",
        "PGPORT": "6543",
        "PGUSER": "relay",
        "PGPASSWORD": "s3cret@pw",
        "PGDATABASE": "relay_prod",
        "PGSSLMODE": "require",
    }


def test_non_postgres_urls_are_rejected() -> None:
    with pytest.raises(RuntimeError, match="Postgres"):
        pg_env_from_url("sqlite:///relay.db")


def test_keys_are_daily_with_a_monthly_copy_on_the_first() -> None:
    assert backup_keys(JUNE_2) == ("daily/relay-20260602T030005Z.dump", None)
    assert backup_keys(JULY_1) == (
        "daily/relay-20260701T030005Z.dump",
        "monthly/relay-20260701T030005Z.dump",
    )


def test_successful_backup_uploads_the_validated_archive() -> None:
    s3, runner = FakeS3(), FakeRunner()

    report = backup_database(URL, s3, "relay-backups", now=JUNE_2, run=runner)

    assert report == {
        "bucket": "relay-backups",
        "key": "daily/relay-20260602T030005Z.dump",
        "monthlyKey": None,
        "bytes": len(b"PGDMP fake archive"),
    }
    assert s3.objects == {"daily/relay-20260602T030005Z.dump": b"PGDMP fake archive"}
    dump_argv, dump_env = runner.calls[0]
    assert dump_argv[:3] == ["pg_dump", "--format=custom", "--no-owner"]
    assert "s3cret@pw" not in " ".join(dump_argv)
    assert dump_env["PGPASSWORD"] == "s3cret@pw"
    assert runner.calls[1][0][:2] == ["pg_restore", "--list"]


def test_first_of_the_month_also_keeps_a_monthly_copy() -> None:
    s3 = FakeS3()
    report = backup_database(URL, s3, "relay-backups", now=JULY_1, run=FakeRunner())
    assert report["monthlyKey"] == "monthly/relay-20260701T030005Z.dump"
    assert s3.copies == [("daily/relay-20260701T030005Z.dump", "monthly/relay-20260701T030005Z.dump")]


@pytest.mark.parametrize(
    "runner, message",
    [
        (FakeRunner(dump_rc=1), "pg_dump failed"),
        (FakeRunner(dump_bytes=b""), "empty"),
        (FakeRunner(list_rc=1), "pg_restore"),
    ],
)
def test_a_bad_dump_uploads_nothing(runner, message) -> None:
    s3 = FakeS3()
    with pytest.raises(RuntimeError, match=message):
        backup_database(URL, s3, "relay-backups", now=JUNE_2, run=runner)
    assert s3.objects == {}


def test_a_failure_does_not_echo_the_password() -> None:
    with pytest.raises(RuntimeError) as error:
        backup_database(URL, FakeS3(), "relay-backups", now=JUNE_2, run=FakeRunner(dump_rc=1))
    assert "s3cret" not in str(error.value)


class TestTargetFromEnv:
    @pytest.fixture(autouse=True)
    def env(self, monkeypatch) -> None:
        for name in (
            "RELAY_BACKUP_R2_BUCKET", "RELAY_BACKUP_R2_ACCESS_KEY_ID", "RELAY_BACKUP_R2_SECRET_ACCESS_KEY",
            "RELAY_R2_ACCOUNT_ID", "RELAY_R2_ACCESS_KEY_ID", "RELAY_R2_SECRET_ACCESS_KEY", "RELAY_R2_ENDPOINT",
        ):
            monkeypatch.delenv(name, raising=False)

    def test_bucket_is_required(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_R2_ACCOUNT_ID", "acct")
        with pytest.raises(RuntimeError, match="RELAY_BACKUP_R2_BUCKET"):
            backup_target_from_env()

    def test_backup_keys_win_over_the_shared_r2_keys(self, monkeypatch) -> None:
        calls: list[dict[str, str]] = []
        monkeypatch.setattr(blob_store_module, "_s3_client", lambda **kwargs: calls.append(kwargs) or FakeS3())
        monkeypatch.setenv("RELAY_R2_ACCOUNT_ID", "acct")
        monkeypatch.setenv("RELAY_R2_ACCESS_KEY_ID", "shared-id")
        monkeypatch.setenv("RELAY_R2_SECRET_ACCESS_KEY", "shared-secret")
        monkeypatch.setenv("RELAY_BACKUP_R2_BUCKET", "relay-backups")
        monkeypatch.setenv("RELAY_BACKUP_R2_ACCESS_KEY_ID", "backup-id")
        monkeypatch.setenv("RELAY_BACKUP_R2_SECRET_ACCESS_KEY", "backup-secret")

        _client, bucket = backup_target_from_env()

        assert bucket == "relay-backups"
        assert calls == [{
            "endpoint_url": "https://acct.r2.cloudflarestorage.com",
            "access_key_id": "backup-id",
            "secret_access_key": "backup-secret",
        }]

    def test_falls_back_to_the_shared_r2_keys(self, monkeypatch) -> None:
        calls: list[dict[str, str]] = []
        monkeypatch.setattr(blob_store_module, "_s3_client", lambda **kwargs: calls.append(kwargs) or FakeS3())
        monkeypatch.setenv("RELAY_R2_ACCOUNT_ID", "acct")
        monkeypatch.setenv("RELAY_R2_ACCESS_KEY_ID", "shared-id")
        monkeypatch.setenv("RELAY_R2_SECRET_ACCESS_KEY", "shared-secret")
        monkeypatch.setenv("RELAY_BACKUP_R2_BUCKET", "relay-backups")
        backup_target_from_env()
        assert calls[0]["access_key_id"] == "shared-id"

    def test_missing_credentials_are_named(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_BACKUP_R2_BUCKET", "relay-backups")
        with pytest.raises(RuntimeError) as error:
            backup_target_from_env()
        assert "RELAY_R2_ACCOUNT_ID" in str(error.value)
        assert "ACCESS_KEY_ID" in str(error.value)


LOCAL_POSTGRES = os.environ.get("RELAY_TEST_DATABASE_URL") or "postgresql+psycopg://relay:relay@localhost:5432/relay"


@pytest.mark.postgres
def test_real_pg_dump_produces_a_restorable_archive(tmp_path) -> None:
    if not shutil.which("pg_dump") or not shutil.which("pg_restore"):
        pytest.skip("pg_dump/pg_restore not installed")
    probe = subprocess.run(
        ["psql", "-Atc", "select 1"], env={**os.environ, **pg_env_from_url(LOCAL_POSTGRES)},
        capture_output=True, text=True, check=False,
    ) if shutil.which("psql") else None
    if probe is None or probe.returncode != 0:
        pytest.skip("local Postgres not reachable")
    s3 = FakeS3()

    report = backup_database(LOCAL_POSTGRES, s3, "relay-backups", now=JUNE_2)

    archive = tmp_path / "restored.dump"
    archive.write_bytes(s3.objects[report["key"]])
    listing = subprocess.run(["pg_restore", "--list", str(archive)], capture_output=True, text=True, check=False)
    assert listing.returncode == 0
    assert report["bytes"] > 0
