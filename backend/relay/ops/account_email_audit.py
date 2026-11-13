"""Which stored Account emails would break email sign-in, computed read-only.

Migration ``20261113_0126_account_email_identity`` adds a case-insensitive
unique index on ``auth_accounts.email``. Older releases stored emails without
normalizing or deduplicating them, so this audit answers, before and during
that migration, what the data actually holds. Nothing here writes: a conflict
is for an operator to resolve, never for the migration to guess at.

- ``duplicate_emails`` block the migration: two Accounts with one address
  (compared trimmed and lowercased) cannot both keep it.
- ``ambiguous_identifiers`` are legacy usernames equal to another Account's
  email. Sign-in refuses such an identifier for both, so they are reported,
  not blocking; each Account still signs in by its other identifier.
- The rest are notes: legacy Accounts without email (username sign-in only),
  malformed or unnormalized stored emails, and Accounts whose email differs
  from their User's.

``relay audit-account-emails`` prints the same report for a live database.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text

from ..core.email_address import email_lookup_key, is_valid_email_address


@dataclass(frozen=True)
class AccountEmailAudit:
    duplicate_emails: dict[str, list[str]] = field(default_factory=dict)
    ambiguous_identifiers: dict[str, list[str]] = field(default_factory=dict)
    invalid_emails: list[str] = field(default_factory=list)
    unnormalized_emails: list[str] = field(default_factory=list)
    user_email_mismatches: list[str] = field(default_factory=list)
    accounts_without_email: list[str] = field(default_factory=list)

    def blocking_message(self) -> str:
        """Why the unique index cannot be built, by Account id only (no addresses)."""
        groups = "; ".join(
            ", ".join(account_ids) for account_ids in self.duplicate_emails.values()
        )
        return (
            f"{len(self.duplicate_emails)} email address(es) are shared by more than one "
            f"Account (Account ids per address: {groups}). Give each Account its own "
            "email or clear the extra ones, then rerun the migration. "
            "Run `relay audit-account-emails` for the full report."
        )

    def notes(self) -> list[str]:
        """One line per non-blocking finding, by Account id only."""
        lines = []
        if self.ambiguous_identifiers:
            groups = "; ".join(", ".join(ids) for ids in self.ambiguous_identifiers.values())
            lines.append(
                "Sign-in identifiers shared by a username and another Account's email "
                f"(refused at sign-in for both): {groups}"
            )
        for label, account_ids in (
            ("Accounts with a malformed email", self.invalid_emails),
            ("Accounts with an unnormalized email", self.unnormalized_emails),
            ("Accounts whose email differs from their User's", self.user_email_mismatches),
            ("Accounts without email (username sign-in only)", self.accounts_without_email),
        ):
            if account_ids:
                lines.append(f"{label}: {', '.join(account_ids)}")
        return lines

    def as_report(self) -> dict[str, Any]:
        return {
            "blocking": bool(self.duplicate_emails),
            "duplicateEmails": self.duplicate_emails,
            "ambiguousIdentifiers": self.ambiguous_identifiers,
            "invalidEmails": self.invalid_emails,
            "unnormalizedEmails": self.unnormalized_emails,
            "userEmailMismatches": self.user_email_mismatches,
            "accountsWithoutEmail": self.accounts_without_email,
        }


def plan_account_email_audit(
    accounts: list[dict[str, Any]], user_emails: dict[str, Any]
) -> AccountEmailAudit:
    """The audit for rows of ``{id, username, email, user_id}`` and User emails by id."""
    by_email: dict[str, list[str]] = defaultdict(list)
    invalid: list[str] = []
    unnormalized: list[str] = []
    mismatched: list[str] = []
    without: list[str] = []
    for account in accounts:
        account_id, email = str(account["id"]), account.get("email")
        key = email_lookup_key(email)
        if not key:
            without.append(account_id)
            continue
        by_email[key].append(account_id)
        if not is_valid_email_address(email):
            invalid.append(account_id)
        elif email != key:
            unnormalized.append(account_id)
        user_id = account.get("user_id")
        if user_id is not None and str(user_id) in user_emails:
            if email_lookup_key(user_emails[str(user_id)]) != key:
                mismatched.append(account_id)
    ambiguous: dict[str, list[str]] = {}
    for account in accounts:
        username = account["username"]
        others = [other for other in by_email.get(username, []) if other != str(account["id"])]
        if others:
            ambiguous[username] = sorted({str(account["id"]), *others})
    return AccountEmailAudit(
        duplicate_emails={
            key: sorted(account_ids) for key, account_ids in sorted(by_email.items())
            if len(account_ids) > 1
        },
        ambiguous_identifiers=dict(sorted(ambiguous.items())),
        invalid_emails=sorted(invalid),
        unnormalized_emails=sorted(unnormalized),
        user_email_mismatches=sorted(mismatched),
        accounts_without_email=sorted(without),
    )


def audit_account_emails(connection: Any) -> AccountEmailAudit:
    """Read ``auth_accounts`` and ``users`` on ``connection`` and audit them."""
    accounts = [
        dict(row)
        for row in connection.execute(
            text("SELECT id, username, email, user_id FROM auth_accounts ORDER BY id")
        ).mappings()
    ]
    user_emails = {
        str(row["id"]): row["email"]
        for row in connection.execute(text("SELECT id, email FROM users")).mappings()
    }
    return plan_account_email_audit(accounts, user_emails)
