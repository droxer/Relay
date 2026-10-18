from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from relay.security.auth import DatabaseAccountAuthStore
from relay.security.onboarding import apply_onboarding_patch, normalize_onboarding

NOW = "2026-10-16T19:40:00.000Z"
LATER = "2026-10-17T08:00:00.000Z"


def test_patch_stamps_choices_with_the_server_clock() -> None:
    record = apply_onboarding_patch(None, {"introSeen": True}, NOW)

    assert record == {"introSeenAt": NOW}


def test_repeating_a_choice_keeps_its_first_stamp() -> None:
    first = apply_onboarding_patch({}, {"dismissed": True}, NOW)
    again = apply_onboarding_patch(first, {"dismissed": True}, LATER)

    assert again["dismissedAt"] == NOW


def test_reopening_clears_the_dismissal_without_touching_the_input() -> None:
    current = {"introSeenAt": NOW, "dismissedAt": NOW, "closedCards": ["teams"]}

    reopened = apply_onboarding_patch(current, {"dismissed": False, "closedCards": []}, LATER)

    assert reopened == {"introSeenAt": NOW}
    assert current == {"introSeenAt": NOW, "dismissedAt": NOW, "closedCards": ["teams"]}


def test_closed_cards_are_deduped_into_catalogue_order() -> None:
    record = apply_onboarding_patch({}, {"closedCards": ["teams", "tasks", "teams"]}, NOW)

    assert record["closedCards"] == ["tasks", "teams"]


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ("dismiss", "onboarding must be an object"),
        ({"dismissedAt": NOW}, "unknown field"),
        ({"dismissed": "yes"}, "onboarding.dismissed must be a boolean"),
        ({"introSeen": 1}, "onboarding.introSeen must be a boolean"),
        ({"closedCards": "tasks"}, "must be a list"),
        ({"closedCards": ["billing"]}, "unknown card"),
    ],
)
def test_invalid_patches_are_rejected(patch: object, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        apply_onboarding_patch({}, patch, NOW)


def test_normalize_drops_whatever_it_does_not_recognize() -> None:
    assert normalize_onboarding("garbage") == {}
    assert normalize_onboarding({"dismissedAt": 3, "closedCards": ["x", "projects"], "extra": 1}) == {
        "closedCards": ["projects"],
    }


def test_database_store_round_trips_onboarding() -> None:
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/auth.db"
        store = DatabaseAccountAuthStore(database_url, create_schema=True)
        account = store.create_account("alice", "kestrel-vault-7719")
        assert account["onboarding"] == {}

        store.update_user_preferences(account["id"], onboarding={"introSeen": True})
        updated = store.update_user_preferences(
            account["id"], onboarding={"closedCards": ["teams"]}
        )

        assert set(updated["onboarding"]) == {"introSeenAt", "closedCards"}
        persisted = DatabaseAccountAuthStore(database_url).get_account_by_id(account["id"])
        assert persisted is not None
        assert persisted["onboarding"] == updated["onboarding"]


def test_database_store_rejects_a_bad_patch_without_writing() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseAccountAuthStore(f"sqlite:///{root}/auth.db", create_schema=True)
        account = store.create_account("alice", "kestrel-vault-7719")

        with pytest.raises(ValueError):
            store.update_user_preferences(
                account["id"], theme="dark", onboarding={"closedCards": ["billing"]}
            )

        persisted = store.get_account_by_id(account["id"])
        assert persisted is not None
        assert persisted["theme"] == "system"
        assert persisted["onboarding"] == {}


def test_concurrent_preference_intents_preserve_both_choices(tmp_path, monkeypatch) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, BrokenBarrierError

    from relay.security import auth as auth_module

    def make_store():
        return DatabaseAccountAuthStore(f"sqlite:///{tmp_path}/auth.db", create_schema=True)

    first, second = make_store(), make_store()
    account = first.create_account("alice", "kestrel-vault-7719")
    rendezvous = Barrier(2)
    original = auth_module.apply_onboarding_patch

    def overlapping_patch(*args):
        try:
            rendezvous.wait(timeout=0.2)
        except BrokenBarrierError:
            # Once writes serialize, the first writer must finish while the
            # second waits for its lock, rather than deadlocking this test.
            pass
        return original(*args)

    monkeypatch.setattr(auth_module, "apply_onboarding_patch", overlapping_patch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(store.update_user_preferences, account["id"], onboarding=patch)
            for store, patch in [(first, {"introSeen": True}), (second, {"dismissed": True})]
        ]
        for future in futures:
            future.result(timeout=5)
    persisted = first.get_account_by_id(account["id"])
    assert set(persisted["onboarding"]) == {"introSeenAt", "dismissedAt"}
