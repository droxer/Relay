"""The password policy, in one place.

Shaped after NIST SP 800-63B: length and a blocklist of guessable secrets do
the work, and composition rules (mixed case, a digit, a symbol) do not appear —
they push people toward `Password1!` while blocking passphrases that are
genuinely stronger.

Three things are checked beyond length:

* the common-password blocklist below,
* context-specific words — the account's own username, handle, display name and
  email are the first guesses anyone would make,
* degenerate shapes (one repeated character, a straight keyboard/alphabet run),
  which a blocklist can only cover one spelling at a time.

`web/src/lib/passwordPolicy.ts` mirrors every rule except the blocklist, so the
form can answer before a round trip; the backend stays the authority and is the
only side that has to be complete.
"""

from __future__ import annotations

from collections.abc import Iterable

MIN_PASSWORD_LENGTH = 8
# PBKDF2 hashes the whole input, so an unbounded password is unbounded work on
# an unauthenticated-adjacent path. The ceiling is generous enough that no real
# passphrase hits it.
MAX_PASSWORD_LENGTH = 256

# The shortest run that counts as a straight sequence — below this, "abc" inside
# an otherwise fine password would be flagged.
_MIN_SEQUENCE_RUN = 5

_SEQUENCE_ALPHABETS = (
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
)

# The passwords that actually show up in credential-stuffing lists, plus the
# ones this product invites by name. Not a substitute for a full breach corpus —
# if one is ever wired in (Pwned Passwords k-anonymity, say), it belongs behind
# `_is_common` and this list stays as the offline fallback.
COMMON_PASSWORDS = frozenset(
    {
        "password", "passw0rd", "password1", "password12", "password123",
        "password1234", "passwords", "p@ssword", "p@ssw0rd", "pa55word",
        "123456", "1234567", "12345678", "123456789", "1234567890",
        "12345678910", "123123123", "111111", "1111111", "11111111",
        "000000", "0000000", "00000000", "121212", "123321", "654321",
        "666666", "696969", "777777", "888888", "999999", "112233",
        "qwerty", "qwerty123", "qwertyui", "qwertyuiop", "qwe123", "qweasd",
        "asdfgh", "asdfghjk", "asdfghjkl", "zxcvbn", "zxcvbnm", "1qaz2wsx",
        "qazwsx", "qazwsxedc", "1q2w3e4r", "1q2w3e4r5t", "q1w2e3r4",
        "abc123", "abcd1234", "abcdefg", "abcdefgh", "a1b2c3d4",
        "letmein", "welcome", "welcome1", "welcome123", "monkey", "dragon",
        "master", "shadow", "sunshine", "princess", "football", "baseball",
        "basketball", "superman", "batman", "trustno1", "iloveyou",
        "starwars", "computer", "internet", "whatever", "freedom", "ninja",
        "michael", "jennifer", "jordan", "hunter", "harley", "ranger",
        "buster", "soccer", "hockey", "killer", "george", "charlie",
        "andrew", "thomas", "robert", "daniel", "matthew", "joshua",
        "admin", "admin1", "admin123", "administrator", "root", "toor",
        "guest", "default", "changeme", "change_me", "changeit", "secret",
        "secret1", "secret123", "letmein1", "login", "logmein", "access",
        "pass", "passpass", "test", "test123", "testtest", "testing",
        "temp123", "temporary", "demo1234", "sample123", "example",
        "relay", "relay123", "relaypass", "relayrelay", "agent123",
        "sandbox", "sandbox1", "workspace", "employee", "employee1", "user", "user1",
        "companyname", "corporate", "business", "office", "manager",
        "summer2024", "summer2025", "summer2026", "winter2024",
        "winter2025", "winter2026", "spring2025", "spring2026",
        "autumn2025", "fall2025", "january1", "december1",
        "asdf1234", "1234abcd", "qwer1234", "zaq12wsx", "xxxxxxxx",
        "aaaaaaaa", "abcabcabc", "passcode", "keyboard", "mustang",
        "cheese", "chocolate", "pokemon", "minecraft", "samsung", "google",
        "facebook", "linkedin", "amazon", "michelle", "nicole", "hannah",
        "anthony", "william", "jessica", "ashley", "bailey", "flower",
        "purple", "orange", "yellow", "silver", "diamond", "phoenix",
        "liverpool", "arsenal", "chelsea", "barcelona", "juventus",
    }
)


