"""Account email: required for new Accounts, unique, and a login identifier.

Legacy Accounts created before email was required keep a NULL email and keep
signing in by username; they are inserted here with raw SQL because no
current write path can create one.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from relay.core.email_address import normalize_email_address
from relay.core.ids import new_database_id
from relay.persistence.org.admin_tokens import DatabaseAdminTokenStore
from relay.security.admin_token import configure_admin_token, reissue_admin_token
from relay.security.auth import DatabaseAccountAuthStore
from relay.security.auth_accounts import AccountIdentityConflict
from relay.security.credentials import hash_password
from relay.security.password_resets import password_reset_store_for
from sqlalchemy import insert
from sqlalchemy.exc import IntegrityError

PASSWORD = "kestrel-vault-7719"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[DatabaseAccountAuthStore]:
    yield DatabaseAccountAuthStore(f"sqlite:///{tmp_path}/auth.db", create_schema=True)


def _legacy_account(
    store: DatabaseAccountAuthStore, username: str, *, email: str | None = None
) -> str:
    """An Account as an older release wrote it: no validation, maybe no email."""
    now = datetime.now(UTC)
    account_id = new_database_id()
    with store.engine.begin() as conn:
        conn.execute(insert(store.accounts).values(
            id=account_id, username=username, email=email, role="user", user_id=None,
            password_hash=hash_password(PASSWORD), created_at=now, updated_at=now,
        ))
    return account_id


@pytest.mark.parametrize("value", [None, "", "   ", "alice", "alice@", "@example.com",
                                   "alice@example", "a b@example.com", "a@b.com, c@d.com"])
def test_a_new_account_requires_a_valid_email(store, value) -> None:
    with pytest.raises(ValueError, match="email"):
        store.create_account("alice", PASSWORD, email=value)
    assert store.list_accounts() == []


def test_the_email_is_stored_normalized(store) -> None:
    account = store.create_account("alice", PASSWORD, email="  Alice@Example.COM ")
    assert account["email"] == "alice@example.com"
    assert store.list_users()[0]["email"] == "alice@example.com"


def test_normalize_email_address_rejects_overlong_input() -> None:
    with pytest.raises(ValueError):
        normalize_email_address("a" * 250 + "@example.com")


def test_a_normalized_duplicate_email_is_a_conflict(store) -> None:
    store.create_account("alice", PASSWORD, email="alice@example.com")
    with pytest.raises(AccountIdentityConflict) as raised:
        store.create_account("alice2", PASSWORD, email=" ALICE@example.com")
    assert raised.value.field == "email"
    assert [account["username"] for account in store.list_accounts()] == ["alice"]


def test_a_legacy_mixed_case_email_still_blocks_a_duplicate(store) -> None:
    _legacy_account(store, "legacy", email="Bob@Example.com")
    with pytest.raises(AccountIdentityConflict) as raised:
        store.create_account("bob", PASSWORD, email="bob@example.com")
    assert raised.value.field == "email"


def test_the_database_refuses_a_case_insensitive_duplicate(store) -> None:
    _legacy_account(store, "one", email="dup@example.com")
    with pytest.raises(IntegrityError):
        _legacy_account(store, "two", email="DUP@example.com")


def test_an_email_that_is_another_accounts_username_is_ambiguous(store) -> None:
    _legacy_account(store, "carol@example.com")
    with pytest.raises(AccountIdentityConflict) as raised:
        store.create_account("carol", PASSWORD, email="Carol@example.com")
    assert raised.value.field == "email"


def test_a_username_that_is_another_accounts_email_is_ambiguous(store) -> None:
    store.create_account("dave", PASSWORD, email="dave@example.com")
    with pytest.raises(AccountIdentityConflict) as raised:
        store.create_account("DAVE@example.com", PASSWORD, email="other@example.com")
    assert raised.value.field == "username"


def test_a_duplicate_username_is_still_a_username_conflict(store) -> None:
    store.create_account("erin", PASSWORD, email="erin@example.com")
    with pytest.raises(AccountIdentityConflict) as raised:
        store.create_account("Erin", PASSWORD, email="erin2@example.com")
    assert raised.value.field == "username"


def test_login_accepts_the_username_or_the_email(store) -> None:
    account = store.create_account("frank", PASSWORD, email="frank@example.com")
    assert store.authenticate(" FRANK ", PASSWORD)["id"] == account["id"]
    assert store.authenticate(" Frank@Example.com ", PASSWORD)["id"] == account["id"]
    assert store.authenticate("frank@example.com", "wrong-password-1") is None
    assert store.authenticate("nobody@example.com", PASSWORD) is None


def test_a_deleted_user_cannot_sign_in_by_email(store) -> None:
    account = store.create_account("gina", PASSWORD, email="gina@example.com")
    store.soft_delete_user(account["userId"])
    assert store.authenticate("gina@example.com", PASSWORD) is None
    assert store.authenticate("gina", PASSWORD) is None


def test_a_legacy_account_without_email_signs_in_by_username(store) -> None:
    account_id = _legacy_account(store, "henry")
    assert store.authenticate("henry", PASSWORD)["id"] == account_id


def test_a_legacy_username_with_an_at_sign_still_signs_in(store) -> None:
    account_id = _legacy_account(store, "ivy@example.com")
    assert store.authenticate("IVY@example.com", PASSWORD)["id"] == account_id


def test_an_identifier_two_accounts_answer_to_signs_in_neither(store) -> None:
    # A collision older releases could write: one Account's username is
    # another's email. Picking either would be a guess, so neither wins.
    _legacy_account(store, "jay@example.com")
    _legacy_account(store, "jay", email="jay@example.com")
    assert store.authenticate("jay@example.com", PASSWORD) is None
    assert store.authenticate("jay", PASSWORD) is not None


def test_bootstrap_requires_an_email(tmp_path: Path, store) -> None:
    configure_admin_token(
        str(tmp_path), DatabaseAdminTokenStore(f"sqlite:///{tmp_path}/admin.db", create_schema=True)
    )
    token = reissue_admin_token()
    with pytest.raises(ValueError, match="email"):
        store.bootstrap_with_token(token, "root", PASSWORD, "")
    assert not store.has_accounts()
    account = store.bootstrap_with_token(token, "root", PASSWORD, "Root@Example.com")
    assert account["role"] == "admin"
    assert account["email"] == "root@example.com"
    assert store.authenticate("root@example.com", PASSWORD)["id"] == account["id"]


def test_a_user_email_change_moves_the_sign_in_email_and_the_reset_recipient(store) -> None:
    account = store.create_account("kim", PASSWORD, email="kim@example.com")
    store.update_user(account["userId"], email=" Kim.New@Example.com ")

    assert store.get_account_by_id(account["id"])["email"] == "kim.new@example.com"
    assert store.list_users()[0]["email"] == "kim.new@example.com"
    assert store.authenticate("kim.new@example.com", PASSWORD)["id"] == account["id"]
    assert store.authenticate("kim@example.com", PASSWORD) is None
    resets = password_reset_store_for(store)
    assert [found.email for found in resets.accounts_for("kim.new@example.com")] == [
        "kim.new@example.com"
    ]
    assert resets.accounts_for("kim@example.com") == []


def test_a_user_email_change_to_a_taken_address_changes_nothing(store) -> None:
    store.create_account("lee", PASSWORD, email="lee@example.com")
    other = store.create_account("max", PASSWORD, email="max@example.com")
    with pytest.raises(AccountIdentityConflict):
        store.update_user(other["userId"], email="LEE@example.com")
    assert store.get_account_by_id(other["id"])["email"] == "max@example.com"
    assert {user["email"] for user in store.list_users()} == {
        "lee@example.com", "max@example.com"
    }


@pytest.mark.parametrize("value", ["", "not-an-email"])
def test_a_user_who_signs_in_keeps_a_valid_email(store, value) -> None:
    account = store.create_account("ned", PASSWORD, email="ned@example.com")
    with pytest.raises(ValueError, match="email"):
        store.update_user(account["userId"], email=value)
    assert store.get_account_by_id(account["id"])["email"] == "ned@example.com"
