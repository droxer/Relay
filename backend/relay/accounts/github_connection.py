"""Account-scoped GitHub App authorization and encrypted credential lifecycle."""

import base64
import hashlib
import json
import secrets
import time
from typing import Any
from urllib.parse import urlencode, urlsplit

from cryptography.fernet import Fernet, InvalidToken

from ..core.github_connection import GitHubConfig
from ..persistence.account.github import DatabaseGitHubConnectionStore
from .github_client import GitHubConnectionError, exchange, existing_installation, identity, verify_installation


class GitHubConnectionService:
    def __init__(self, store: DatabaseGitHubConnectionStore, config: GitHubConfig | None):
        self.store, self.config = store, config

    def _config(self) -> GitHubConfig:
        if not self.config:
            raise GitHubConnectionError("github_connection_not_configured", 503)
        return self.config

    def _seal(self, value: dict[str, Any]) -> str:
        return Fernet(self._config().encryption_key.encode()).encrypt(json.dumps(value).encode()).decode()

    def _open(self, sealed: str) -> dict[str, Any]:
        try:
            return json.loads(Fernet(self._config().encryption_key.encode()).decrypt(sealed.encode()))
        except (InvalidToken, ValueError) as error:
            raise GitHubConnectionError("github_reconnect_required") from error

    def status(self, account_id: str) -> dict[str, Any]:
        status: dict[str, Any] = {"configured": bool(self.config), "connected": False, "login": None,
            "manageUrl": "https://github.com/settings/installations" if self.config else None}
        sealed = self.store.read_connection(account_id) if self.config else None
        if sealed:
            try:
                status.update(connected=True, login=self._open(sealed)["login"])
            except GitHubConnectionError:
                status["reconnectRequired"] = True
        return status

    def start(self, account_id: str, session: str, return_to: str) -> str:
        config = self._config()
        _validate_return_to(return_to)
        verifier = secrets.token_urlsafe(48)
        state = secrets.token_urlsafe(32)
        with self.store.lock(account_id):
            self.store.issue_state(account_id, state, self._seal({"phase": "authorize", "verifier": verifier,
                "session": _digest(session), "returnTo": return_to}))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        return "https://github.com/login/oauth/authorize?" + urlencode({"client_id": config.client_id,
            "redirect_uri": config.callback_url, "state": state, "scope": "offline_access",
            "prompt": "select_account",
            "code_challenge": challenge, "code_challenge_method": "S256"})

    def complete(self, account_id: str, session: str, state: str, *, code: str | None,
                 installation_id: int | None, denied: bool = False) -> str:
        self._config()
        with self.store.lock(account_id):
            sealed = self.store.consume_state(account_id, state)
            if not sealed:
                raise GitHubConnectionError("github_connection_state_invalid", 400)
            pending = self._open(sealed)
            if not secrets.compare_digest(pending["session"], _digest(session)):
                raise GitHubConnectionError("github_connection_state_invalid", 400)
            if denied:
                return _return_url(pending["returnTo"], "cancelled")
            try:
                return self._finish(account_id, pending, code, installation_id)
            except GitHubConnectionError as error:
                if error.code == "github_connection_state_invalid":
                    raise
                result = "permissions" if error.code == "github_connection_permissions_invalid" else "failed"
                return _return_url(pending["returnTo"], result)

    def _finish(self, account_id: str, pending: dict[str, Any], code: str | None, installation_id: int | None) -> str:
        config = self._config()
        if pending["phase"] == "authorize" and code:
            tokens = exchange(config, {"code": code, "redirect_uri": config.callback_url,
                "code_verifier": pending["verifier"]})
            token_data = {**_tokens(tokens), **identity(tokens["access_token"])}
            if existing_id := existing_installation(tokens["access_token"]):
                verify_installation(tokens["access_token"], existing_id)
                self.store.save_connection(account_id, self._seal({**token_data, "installationId": existing_id}))
                return _return_url(pending["returnTo"], "connected")
            next_state = secrets.token_urlsafe(32)
            self.store.issue_state(account_id, next_state, self._seal({"phase": "install",
                "session": pending["session"], "returnTo": pending["returnTo"], "connection": token_data}))
            return f"https://github.com/apps/{config.app_slug}/installations/new?" + urlencode({"state": next_state})
        if pending["phase"] == "install" and installation_id and installation_id > 0:
            connection = pending["connection"]
            verify_installation(connection["access_token"], installation_id)
            self.store.save_connection(account_id, self._seal({**connection, "installationId": installation_id}))
            return _return_url(pending["returnTo"], "connected")
        raise GitHubConnectionError("github_connection_state_invalid", 400)

    def token_for(self, account_id: str) -> str | None:
        if not self.config:
            return None
        with self.store.lock(account_id):
            sealed = self.store.read_connection(account_id)
            if not sealed:
                return None
            connection = self._open(sealed)
            if connection.get("expiresAt", float("inf")) <= time.time() + 60:
                if not connection.get("refresh_token") or connection.get("refreshExpiresAt", 0) <= time.time():
                    raise GitHubConnectionError("github_reconnect_required")
                try:
                    tokens = exchange(self.config, {"grant_type": "refresh_token", "refresh_token": connection["refresh_token"]})
                except GitHubConnectionError as error:
                    if error.code == "github_connection_rejected":
                        raise GitHubConnectionError("github_reconnect_required") from error
                    raise
                connection = {**connection, **_tokens(tokens)}
                self.store.save_connection(account_id, self._seal(connection))
            return connection["access_token"]


def _tokens(tokens: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"access_token": tokens["access_token"]}
    if tokens.get("expires_in"):
        result["expiresAt"] = time.time() + int(tokens["expires_in"])
    if tokens.get("refresh_token"):
        result.update(refresh_token=tokens["refresh_token"],
            refreshExpiresAt=time.time() + int(tokens.get("refresh_token_expires_in") or 0))
    return result


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _validate_return_to(value: str) -> None:
    parts = urlsplit(value)
    if (not value.startswith("/") or value.startswith("//") or "\\" in value
            or any(ord(char) < 32 for char in value) or parts.scheme or parts.netloc or parts.fragment):
        raise GitHubConnectionError("github_connection_return_invalid", 400)


def _return_url(path: str, result: str) -> str:
    return path + ("&" if "?" in path else "?") + urlencode({"githubConnection": result})
