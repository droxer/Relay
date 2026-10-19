"""Hashing an Account's password and its login session tokens."""

from __future__ import annotations

import hashlib
import secrets

PW_HASH_ALGORITHM = "pbkdf2_sha256"
PW_HASH_ITERATIONS = 600_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PW_HASH_ITERATIONS
    ).hex()
    return f"{PW_HASH_ALGORITHM}${PW_HASH_ITERATIONS}${salt}${digest}"


def verify_password(password: str, hashed: str) -> bool:
    try:
        algorithm, iterations, salt, digest = hashed.split("$")
    except ValueError:
        return False
    if algorithm != PW_HASH_ALGORITHM:
        return False
    try:
        rounds = int(iterations)
    except ValueError:
        return False
    expected = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), rounds
    ).hex()
    return secrets.compare_digest(expected, digest)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
