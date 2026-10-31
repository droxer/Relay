"""Account, user, department, and login session records ⇄ database rows."""

from __future__ import annotations

from typing import Any

from .credentials import hash_session_token
from .home_snoozes import normalize_home_snoozes
from .onboarding import normalize_onboarding
from .user_handles import slugify_handle
from ..persistence.db_time import format_db_time, parse_db_time
from ..core.user_preferences import (
    DEFAULT_USER_LANGUAGE,
    DEFAULT_USER_THEME,
    USER_LANGUAGES,
    UserLanguage,
)

# Traditional Chinese was retired. A preference stored while it existed reads
# back as Simplified Chinese instead of dropping the reader to English.
_RETIRED_USER_LANGUAGES: dict[str, UserLanguage] = {"zh-TW": "zh-CN"}


def normalize_user_language(value: Any) -> UserLanguage:
    """Map any stored language value onto one the product still ships."""
    language = _RETIRED_USER_LANGUAGES.get(value, value) if isinstance(value, str) else value
    return language if language in USER_LANGUAGES else DEFAULT_USER_LANGUAGE


def public_account(account: dict[str, Any]) -> dict[str, Any]:
    """An Account as the API shows it: no password hash."""
    return {
        "id": account["id"],
        "username": account["username"],
        "email": account.get("email"),
        "role": account["role"],
        "userId": account.get("userId"),
        "displayName": account.get("displayName"),
        "theme": account.get("theme", DEFAULT_USER_THEME),
        "language": normalize_user_language(account.get("language")),
        "onboarding": normalize_onboarding(account.get("onboarding")),
        "homeSnoozes": normalize_home_snoozes(account.get("homeSnoozes")),
        "createdAt": account["createdAt"],
    }


def database_account_to_row(
    account: dict[str, Any],
    *,
    user_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or account["id"],
        "username": account["username"],
        "email": account.get("email"),
        "role": account["role"],
        "user_id": user_pk,
        "theme": account.get("theme", DEFAULT_USER_THEME),
        "language": normalize_user_language(account.get("language")),
        "onboarding": normalize_onboarding(account.get("onboarding")) or None,
        "home_snoozes": normalize_home_snoozes(account.get("homeSnoozes")) or None,
        "password_hash": account["passwordHash"],
        "created_at": parse_db_time(account["createdAt"]),
        "updated_at": parse_db_time(account["updatedAt"]),
    }


def user_to_row(
    user: dict[str, Any],
    *,
    department_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or user["id"],
        "handle": user.get("handle"),
        "display_name": user["displayName"],
        "email": user.get("email"),
        "department_id": department_pk,
        "max_local_computers": user.get("maxLocalComputers"),
        "created_at": parse_db_time(user["createdAt"]),
        "updated_at": parse_db_time(user["updatedAt"]),
    }


def department_to_row(
    department: dict[str, Any],
    *,
    parent_department_pk: str | None = None,
    database_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": database_id or department["id"],
        "name": department["name"],
        "parent_department_id": parent_department_pk,
        "created_at": parse_db_time(department["createdAt"]),
        "updated_at": parse_db_time(department["updatedAt"]),
    }


def row_to_department(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "parentDepartmentId": str(row["parent_department_id"])
        if row["parent_department_id"]
        else None,
        "createdAt": format_db_time(row["created_at"]),
        "updatedAt": format_db_time(row["updated_at"]),
    }


def row_to_user(row: Any) -> dict[str, Any]:
    limit = row["max_local_computers"]
    handle = row["handle"]
    return {
        "id": str(row["id"]),
        # Never fall back to the raw UUID: that is the string the @handle
        # grammar exists to keep off the screen. A row with no handle yet
        # (created outside the admin form) borrows its display name.
        "handle": handle or slugify_handle(row["display_name"]) or str(row["id"])[:8],
        "displayName": row["display_name"],
        "email": row["email"],
        "departmentId": str(row["department_id"]) if row["department_id"] else None,
        "maxLocalComputers": int(limit) if limit is not None else None,
        "createdAt": format_db_time(row["created_at"]),
        "updatedAt": format_db_time(row["updated_at"]),
    }


def user_with_department(
    user: dict[str, Any], departments: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    department = departments.get(user.get("departmentId") or "")
    if not department:
        return user
    return {**user, "departmentName": department["name"]}


def row_to_database_account(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "username": row["username"],
        "email": row["email"],
        "role": row["role"],
        "userId": str(row["user_id"]) if row["user_id"] else None,
        "theme": row["theme"],
        "language": normalize_user_language(row["language"]),
        "onboarding": normalize_onboarding(row["onboarding"]),
        "homeSnoozes": normalize_home_snoozes(row["home_snoozes"]),
        "passwordHash": row["password_hash"],
        "createdAt": format_db_time(row["created_at"]),
        "updatedAt": format_db_time(row["updated_at"]),
    }


def database_session_to_row(
    session: dict[str, Any], *, account_pk: str, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or session["id"],
        "token_hash": hash_session_token(session["token"]),
        "account_id": account_pk,
        "created_at": parse_db_time(session["createdAt"]),
        "expires_at": parse_db_time(session["expiresAt"]),
    }


def row_to_database_session(row: Any, token: str) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "token": token,
        "accountId": str(row["account_id"]),
        "createdAt": format_db_time(row["created_at"]),
        "expiresAt": format_db_time(row["expires_at"]),
    }
