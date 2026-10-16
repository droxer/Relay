"""Password reset: who a request reaches, link lifetime, and what a reset does.

Every scenario runs against both auth stores, because the reset records live
beside whichever one holds the accounts.
"""

from __future__ import annotations

import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from loguru import logger
from relay.notifications.mailer import DeliveryResult, EmailMessage, NullMailer
from relay.security.auth import AccountAuthStore, DatabaseAccountAuthStore
from relay.security.password_resets import ResetThrottle, password_reset_store_for
from relay.services.password_reset import (
    PasswordResetConfig,
    PasswordResetService,
    ResetNotLiveError,
    normalize_reset_identifier,
)

START = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)
WEB = "https://get-relay.cc"
OLD_PASSWORD = "kestrel-vault-7719"
NEW_PASSWORD = "harbor-lantern-5521"
_TOKEN = re.compile(r"#token=([A-Za-z0-9_-]+)")


class FakeMailer:
    def __init__(self, result: DeliveryResult | None = None):
        self.sent: list[EmailMessage] = []
        self.result = result or DeliveryResult("sent")

    def send(self, message: EmailMessage) -> DeliveryResult:
        self.sent.append(message)
        return self.result


class Clock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


@pytest.fixture(params=["file", "database"])
def auth_store(request: pytest.FixtureRequest, tmp_path: Path):
    if request.param == "file":
        return AccountAuthStore(tmp_path / "state")
    return DatabaseAccountAuthStore(f"sqlite:///{tmp_path}/auth.db", create_schema=True)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def mailer() -> FakeMailer:
    return FakeMailer()


@pytest.fixture
def service(auth_store, mailer: FakeMailer, clock: Clock) -> PasswordResetService:
    return PasswordResetService(password_reset_store_for(auth_store), mailer, clock=clock)


def _account(auth_store, username: str = "ada", email: str | None = "Ada@Example.com", **extra):
    return auth_store.create_account(
        username, OLD_PASSWORD, email=email, user_id=extra.pop("user_id", username), **extra
    )


def _token(message: EmailMessage) -> str:
    match = _TOKEN.search(message.text)
    assert match, message.text
    return match.group(1)


