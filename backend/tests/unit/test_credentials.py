"""Exercise real password hashing, including the production work factor."""

import pytest

from relay.security import credentials


def test_password_hash_cost_in_tests(request):
    expected = 600_000 if request.config.getoption("--full-password-cost", default=False) else 1_000
    hashed = credentials.hash_password("kestrel-vault-7719")
    assert int(hashed.split("$")[1]) == expected
    assert credentials.verify_password("kestrel-vault-7719", hashed)
    assert not credentials.verify_password("wrong-password", hashed)


@pytest.mark.production_password_hash
def test_production_password_hash_cost_and_salts():
    assert credentials.PW_HASH_ITERATIONS == 600_000
    first = credentials.hash_password("kestrel-vault-7719")
    second = credentials.hash_password("kestrel-vault-7719")
    assert first.startswith("pbkdf2_sha256$600000$")
    assert first != second
    assert credentials.verify_password("kestrel-vault-7719", first)
    assert not credentials.verify_password("wrong-password", first)


def test_password_verification_uses_the_stored_cost(monkeypatch):
    monkeypatch.setattr(credentials, "PW_HASH_ITERATIONS", 2_000)
    hashed = credentials.hash_password("kestrel-vault-7719")
    monkeypatch.setattr(credentials, "PW_HASH_ITERATIONS", 1_000)
    assert credentials.verify_password("kestrel-vault-7719", hashed)
    assert not credentials.verify_password("wrong-password", hashed)


@pytest.mark.parametrize("hashed", ["invalid", "other$1000$salt$digest", "pbkdf2_sha256$invalid$salt$digest"])
def test_password_verification_rejects_invalid_hashes(hashed):
    assert not credentials.verify_password("kestrel-vault-7719", hashed)
