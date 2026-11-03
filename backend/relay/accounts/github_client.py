"""GitHub App authorization calls, with fixed hosts and no redirects."""

from typing import Any

import httpx

from ..core.github_connection import GitHubConfig

transport: httpx.BaseTransport | None = None


class GitHubConnectionError(Exception):
    def __init__(self, code: str, status: int = 422):
        super().__init__(code)
        self.code, self.status = code, status


def _json(method: str, url: str, **kwargs: Any) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=15, follow_redirects=False, transport=transport) as client:
            response = client.request(method, url, **kwargs)
        if response.status_code != 200:
            raise GitHubConnectionError("github_connection_rejected")
        result = response.json()
        if not isinstance(result, dict) or result.get("error"):
            raise GitHubConnectionError("github_connection_rejected")
        return result
    except (httpx.HTTPError, ValueError) as error:
        raise GitHubConnectionError("github_connection_unavailable", 502) from error


def exchange(config: GitHubConfig, fields: dict[str, str]) -> dict[str, Any]:
    result = _json("POST", "https://github.com/login/oauth/access_token", headers={"Accept": "application/json"},
        data={"client_id": config.client_id, "client_secret": config.client_secret, **fields})
    if not isinstance(result.get("access_token"), str) or not result["access_token"]:
        raise GitHubConnectionError("github_connection_rejected")
    for key in ("expires_in", "refresh_token_expires_in"):
        if key in result and (type(result[key]) is not int or result[key] <= 0):
            raise GitHubConnectionError("github_connection_rejected")
    if "refresh_token" in result and not isinstance(result["refresh_token"], str):
        raise GitHubConnectionError("github_connection_rejected")
    return result


def identity(token: str) -> dict[str, Any]:
    result = _api("/user", token)
    if not isinstance(result.get("login"), str) or not isinstance(result.get("id"), int):
        raise GitHubConnectionError("github_connection_rejected")
    return {"login": result["login"], "githubId": result["id"]}


def verify_installation(token: str, installation_id: int) -> None:
    # GitHub checks both the user's access and this App's installation scope.
    if existing_installation(token, installation_id) is None:
        raise GitHubConnectionError("github_connection_rejected")
    _api(f"/user/installations/{installation_id}/repositories?per_page=1", token)


def existing_installation(token: str, installation_id: int | None = None) -> int | None:
    result = _api("/user/installations?per_page=100", token)
    installations = result.get("installations")
    if not isinstance(installations, list):
        raise GitHubConnectionError("github_connection_rejected")
    for item in installations:
        if not isinstance(item, dict) or type(item.get("id")) is not int or item["id"] < 1:
            continue
        if installation_id is not None and item["id"] != installation_id:
            continue
        permissions = item.get("permissions") or {}
        if not isinstance(permissions, dict) or permissions.get("issues") != "read" or any(
            key not in {"issues", "metadata"} and value != "none" for key, value in permissions.items()
        ) or any(value not in {"read", "none"} for value in permissions.values()):
            raise GitHubConnectionError("github_connection_permissions_invalid", 503)
        return item["id"]
    return None


def _api(path: str, token: str) -> dict[str, Any]:
    return _json("GET", f"https://api.github.com{path}", headers={"Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
