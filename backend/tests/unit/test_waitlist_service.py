"""Waitlist transitions: join, invite, decline, accept, and how email feeds in."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, UTC
from pathlib import Path

import pytest
from relay.notifications.mailer import DeliveryResult, EmailMessage
from relay.persistence.waitlist_store import (
    DatabaseWaitlistStore,
    WaitlistConflictError,
)
from relay.services.waitlist import (
    InviteNotLiveError,
    InviteOrigin,
    WaitlistConfig,
    WaitlistFullError,
    WaitlistService,
    WaitlistValidationError,
    hash_invite_token,
)

START = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)
WEB = "https://get-relay.cc"
ORIGIN = InviteOrigin(WEB, trusted=True)


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
    return WaitlistService(store, mailer, config=WaitlistConfig(max_waiting=3, invite_email=True), clock=clock)


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
    invite = service.invite(entry["id"], invited_by="admin-user", origin=ORIGIN)
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
    service = WaitlistService(store, mailer, config=WaitlistConfig(invite_email=True), clock=clock)
    invite = service.invite(_join(service)["id"], invited_by=None, origin=ORIGIN)

    assert invite["entry"]["status"] == "invited"
    assert invite["delivery"]["status"] == "failed"
    assert invite["entry"]["lastDeliveryError"] == "Email service error: throttled"
    assert service.live_invite(_token(invite))["email"] == "ada@example.com"


def test_invites_are_links_only_by_default(store, mailer, clock) -> None:
    service = WaitlistService(store, mailer, clock=clock)
    assert service.invite_email_enabled is False
    single = service.invite(_join(service)["id"], invited_by=None, origin=ORIGIN)
    direct = service.invite_email(
        {"email": "grace@example.com", "locale": "zh-CN"},
        invited_by=None,
        origin=ORIGIN,
        email_in_use=_nobody,
        account_live=_alive,
    )
    invites, pending = service.invite_batch(
        count=None, ids=[_join(service, "bo@example.com")["id"]], invited_by=None, origin=ORIGIN
    )
    service.deliver_invites(pending)

    for invite in (single, direct, *invites):
        assert invite["delivery"] is None
        assert invite["entry"]["status"] == "invited"
        assert invite["entry"]["lastDeliveryStatus"] is None
        assert service.live_invite(_token(invite))["id"] == invite["entry"]["id"]
    assert all("invite" not in message.subject.lower() for message in mailer.sent)


def test_a_link_only_reinvite_clears_an_earlier_delivery(store, clock) -> None:
    failing = FakeMailer(DeliveryResult("failed", "Email service error: throttled"))
    emailing = WaitlistService(store, failing, config=WaitlistConfig(invite_email=True), clock=clock)
    entry = _join(emailing)
    emailing.invite(entry["id"], invited_by=None, origin=ORIGIN)

    linked = WaitlistService(store, failing, clock=clock).invite(entry["id"], invited_by=None, origin=ORIGIN)

    assert linked["entry"]["lastDeliveryStatus"] is None
    assert linked["entry"]["lastDeliveryError"] is None


def test_reinvite_rotates_the_token(service: WaitlistService) -> None:
    entry = _join(service)
    old = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))
    new = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))

    with pytest.raises(InviteNotLiveError):
        service.live_invite(old)
    assert service.live_invite(new)["id"] == entry["id"]


def test_expired_invite_is_dead_and_flagged(service: WaitlistService, clock: Clock) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))
    clock.advance(days=15)

    with pytest.raises(InviteNotLiveError):
        service.live_invite(token)
    with pytest.raises(InviteNotLiveError):
        service.accept(token, lambda claimed: {"id": "never"})
    listed = service.list(status="invited", query=None, limit=10, offset=0)
    assert listed["entries"][0]["inviteExpired"] is True


def test_decline_kills_the_invite_and_rejoin_stays_declined(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))
    assert service.decline(entry["id"])["status"] == "declined"

    with pytest.raises(InviteNotLiveError):
        service.live_invite(token)
    assert service.join({"email": "ada@example.com"}) is None
    assert service.list(status="declined", query=None, limit=10, offset=0)["total"] == 1


def test_accept_links_the_account_and_spends_the_token(
    service: WaitlistService, store: DatabaseWaitlistStore
) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))

    account = service.accept(token, lambda claimed: {"id": "acct-1", "email": claimed["email"]})

    assert account["id"] == "acct-1"
    joined = store.get(entry["id"])
    assert joined["status"] == "joined" and joined["accountId"] == "acct-1"
    with pytest.raises(InviteNotLiveError):
        service.accept(token, lambda claimed: {"id": "acct-2"})
    with pytest.raises(WaitlistConflictError):
        service.invite(entry["id"], invited_by=None, origin=ORIGIN)
    with pytest.raises(WaitlistConflictError):
        service.decline(entry["id"])


def test_failed_account_creation_keeps_the_invite_live(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))

    def reject(claimed: dict) -> dict:
        raise ValueError("username already exists.")

    with pytest.raises(ValueError):
        service.accept(token, reject)
    assert service.live_invite(token)["status"] == "invited"


def test_concurrent_accepts_create_one_account(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))
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

    invites, pending = service.invite_batch(count=2, ids=None, invited_by=None, origin=ORIGIN)

    assert [invite["entry"]["email"] for invite in invites] == ["first@example.com", "second@example.com"]
    assert all(invite["delivery"]["status"] == "queued" for invite in invites)
    assert mailer.sent == []
    assert service.live_invite(_token(invites[0]))["email"] == "first@example.com"

    service.deliver_invites(pending)

    assert [message.to for message in mailer.sent] == ["first@example.com", "second@example.com"]
    assert store.get(invites[0]["entry"]["id"])["lastDeliveryStatus"] == "sent"
    with pytest.raises(WaitlistValidationError):
        service.invite_batch(count=51, ids=None, invited_by=None, origin=ORIGIN)


def test_batch_skips_missing_and_joined_entries(service: WaitlistService) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))
    service.accept(token, lambda claimed: {"id": "acct-1"})
    other = _join(service, "bo@example.com")

    invites, _ = service.invite_batch(
        count=None, ids=[entry["id"], "missing", other["id"], other["id"]], invited_by=None, origin=ORIGIN
    )
    assert [invite["entry"]["email"] for invite in invites] == ["bo@example.com"]
    assert service.live_invite(_token(invites[0]))["email"] == "bo@example.com"


def test_delivering_to_an_erased_entry_is_skipped(service: WaitlistService, mailer: FakeMailer) -> None:
    entry = _join(service)
    _, pending = service.invite_batch(count=None, ids=[entry["id"]], invited_by=None, origin=ORIGIN)
    service.erase(entry["id"])

    service.deliver_invites(pending)
    # An erased person is not emailed a link to an entry that no longer exists.
    assert mailer.sent == []


def test_an_unlinked_claim_stays_closed(service: WaitlistService, store: DatabaseWaitlistStore) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))
    # A claim whose process died before the account existed.
    store.claim_invite(hash_invite_token(token), START)

    with pytest.raises(WaitlistConflictError):
        service.invite(entry["id"], invited_by=None, origin=ORIGIN)


def test_linking_failure_does_not_fail_a_created_account(
    service: WaitlistService, store: DatabaseWaitlistStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))

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
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))

    def create_account(claimed: dict) -> dict:
        with pytest.raises(WaitlistConflictError):
            service.invite(claimed["id"], invited_by=None, origin=ORIGIN)
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


def _nobody(_email: str) -> bool:
    return False


def _alive(_account_id: str) -> bool:
    return True


def test_invite_email_creates_an_entry_and_emails_it(
    service: WaitlistService, store: DatabaseWaitlistStore, mailer: FakeMailer
) -> None:
    invite = service.invite_email(
        {"email": " Grace@Example.com ", "name": "Grace", "locale": "zh-CN"},
        invited_by="admin-user",
        origin=ORIGIN,
        email_in_use=_nobody, account_live=_alive,
    )

    entry = invite["entry"]
    assert entry["email"] == "grace@example.com"
    assert entry["status"] == "invited"
    assert entry["source"] == "admin-invite"
    assert entry["invitedByUserId"] == "admin-user"
    assert invite["delivery"] == {"status": "sent", "error": None}
    assert [message.to for message in mailer.sent] == ["grace@example.com"]
    assert invite["inviteUrl"] in mailer.sent[0].text
    assert service.live_invite(_token(invite))["name"] == "Grace"


def test_invite_email_reuses_a_waiting_entry(service: WaitlistService, store: DatabaseWaitlistStore) -> None:
    asked = _join(service, "ada@example.com", name="Ada", company="Acme")

    invite = service.invite_email(
        {"email": "ada@example.com", "locale": "zh-CN"}, invited_by=None, origin=ORIGIN, email_in_use=_nobody, account_live=_alive
    )

    assert invite["entry"]["id"] == asked["id"]
    # The person's own answers stay; the admin's language choice wins.
    assert invite["entry"]["name"] == "Ada"
    assert invite["entry"]["company"] == "Acme"
    assert invite["entry"]["locale"] == "zh-CN"
    assert store.counts()["invited"] == 1


def test_invite_email_ignores_the_queue_cap(store: DatabaseWaitlistStore, mailer: FakeMailer, clock: Clock) -> None:
    service = WaitlistService(store, mailer, config=WaitlistConfig(max_waiting=1), clock=clock)
    _join(service, "first@example.com")

    invite = service.invite_email(
        {"email": "vip@example.com"}, invited_by=None, origin=ORIGIN, email_in_use=_nobody, account_live=_alive
    )
    assert invite["entry"]["status"] == "invited"


def test_invite_email_refuses_accounts_and_joined_entries(service: WaitlistService) -> None:
    with pytest.raises(WaitlistConflictError, match="account"):
        service.invite_email(
            {"email": "taken@example.com"}, invited_by=None, origin=ORIGIN, email_in_use=lambda _e: True, account_live=_alive
        )
    entry = _join(service)
    service.accept(_token(service.invite(entry["id"], invited_by=None, origin=ORIGIN)), lambda _c: {"id": "a1"})
    with pytest.raises(WaitlistConflictError):
        service.invite_email({"email": "ada@example.com"}, invited_by=None, origin=ORIGIN, email_in_use=_nobody, account_live=_alive)


def test_invite_email_validates_input(service: WaitlistService) -> None:
    with pytest.raises(WaitlistValidationError):
        service.invite_email({"email": "nope"}, invited_by=None, origin=ORIGIN, email_in_use=_nobody, account_live=_alive)
    with pytest.raises(WaitlistValidationError):
        service.invite_email(
            {"email": "a@b.co", "name": "x" * 121}, invited_by=None, origin=ORIGIN, email_in_use=_nobody, account_live=_alive
        )


def test_untrusted_origin_returns_the_link_but_never_mails_it(
    service: WaitlistService, store: DatabaseWaitlistStore, mailer: FakeMailer
) -> None:
    untrusted = InviteOrigin("http://forged.example", trusted=False)
    single = service.invite_email(
        {"email": "ada@example.com"}, invited_by=None, origin=untrusted, email_in_use=_nobody, account_live=_alive
    )
    other = _join(service, "bo@example.com")
    sent_before = len(mailer.sent)
    invites, pending = service.invite_batch(count=None, ids=[other["id"]], invited_by=None, origin=untrusted)
    service.deliver_invites(pending)

    assert single["inviteUrl"].startswith("http://forged.example/join#token=")
    assert single["delivery"]["status"] == "skipped"
    assert invites[0]["delivery"]["status"] == "skipped"
    assert store.get(other["id"])["lastDeliveryStatus"] == "skipped"
    assert len(mailer.sent) == sent_before
    assert all("invite" not in message.subject.lower() for message in mailer.sent)


def test_a_queued_invite_rotated_before_sending_is_not_mailed(
    service: WaitlistService, store: DatabaseWaitlistStore, mailer: FakeMailer
) -> None:
    entry = _join(service)
    _, pending = service.invite_batch(count=None, ids=[entry["id"]], invited_by=None, origin=ORIGIN)
    fresh = service.invite(entry["id"], invited_by=None, origin=ORIGIN)
    sent_before = len(mailer.sent)

    service.deliver_invites(pending)

    assert len(mailer.sent) == sent_before
    assert service.live_invite(_token(fresh))["id"] == entry["id"]


def test_invite_email_reopens_an_entry_whose_account_was_deleted(
    service: WaitlistService, mailer: FakeMailer
) -> None:
    entry = _join(service)
    service.accept(_token(service.invite(entry["id"], invited_by=None, origin=ORIGIN)), lambda _c: {"id": "a1"})

    invite = service.invite_email(
        {"email": "ada@example.com"},
        invited_by=None,
        origin=ORIGIN,
        email_in_use=_nobody,
        account_live=lambda account_id: account_id != "a1",
    )

    assert invite["entry"]["id"] == entry["id"]
    assert invite["entry"]["status"] == "invited"
    assert invite["entry"]["accountId"] is None
    assert service.live_invite(_token(invite))["id"] == entry["id"]


def test_invite_email_keeps_an_unlinked_claim_closed(
    service: WaitlistService, store: DatabaseWaitlistStore
) -> None:
    entry = _join(service)
    token = _token(service.invite(entry["id"], invited_by=None, origin=ORIGIN))
    # Claimed, account not linked yet: it may be being created right now.
    store.claim_invite(hash_invite_token(token), START)

    with pytest.raises(WaitlistConflictError):
        service.invite_email(
            {"email": "ada@example.com"},
            invited_by=None,
            origin=ORIGIN,
            email_in_use=_nobody,
            account_live=lambda _id: False,
        )
