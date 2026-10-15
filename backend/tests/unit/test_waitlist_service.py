"""Waitlist transitions: join, invite, decline, accept, and how email feeds in."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from relay.notifications.mailer import DeliveryResult, EmailMessage
from relay.persistence.waitlist_store import (
    DatabaseWaitlistStore,
    WaitlistConflictError,
)
from relay.services.waitlist import (
    InviteNotLiveError,
    WaitlistConfig,
    WaitlistFullError,
    WaitlistService,
    WaitlistValidationError,
    hash_invite_token,
)

START = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)
WEB = "https://get-relay.cc"


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


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def mailer() -> FakeMailer:
    return FakeMailer()


@pytest.fixture
def store(tmp_path: Path) -> DatabaseWaitlistStore:
    return DatabaseWaitlistStore(f"sqlite:///{tmp_path}/waitlist.db", create_schema=True)


@pytest.fixture
def service(store: DatabaseWaitlistStore, mailer: FakeMailer, clock: Clock) -> WaitlistService:
    return WaitlistService(store, mailer, config=WaitlistConfig(max_waiting=3), clock=clock)


def _token(invite: dict) -> str:
    return invite["inviteUrl"].split("#token=", 1)[1]


def _join(service: WaitlistService, email: str = "ada@example.com", **extra) -> dict:
    entry = service.join({"email": email, **extra})
    assert entry is not None
    return entry


def test_join_normalizes_email_and_validates_fields(service: WaitlistService) -> None:
    entry = _join(service, "  Ada@Example.COM ", name=" Ada ", locale="zh-CN", source="x" * 500)

    assert entry["email"] == "ada@example.com"
    assert entry["name"] == "Ada"
    assert entry["status"] == "waiting"
    assert entry["locale"] == "zh-CN"
    assert len(entry["source"]) == 120
    with pytest.raises(WaitlistValidationError):
        service.join({"email": "not-an-email"})
    with pytest.raises(WaitlistValidationError):
        service.join({"email": "b@example.com", "useCase": "x" * 1001})


@pytest.mark.parametrize(
    "body",
    [
        {"email": "a\u0000@example.com"},
        {"email": "a@example.com, b@example.com"},
        {"email": "Evil <a@example.com>"},
        {"email": "a@example.com", "name": "Ada\u0000"},
        {"email": "a@example.com", "company": "Acme\x1b[31m"},
    ],
)
def test_join_rejects_control_characters_and_smuggled_recipients(service: WaitlistService, body: dict) -> None:
    with pytest.raises(WaitlistValidationError):
        service.join(body)


def test_multiline_use_case_and_dirty_source_are_kept(service: WaitlistService) -> None:
    entry = _join(service, useCase="line one\nline two", source="news\u0000letter")
    assert entry["useCase"] == "line one\nline two"
    assert entry["source"] == "newsletter"


def test_unknown_locale_is_dropped(service: WaitlistService) -> None:
    assert _join(service, locale="fr")["locale"] is None


def test_resubmitting_keeps_the_original_place(
    service: WaitlistService, store: DatabaseWaitlistStore, clock: Clock
) -> None:
    first = _join(service, name="Ada")
    clock.advance(days=1)

    assert service.join({"email": "ADA@example.com", "name": "Someone else"}) is None
    entry = store.get(first["id"])
    assert entry["createdAt"] == first["createdAt"]
    assert entry["name"] == "Ada"
    assert entry["updatedAt"] != first["updatedAt"]


def test_honeypot_writes_nothing(service: WaitlistService, store: DatabaseWaitlistStore) -> None:
    assert service.join({"email": "bot@example.com", "website": "http://spam"}) is None
    assert store.counts()["waiting"] == 0


def test_full_queue_refuses_new_entries(service: WaitlistService) -> None:
    for index in range(3):
        _join(service, f"user{index}@example.com")
    with pytest.raises(WaitlistFullError):
        service.join({"email": "late@example.com"})


def test_confirmation_goes_only_to_new_entries(service: WaitlistService, mailer: FakeMailer) -> None:
    entry = _join(service, locale="zh-CN")
    service.send_confirmation(entry)

    assert [message.to for message in mailer.sent] == ["ada@example.com"]
    assert mailer.sent[0].subject == "你已加入 Relay 候补名单"


def test_confirmation_can_be_switched_off(store, mailer, clock) -> None:
    service = WaitlistService(store, mailer, config=WaitlistConfig(confirmation_email=False), clock=clock)
    service.send_confirmation(_join(service))
    assert mailer.sent == []


def test_invite_emails_a_link_and_stores_only_a_hash(
    service: WaitlistService, store: DatabaseWaitlistStore, mailer: FakeMailer
) -> None:
    entry = _join(service, name="<Ada>")
    invite = service.invite(entry["id"], invited_by="admin-user", web_origin=WEB)
    token = _token(invite)

    assert invite["inviteUrl"].startswith(f"{WEB}/join#token=")
    assert invite["delivery"] == {"status": "sent", "error": None}
    assert invite["entry"]["status"] == "invited"
    assert invite["entry"]["lastDeliveryStatus"] == "sent"
    assert "inviteTokenHash" not in invite["entry"]
    stored = store.get(entry["id"])
    assert stored["inviteTokenHash"] != token and token not in str(stored)
    assert stored["invitedByUserId"] == "admin-user"
    assert token in mailer.sent[0].text
    assert "&lt;Ada&gt;" in mailer.sent[0].html and "<Ada>" not in mailer.sent[0].html


def test_failed_delivery_still_invites(store, clock) -> None:
    mailer = FakeMailer(DeliveryResult("failed", "Email service error: throttled", retryable=True))
    service = WaitlistService(store, mailer, clock=clock)
    invite = service.invite(_join(service)["id"], invited_by=None, web_origin=WEB)

    assert invite["entry"]["status"] == "invited"
    assert invite["delivery"]["status"] == "failed"
    assert invite["entry"]["lastDeliveryError"] == "Email service error: throttled"
    assert service.live_invite(_token(invite))["email"] == "ada@example.com"


def test_reinvite_rotates_the_token(service: WaitlistService) -> None:
    entry = _join(service)
    old = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))
    new = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))

    with pytest.raises(InviteNotLiveError):
        service.live_invite(old)
    assert service.live_invite(new)["id"] == entry["id"]


def test_expired_invite_is_dead_and_flagged(service: WaitlistService, clock: Clock) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))
    clock.advance(days=15)

    with pytest.raises(InviteNotLiveError):
        service.live_invite(token)
    with pytest.raises(InviteNotLiveError):
        service.accept(token, lambda claimed: {"id": "never"})
    listed = service.list(status="invited", query=None, limit=10, offset=0)
    assert listed["entries"][0]["inviteExpired"] is True


def test_decline_kills_the_invite_and_rejoin_stays_declined(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))
    assert service.decline(entry["id"])["status"] == "declined"

    with pytest.raises(InviteNotLiveError):
        service.live_invite(token)
    assert service.join({"email": "ada@example.com"}) is None
    assert service.list(status="declined", query=None, limit=10, offset=0)["total"] == 1


def test_accept_links_the_account_and_spends_the_token(
    service: WaitlistService, store: DatabaseWaitlistStore
) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))

    account = service.accept(token, lambda claimed: {"id": "acct-1", "email": claimed["email"]})

    assert account["id"] == "acct-1"
    joined = store.get(entry["id"])
    assert joined["status"] == "joined" and joined["accountId"] == "acct-1"
    with pytest.raises(InviteNotLiveError):
        service.accept(token, lambda claimed: {"id": "acct-2"})
    with pytest.raises(WaitlistConflictError):
        service.invite(entry["id"], invited_by=None, web_origin=WEB)
    with pytest.raises(WaitlistConflictError):
        service.decline(entry["id"])


def test_failed_account_creation_keeps_the_invite_live(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))

    def reject(claimed: dict) -> dict:
        raise ValueError("username already exists.")

    with pytest.raises(ValueError):
        service.accept(token, reject)
    assert service.live_invite(token)["status"] == "invited"


def test_concurrent_accepts_create_one_account(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))
    created: list[str] = []
    gate = threading.Barrier(4)

    def attempt(index: int) -> None:
        gate.wait()
        try:
            service.accept(token, lambda claimed: created.append(str(index)) or {"id": f"acct-{index}"})
        except InviteNotLiveError:
            pass

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(created) == 1


def test_batch_issues_links_first_and_sends_later(
    service: WaitlistService, store: DatabaseWaitlistStore, clock: Clock, mailer: FakeMailer
) -> None:
    for name in ("first", "second", "third"):
        _join(service, f"{name}@example.com")
        clock.advance(minutes=1)

    invites, pending = service.invite_batch(count=2, ids=None, invited_by=None, web_origin=WEB)

    assert [invite["entry"]["email"] for invite in invites] == ["first@example.com", "second@example.com"]
    assert all(invite["delivery"]["status"] == "queued" for invite in invites)
    assert mailer.sent == []
    assert service.live_invite(_token(invites[0]))["email"] == "first@example.com"

    service.deliver_invites(pending)

    assert [message.to for message in mailer.sent] == ["first@example.com", "second@example.com"]
    assert store.get(invites[0]["entry"]["id"])["lastDeliveryStatus"] == "sent"
    with pytest.raises(WaitlistValidationError):
        service.invite_batch(count=51, ids=None, invited_by=None, web_origin=WEB)


def test_batch_skips_missing_and_joined_entries(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))
    service.accept(token, lambda claimed: {"id": "acct-1"})
    other = _join(service, "bo@example.com")

    invites, _ = service.invite_batch(
        count=None, ids=[entry["id"], "missing", other["id"], other["id"]], invited_by=None, web_origin=WEB
    )
    assert [invite["entry"]["email"] for invite in invites] == ["bo@example.com"]
    assert service.live_invite(_token(invites[0]))["email"] == "bo@example.com"


def test_delivering_to_an_erased_entry_is_skipped(service: WaitlistService, mailer: FakeMailer) -> None:
    entry = _join(service)
    _, pending = service.invite_batch(count=None, ids=[entry["id"]], invited_by=None, web_origin=WEB)
    service.erase(entry["id"])

    service.deliver_invites(pending)
    assert len(mailer.sent) == 1


def test_an_unlinked_claim_stays_closed(service: WaitlistService, store: DatabaseWaitlistStore) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))
    # A claim whose process died before the account existed.
    store.claim_invite(hash_invite_token(token), START)

    with pytest.raises(WaitlistConflictError):
        service.invite(entry["id"], invited_by=None, web_origin=WEB)


def test_linking_failure_does_not_fail_a_created_account(
    service: WaitlistService, store: DatabaseWaitlistStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))

    def erased(*args, **kwargs):
        raise KeyError(entry["id"])

    monkeypatch.setattr(store, "link_account", erased)
    assert service.accept(token, lambda claimed: {"id": "acct-1"})["id"] == "acct-1"


def test_list_searches_and_counts(service: WaitlistService) -> None:
    _join(service, "ada@example.com", company="Analytical Engines")
    _join(service, "bo@example.com", name="Bo 100%")

    by_company = service.list(status=None, query="analytical", limit=10, offset=0)
    assert [entry["email"] for entry in by_company["entries"]] == ["ada@example.com"]
    literal = service.list(status=None, query="100%", limit=10, offset=0)
    assert [entry["email"] for entry in literal["entries"]] == ["bo@example.com"]
    assert by_company["counts"] == {"waiting": 2, "invited": 0, "joined": 0, "declined": 0}


def test_note_and_erase(service: WaitlistService) -> None:
    entry = _join(service)
    assert service.set_note(entry["id"], " met at a meetup ")["adminNote"] == "met at a meetup"
    with pytest.raises(WaitlistValidationError):
        service.set_note(entry["id"], "x" * 1001)
    service.erase(entry["id"])
    with pytest.raises(KeyError):
        service.erase(entry["id"])


def test_active_claim_cannot_be_reinvited(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, web_origin=WEB))

    def create_account(claimed: dict) -> dict:
        with pytest.raises(WaitlistConflictError):
            service.invite(claimed["id"], invited_by=None, web_origin=WEB)
        return {"id": "only-account"}

    assert service.accept(token, create_account)["id"] == "only-account"


def test_concurrent_joins_respect_capacity(store, mailer, clock, monkeypatch) -> None:
    from concurrent.futures import ThreadPoolExecutor

    service = WaitlistService(store, mailer, config=WaitlistConfig(max_waiting=1), clock=clock)
    gate = threading.Barrier(2)
    original_join = store.join

    def synchronized_join(*args, **kwargs):
        gate.wait(timeout=5)
        return original_join(*args, **kwargs)

    monkeypatch.setattr(store, "join", synchronized_join)

    def attempt(index: int) -> str:
        try:
            service.join({"email": f"person{index}@example.com"})
            return "created"
        except WaitlistFullError:
            return "full"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(attempt, range(2)))
    assert sorted(outcomes) == ["created", "full"]
    assert store.count("waiting") == 1