class PasswordRejected(ValueError):
    """A password the policy will not accept. Callers answer it as a 400."""


def validate_password(
    password: str, *, identifiers: Iterable[str | None] = ()
) -> str:
    """Return the password, or raise PasswordRejected explaining the refusal.

    `identifiers` is whatever names the account is known by — username, handle,
    display name, email. Anything derived from them is the first guess an
    attacker makes, so it is refused however it is cased or padded.
    """
    if not password:
        raise PasswordRejected("password is required.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordRejected(
            f"password must be at least {MIN_PASSWORD_LENGTH} characters."
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise PasswordRejected(
            f"password must be at most {MAX_PASSWORD_LENGTH} characters."
        )
    if is_common_password(password):
        raise PasswordRejected(
            "password is one of the most commonly guessed passwords. "
            "Choose something unrelated to this account."
        )
    if contains_identifier(password, identifiers):
        raise PasswordRejected(
            "password must not contain the username, handle, name, or email."
        )
    if is_degenerate(password):
        raise PasswordRejected(
            "password must not be a single repeated character or a straight "
            "keyboard sequence."
        )
    return password


def is_common_password(password: str) -> bool:
    """Blocklist membership, checked against the shapes people actually type.

    A trailing digit or `!` is the standard way a blocked password is smuggled
    past a naive list, so the stripped forms are checked too. Leet substitutions
    are folded the same way — `p@ssw0rd` and `password` are one secret.
    """
    lowered = password.strip().lower()
    candidates: set[str] = set()
    # Strip first AND defang first: `s3cr3t123` only reaches `secret` when the
    # trailing digits come off before the leet substitution runs, since `1` maps
    # to `l` and would otherwise be baked into the middle of the word.
    for base in (lowered, _strip_padding(lowered)):
        defanged = _defang_leet(base)
        candidates.update({base, defanged, _strip_padding(defanged)})
    return any(candidate in COMMON_PASSWORDS for candidate in candidates if candidate)


def _strip_padding(value: str) -> str:
    return value.rstrip("0123456789!@#$%^&*_-.")


def contains_identifier(password: str, identifiers: Iterable[str | None]) -> bool:
    """True when the password is built out of a name the account already has.

    Short identifiers are skipped: a two-letter handle would reject half the
    dictionary, which is a worse outcome than the guess it prevents.
    """
    lowered = password.lower()
    for identifier in identifiers:
        for token in _identifier_tokens(identifier):
            if token in lowered:
                return True
    return False


def is_degenerate(password: str) -> bool:
    lowered = password.lower()
    if len(set(lowered)) == 1:
        return True
    return _has_sequence_run(lowered)


def _identifier_tokens(identifier: str | None) -> set[str]:
    """The pieces of an identifier worth refusing — the whole thing, and the
    words inside it, so `Alice Chen` also rules out `alice…` and `chen…`."""
    raw = (identifier or "").strip().lower()
    if not raw:
        return set()
    # An email is its local part; the domain is shared by the whole company and
    # would reject far too much.
    raw = raw.split("@", 1)[0]
    parts = {raw, *(part for part in _split_words(raw))}
    return {part for part in parts if len(part) >= 4}


def _split_words(value: str) -> list[str]:
    word = ""
    words: list[str] = []
    for char in value:
        if char.isalnum():
            word += char
        elif word:
            words.append(word)
            word = ""
    if word:
        words.append(word)
    return words


def _defang_leet(value: str) -> str:
    table = str.maketrans({"@": "a", "0": "o", "1": "l", "3": "e", "$": "s", "5": "s", "7": "t"})
    return value.translate(table)


def _has_sequence_run(value: str) -> bool:
    """A run of _MIN_SEQUENCE_RUN or more consecutive characters, forwards or
    backwards, along any of the alphabets above."""
    for alphabet in _SEQUENCE_ALPHABETS:
        reversed_alphabet = alphabet[::-1]
        for window_start in range(len(value) - _MIN_SEQUENCE_RUN + 1):
            window = value[window_start : window_start + _MIN_SEQUENCE_RUN]
            if window in alphabet or window in reversed_alphabet:
                return True
    return False