def test_a_username_request_emails_a_link_that_resets_the_password(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    account = _account(auth_store)
    session = auth_store.create_session(account["id"])

    service.request("ada", locale=None, web_origin=WEB)

    assert [message.to for message in mailer.sent] == ["Ada@Example.com"]
    message = mailer.sent[0]
    assert "@ada" in message.text
    assert f"{WEB}/reset-password#token=" in message.text
    token = _token(message)
    assert service.lookup(token).account.username == "ada"

    reset = service.complete(token, NEW_PASSWORD)

    assert reset.username == "ada"
    assert auth_store.authenticate("ada", NEW_PASSWORD) is not None
    assert auth_store.authenticate("ada", OLD_PASSWORD) is None
    assert auth_store.get_session_by_token(session["token"]) is None
    with pytest.raises(ResetNotLiveError):
        service.complete(token, "another-quiet-meadow-42")


def test_an_email_request_matches_case_insensitively(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    _account(auth_store)

    service.request(normalize_reset_identifier("  ADA@example.COM "), locale=None, web_origin=WEB)

    assert len(mailer.sent) == 1


@pytest.mark.parametrize("identifier", ["nobody", "nobody@example.com"])
def test_unknown_identifiers_send_nothing(
    service: PasswordResetService, auth_store, mailer: FakeMailer, identifier: str
) -> None:
    _account(auth_store)

    service.request(identifier, locale=None, web_origin=WEB)

    assert mailer.sent == []


def test_an_account_without_an_address_gets_nothing(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    _account(auth_store, email=None)

    service.request("ada", locale=None, web_origin=WEB)

    assert mailer.sent == []


def test_a_deleted_user_gets_nothing_and_their_open_link_dies(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    _account(auth_store)
    service.request("ada", locale=None, web_origin=WEB)
    token = _token(mailer.sent[0])

    auth_store.soft_delete_user(auth_store.resolve_user_id("ada"))
    service.request("ada", locale=None, web_origin=WEB)

    assert len(mailer.sent) == 1
    with pytest.raises(ResetNotLiveError):
        service.lookup(token)
    with pytest.raises(ResetNotLiveError):
        service.complete(token, NEW_PASSWORD)


def test_a_shared_address_reaches_each_account_by_name(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    _account(auth_store, "ada")
    _account(auth_store, "ada-ops", email="ada@example.com", user_id="ada-ops")

    service.request("ada@example.com", locale=None, web_origin=WEB)

    named = sorted(re.search(r"for @([a-z-]+)\.", message.text).group(1) for message in mailer.sent)
    assert named == ["ada", "ada-ops"]
    assert len({_token(message) for message in mailer.sent}) == 2


def test_requests_are_throttled_and_a_newer_link_retires_the_older(
    service: PasswordResetService, auth_store, mailer: FakeMailer, clock: Clock
) -> None:
    _account(auth_store)
    service.request("ada", locale=None, web_origin=WEB)
    first = _token(mailer.sent[0])

    clock.advance(seconds=30)
    service.request("ada", locale=None, web_origin=WEB)
    assert len(mailer.sent) == 1

    clock.advance(seconds=31)
    service.request("ada", locale=None, web_origin=WEB)
    assert len(mailer.sent) == 2
    with pytest.raises(ResetNotLiveError):
        service.lookup(first)
    assert service.lookup(_token(mailer.sent[1])).account.username == "ada"


def test_the_hourly_cap_holds(auth_store, mailer: FakeMailer, clock: Clock) -> None:
    config = PasswordResetConfig(
        throttle=ResetThrottle(min_interval=timedelta(0), max_per_hour=2)
    )
    service = PasswordResetService(
        password_reset_store_for(auth_store), mailer, config=config, clock=clock
    )
    _account(auth_store)

    for _ in range(4):
        service.request("ada", locale=None, web_origin=WEB)
        clock.advance(minutes=1)
    assert len(mailer.sent) == 2

    clock.advance(hours=1)
    service.request("ada", locale=None, web_origin=WEB)
    assert len(mailer.sent) == 3


def test_an_expired_link_is_dead(
    service: PasswordResetService, auth_store, mailer: FakeMailer, clock: Clock
) -> None:
    _account(auth_store)
    service.request("ada", locale=None, web_origin=WEB)
    token = _token(mailer.sent[0])

    clock.advance(minutes=30)

    with pytest.raises(ResetNotLiveError):
        service.lookup(token)
    with pytest.raises(ResetNotLiveError):
        service.complete(token, NEW_PASSWORD)


@pytest.mark.parametrize("token", ["", "short", "a" * 43, "bad token with spaces!!"])
def test_malformed_and_unknown_tokens_are_dead(service: PasswordResetService, token: str) -> None:
    with pytest.raises(ResetNotLiveError):
        service.lookup(token)


@pytest.mark.parametrize("password", ["short", "aaaaaaaaaaaaaa", "password1234"])
def test_a_refused_password_leaves_the_link_usable(
    service: PasswordResetService, auth_store, mailer: FakeMailer, password: str
) -> None:
    _account(auth_store)
    service.request("ada", locale=None, web_origin=WEB)
    token = _token(mailer.sent[0])

    with pytest.raises(ValueError):
        service.complete(token, password)

    assert auth_store.authenticate("ada", OLD_PASSWORD) is not None
    service.complete(token, NEW_PASSWORD)
    assert auth_store.authenticate("ada", NEW_PASSWORD) is not None


def test_the_change_notice_goes_to_the_owner_without_a_link(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    _account(auth_store)
    service.request("ada", locale=None, web_origin=WEB)
    account = service.complete(_token(mailer.sent[0]), NEW_PASSWORD)

    service.send_changed_notice(account)

    notice = mailer.sent[-1]
    assert notice.to == "Ada@Example.com"
    assert notice.subject == "Your Relay password was changed"
    assert "http" not in notice.text and "<a " not in notice.html


def test_the_account_language_picks_the_copy(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    account = _account(auth_store)
    auth_store.update_user_preferences(account["id"], language="zh-CN")

    service.request("ada", locale="en", web_origin=WEB)

    assert mailer.sent[0].subject == "重置你的 Relay 密码"


def test_admin_links_work_without_mail_or_an_address(auth_store, clock: Clock) -> None:
    service = PasswordResetService(password_reset_store_for(auth_store), NullMailer(), clock=clock)
    _account(auth_store, email=None)

    first = service.admin_issue("ada", web_origin=WEB)
    second = service.admin_issue("ada", web_origin=WEB)

    assert not service.self_serve_enabled
    assert second.delivery == "skipped"
    assert second.expires_at == START + timedelta(minutes=30)
    with pytest.raises(ResetNotLiveError):
        service.lookup(first.url.split("#token=", 1)[1])
    service.complete(second.url.split("#token=", 1)[1], NEW_PASSWORD)
    assert auth_store.authenticate("ada", NEW_PASSWORD) is not None
    with pytest.raises(KeyError):
        service.admin_issue("nobody", web_origin=WEB)


def test_admin_links_are_emailed_when_they_can_be(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    _account(auth_store)

    issued = service.admin_issue("ada", web_origin=WEB)

    assert issued.delivery == "sent"
    assert _token(mailer.sent[0]) == issued.url.split("#token=", 1)[1]


def test_tokens_and_addresses_never_reach_the_log(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    lines: list[str] = []
    sink = logger.add(lambda message: lines.append(str(message.record)), level="DEBUG")
    try:
        _account(auth_store)
        service.request("ada", locale=None, web_origin=WEB)
        token = _token(mailer.sent[0])
        service.complete(token, NEW_PASSWORD)
    finally:
        logger.remove(sink)

    assert lines
    assert not [line for line in lines if token in line or "example.com" in line.lower()]


def test_concurrent_completions_succeed_once(tmp_path: Path, clock: Clock) -> None:
    auth_store = DatabaseAccountAuthStore(f"sqlite:///{tmp_path}/auth.db", create_schema=True)
    mailer = FakeMailer()
    service = PasswordResetService(password_reset_store_for(auth_store), mailer, clock=clock)
    _account(auth_store)
    service.request("ada", locale=None, web_origin=WEB)
    token = _token(mailer.sent[0])
    outcomes: list[str] = []
    barrier = threading.Barrier(4)

    def attempt() -> None:
        barrier.wait()
        try:
            service.complete(token, NEW_PASSWORD)
            outcomes.append("ok")
        except ResetNotLiveError:
            outcomes.append("dead")

    threads = [threading.Thread(target=attempt) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(outcomes) == ["dead", "dead", "dead", "ok"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(" Ada ", "ada"), ("ADA@Example.COM", "ada@example.com")],
)
def test_identifiers_are_normalized(raw: str, expected: str) -> None:
    assert normalize_reset_identifier(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "   ", "a" * 255, "ada\x00", "not@an@email", 7])
def test_malformed_identifiers_are_refused(raw: object) -> None:
    with pytest.raises(ValueError):
        normalize_reset_identifier(raw)


def test_one_request_reaches_at_most_three_accounts(
    service: PasswordResetService, auth_store, mailer: FakeMailer
) -> None:
    for index in range(5):
        _account(auth_store, f"ada-{index}", email="ada@example.com", user_id=f"ada-{index}")

    service.request("ada@example.com", locale=None, web_origin=WEB)

    assert len(mailer.sent) == 3


@pytest.mark.parametrize("writer", ["preferences", "session"])
def test_file_reset_survives_a_concurrent_auth_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, writer: str
) -> None:
    from concurrent.futures import ThreadPoolExecutor

    auth = AccountAuthStore(tmp_path / "state")
    account = _account(auth)
    old_session = auth.create_session(account["id"])
    writer_auth = AccountAuthStore(tmp_path / "state")
    service = PasswordResetService(password_reset_store_for(auth), NullMailer())
    token = service.admin_issue("ada", web_origin=WEB).url.split("#token=", 1)[1]
    snapshot_read = threading.Event()
    release_writer = threading.Event()
    reset_finished = threading.Event()
    reader_name = "_read_accounts" if writer == "preferences" else "_read_sessions"
    original_read = getattr(writer_auth, reader_name)

    def paused_read():
        snapshot = original_read()
        if threading.current_thread().name.startswith("auth-writer"):
            snapshot_read.set()
            assert release_writer.wait(5)
        return snapshot

    monkeypatch.setattr(writer_auth, reader_name, paused_read)

    def write():
        if writer == "preferences":
            writer_auth.update_user_preferences(account["id"], theme="dark")
        else:
            writer_auth.create_session(account["id"])

    def reset():
        try:
            service.complete(token, NEW_PASSWORD)
        finally:
            reset_finished.set()

    with ThreadPoolExecutor(thread_name_prefix="auth-writer") as writes, ThreadPoolExecutor() as resets:
        writing = writes.submit(write)
        try:
            assert snapshot_read.wait(5)
            resetting = resets.submit(reset)
            # A correctly serialized reset waits until the writer releases
            # its snapshot. An unlocked writer can overwrite a finished reset.
            reset_finished.wait(0.2)
        finally:
            release_writer.set()
        writing.result(timeout=5)
        resetting.result(timeout=5)

    assert auth.authenticate("ada", NEW_PASSWORD) is not None
    assert auth.authenticate("ada", OLD_PASSWORD) is None
    assert auth.get_session_by_token(old_session["token"]) is None


def test_database_redemption_rechecks_a_link_after_account_lock(tmp_path):
    from sqlalchemy import event

    auth = DatabaseAccountAuthStore(f"sqlite:///{tmp_path}/auth.db", create_schema=True)
    service = PasswordResetService(password_reset_store_for(auth), NullMailer())
    _account(auth)
    token = service.admin_issue("ada", web_origin=WEB).url.split("#token=", 1)[1]
    reissued = []

    def reissue_before_lock(conn, clause, multiparams, params, options):
        if getattr(clause, "_for_update_arg", None) is not None and not reissued:
            reissued.append(True)
            # Model an issuer that acquired the Account lock first. Both
            # operations must serialize there, then redemption must recheck.
            service.admin_issue("ada", web_origin=WEB)

    event.listen(auth.engine, "before_execute", reissue_before_lock)
    try:
        with pytest.raises(ResetNotLiveError):
            service.complete(token, NEW_PASSWORD)
    finally:
        event.remove(auth.engine, "before_execute", reissue_before_lock)
    assert reissued
    assert auth.authenticate("ada", OLD_PASSWORD) is not None
