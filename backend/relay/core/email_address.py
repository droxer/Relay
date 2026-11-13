"""The one rule for an email address Relay stores or matches.

An address is trimmed and lowercased, then checked for a plain
``local@domain.tld`` shape. Each part excludes whitespace, control
characters, and the characters that would let one "address" smuggle a display
name or a second recipient into a mail provider's ``to`` field.
"""

from __future__ import annotations

import re
from typing import Any

MAX_EMAIL_LENGTH = 254
_EMAIL_PART = r'[^@\s,;<>()"\\\x00-\x1f\x7f]+'
_EMAIL_PATTERN = re.compile(rf"^{_EMAIL_PART}@{_EMAIL_PART}\.{_EMAIL_PART}$")


def email_lookup_key(value: Any) -> str:
    """How an address is compared: trimmed and lowercased, never validated."""
    return value.strip().lower() if isinstance(value, str) else ""


def is_valid_email_address(value: Any) -> bool:
    email = email_lookup_key(value)
    return bool(email) and len(email) <= MAX_EMAIL_LENGTH and bool(_EMAIL_PATTERN.match(email))


def normalize_email_address(value: Any) -> str:
    """The stored form of ``value``; raises ``ValueError`` when it is not one."""
    if not is_valid_email_address(value):
        raise ValueError("Enter a valid email address.")
    return email_lookup_key(value)
