"""User-scoped authentication and explicitly bounded service access."""

import base64
import builtins
import hashlib
import json
import secrets
import time
from typing import Any
from urllib.parse import urlencode

from cryptography.fernet import Fernet, InvalidToken

from ..core.connections import (
    ConnectionConfig, ConnectionError, MAIL_AUTHORIZATION_VERSION, MAIL_PROVIDERS, PROVIDERS, safe_return,
)
from ..core.ids import new_database_id, now_iso
from ..persistence.connection.store import DatabaseConnectionStore
from ..security.rate_limit import AuthRateLimiter
from . import mail, mail_oauth, providers


class MailAuthorizationError(ConnectionError):
    def __init__(self, error: ConnectionError, return_to: str):
        super().__init__(error.code, error.status)
        self.return_to = return_to


class ConnectionService:
    def __init__(self, store: DatabaseConnectionStore, configs: dict[str, ConnectionConfig], encryption_key: str | None):
        self.store = store
        self.configs = {key: value for key, value in configs.items() if key in PROVIDERS}
        self.cipher = Fernet(encryption_key.encode()) if encryption_key else None
        self.tool_limiter = AuthRateLimiter(attempts=120, window_seconds=60)

    def issue_run_token(self, claims: dict[str, Any]) -> str:
        return self._seal({**claims, "purpose": "connection-run", "expiresAt": time.time() + 86400})

    def read_run_token(self, token: str) -> dict[str, Any]:
        claims = self._open(token)
        if (claims.get("purpose") != "connection-run" or claims.get("expiresAt", 0) <= time.time()
                or not all(isinstance(claims.get(key), str) for key in ("owner", "nodeId", "commandId", "leaseId", "runId"))):
            raise ConnectionError("connection_run_credential_invalid", 401)
        return claims

    def _seal(self, value: dict[str, Any]) -> str:
        if not self.cipher:
            raise ConnectionError("connections_not_configured", 503)
        return self.cipher.encrypt(json.dumps(value).encode()).decode()

    def _open(self, value: str) -> dict[str, Any]:
        if not self.cipher:
            raise ConnectionError("connections_not_configured", 503)
        try:
            return json.loads(self.cipher.decrypt(value.encode()))
        except (InvalidToken, ValueError) as error:
            raise ConnectionError("connection_reconnect_required", 409) from error

    def catalog(self) -> builtins.list[dict[str, Any]]:
        return [{"id": key, "name": provider.name, "configured": key in self.configs,
            "actions": list(provider.actions)} for key, provider in PROVIDERS.items()]

    def list(self, owner: str) -> builtins.list[dict[str, Any]]:
        return [row for row in self.store.list(owner) if row["status"] != "disconnected" and _supported(row)]

    def _connection(self, owner: str, connection_id: str) -> dict[str, Any]:
        record = self.store.get(owner, connection_id)
        if not record:
            raise ConnectionError("connection_not_found", 404)
        return record

    def start(self, owner: str, session: str, provider: str, return_to: str,
              reconnect_id: str | None = None) -> str:
        return_to = safe_return(return_to)
        config = self.configs.get(provider)
        if not config:
            raise ConnectionError("connection_provider_not_configured", 503)
        if reconnect_id:
            record = self._connection(owner, reconnect_id)
            if record["provider"] != provider or not _supported(record) or record["status"] == "disconnected":
                raise ConnectionError("connection_identity_mismatch", 409)
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        pending = {"provider": provider, "session": hashlib.sha256(session.encode()).hexdigest(),
            "verifier": verifier, "returnTo": return_to, "reconnectId": reconnect_id}
        definition = PROVIDERS[provider]
        fields = {"client_id": config.client_id, "redirect_uri": config.callback_url,
            "response_type": "code", "scope": definition.scopes, "state": state}
        if provider in MAIL_PROVIDERS:
            fields["nonce"] = pending["nonce"] = secrets.token_urlsafe(32)
            fields["prompt"] = "select_account"
            if provider == "gmail":
                fields.update(access_type="offline", prompt="consent select_account")
        if definition.pkce:
            fields.update(code_challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode(),
                code_challenge_method="S256")
        self.store.issue_state(owner, state, self._seal(pending))
        return definition.authorize_url + "?" + urlencode(fields)

    def complete(self, owner: str, session: str, provider: str, state: str, *, code: str | None,
                 denied: bool = False, organization_policy: bool = False) -> tuple[dict[str, Any] | None, str]:
        sealed = self.store.consume_state(owner, state)
        pending = self._open(sealed) if sealed else {}
        if (pending.get("provider") != provider or not secrets.compare_digest(pending.get("session", ""),
                hashlib.sha256(session.encode()).hexdigest())):
            raise ConnectionError("connection_state_invalid")
        if denied:
            if organization_policy and provider in MAIL_PROVIDERS:
                raise MailAuthorizationError(ConnectionError("connection_organization_policy", 403), pending["returnTo"])
            return None, pending["returnTo"]
        if not code or len(code) > 8192 or provider not in self.configs:
            raise ConnectionError("connection_state_invalid")
        try:
            return self._complete(owner, provider, code, pending), pending["returnTo"]
        except ConnectionError as error:
            if provider in MAIL_PROVIDERS:
                raise MailAuthorizationError(error, pending["returnTo"]) from error
            raise

    def _complete(self, owner: str, provider: str, code: str, pending: dict[str, Any]) -> dict[str, Any]:
        config = self.configs[provider]
        fields = {"code": code, "redirect_uri": config.callback_url, "grant_type": "authorization_code"}
        if PROVIDERS[provider].pkce:
            fields["code_verifier"] = pending["verifier"]
        tokens = providers.exchange(config, fields)
        _require_scope(provider, tokens)
        is_mail = provider in MAIL_PROVIDERS
        identity = (mail_oauth.verify_identity(providers.request, config, tokens, pending.get("nonce", ""))
                    if is_mail else providers.identity(provider, tokens["access_token"]))
        reconnect_id = pending.get("reconnectId")
        connection_id = reconnect_id or new_database_id()
        with self.store.lock(connection_id):
            old = self._connection(owner, reconnect_id) if reconnect_id else None
            if old and (old["subject"] != identity["subject"] or old["tenant"] != identity["tenant"]
                        or old["provider"] != provider or old["status"] == "disconnected" or not _supported(old)):
                raise ConnectionError("connection_identity_mismatch", 409)
            record = {"id": connection_id, "provider": provider, **identity,
                "label": old["label"] if old else identity["identity"], "status": "connected",
                "revision": old["revision"] + 1 if old else 1, "updatedAt": now_iso(),
                "actions": list(PROVIDERS[provider].actions)}
            secret = _tokens(tokens)
            if is_mail:
                record["mailAuthorizationVersion"] = MAIL_AUTHORIZATION_VERSION
                if not secret.get("refresh_token") and old and old["status"] == "connected":
                    previous = self._open(old["sealedSecret"])
                    if previous.get("refreshExpiresAt", float("inf")) > time.time() and previous.get("refresh_token"):
                        secret = {**previous, **secret}
                if not secret.get("refresh_token"):
                    raise ConnectionError("connection_offline_access_required", 422)
            self.store.save(owner, record, self._seal(secret))
        return record

    def token(self, owner: str, connection_id: str) -> str:
        with self.store.lock(connection_id):
            record = self._connection(owner, connection_id)
            provider = record["provider"]
            if record["status"] != "connected" or provider not in self.configs or not _supported(record):
                raise ConnectionError("connection_unavailable", 409)
            secret = self._open(record["sealedSecret"])
            if secret.get("expiresAt", float("inf")) > time.time() + 60:
                return str(secret["access_token"])
            if secret.get("refresh_token") and secret.get("refreshExpiresAt", float("inf")) > time.time():
                try:
                    refreshed = providers.exchange(self.configs[provider],
                        {"grant_type": "refresh_token", "refresh_token": secret["refresh_token"]})
                    if provider in MAIL_PROVIDERS and "scope" in refreshed:
                        _require_scope(provider, refreshed)
                except ConnectionError as error:
                    if error.code not in {"connection_reconnect_required", "connection_permissions_invalid"}:
                        raise
                else:
                    if refreshed.get("refresh_token"):
                        secret.pop("refreshExpiresAt", None)
                    secret = {**secret, **_tokens(refreshed)}
                    self.store.save(owner, _public(record), self._seal(secret))
                    return str(secret["access_token"])
            self._unavailable(owner, record)
        raise ConnectionError("connection_reconnect_required", 409)

    def _unavailable(self, owner: str, record: dict[str, Any], token: str | None = None) -> None:
        with self.store.lock(record["id"]):
            current = self._connection(owner, record["id"])
            if current["status"] != "connected" or current["revision"] != record["revision"]:
                return
            if token is not None and self._open(current["sealedSecret"]).get("access_token") != token:
                return
            self.store.save(owner, {**_public(current), "status": "reconnect_required",
                "revision": current["revision"] + 1, "updatedAt": now_iso()}, current.get("sealedSecret"))

    def github_import_token(self, owner: str, connection_id: str) -> str:
        """User-initiated issue import; never borrows another owner's Connection."""
        record = self._connection(owner, connection_id)
        if record["provider"] != "github" or "github.list_issues" not in record["actions"]:
            raise ConnectionError("connection_access_denied", 403)
        return self.token(owner, connection_id)

    def resources(self, owner: str, connection_id: str, cursor: str = "") -> dict[str, Any]:
        record = self._connection(owner, connection_id)
        return providers.resources(record["provider"], self.token(owner, connection_id), cursor)

    def disconnect(self, owner: str, connection_id: str) -> None:
        with self.store.lock(connection_id):
            record = self._connection(owner, connection_id)
            if record["status"] != "disconnected":
                self.store.save(owner, {**_public(record), "status": "disconnected",
                    "revision": record["revision"] + 1, "updatedAt": now_iso()}, None)

    def grants(self, owner: str, target_type: str, target_id: str) -> builtins.list[dict[str, Any]]:
        return self.store.grants(owner, target_type, target_id)

    def for_work(self, owner: str, thread_id: str, task_id: str | None = None) -> builtins.list[dict[str, Any]]:
        return self.check_target(owner, "task" if task_id else "thread", task_id or thread_id)

    def check_target(self, owner: str, kind: str, target_id: str) -> builtins.list[dict[str, Any]]:
        result = self.grants(owner, kind, target_id)
        effective = []
        for grant in result:
            record = self._connection(owner, grant["connectionId"])
            if record["status"] != "connected" or record["provider"] not in self.configs or not _supported(record):
                raise ConnectionError("connection_unavailable", 409)
            current = self._current_grant(owner, grant)
            if not current or not current["resources"] or not current["actions"]:
                raise ConnectionError("connection_access_denied", 403)
            effective.append(current)
        return effective

    def disconnect_all(self, owner: str) -> None:
        with self.store.lock(owner):
            for record in self.store.list(owner):
                self.disconnect(owner, record["id"])
            self.store.clear_authorizations(owner)

    def _current_grant(self, owner: str, grant: dict[str, Any]) -> dict[str, Any] | None:
        current = self.store.grant(owner, grant["id"])
        if current and current.get("sourceGrantId"):
            source = self.store.grant(owner, current["sourceGrantId"])
            if not source or source["connectionId"] != current["connectionId"]:
                return None
            current = {**current, "resources": list(set(current["resources"]) & set(source["resources"])),
                "actions": list(set(current["actions"]) & set(source["actions"]))}
        return current

    def set_grants(self, owner: str, target_type: str, target_id: str, raw: Any) -> builtins.list[dict[str, Any]]:
        if target_type not in {"thread", "task", "automation"}:
            raise ConnectionError("connection_grants_invalid")
        return self.store.set_grants(owner, target_type, target_id, self.validate_grants(owner, raw))

    def validate_grants(self, owner: str, raw: Any) -> builtins.list[dict[str, Any]]:
        if not isinstance(raw, list) or len(raw) > 10:
            raise ConnectionError("connection_grants_invalid")
        normalized, seen = [], set()
        for item in raw:
            if not isinstance(item, dict) or set(item) - {"id", "revision", "connectionId", "resources", "actions"}:
                raise ConnectionError("connection_grants_invalid")
            record = self._connection(owner, item.get("connectionId", ""))
            provider = record["provider"]
            if record["status"] != "connected" or not _supported(record) or record["id"] in seen:
                raise ConnectionError("connection_grants_invalid")
            resources, actions = item.get("resources"), item.get("actions")
            if (not isinstance(resources, list) or not 1 <= len(resources) <= 100
                    or not all(providers.valid_resource(provider, resource) for resource in resources)
                    or not isinstance(actions, list) or not actions
                    or not all(isinstance(action, str) and action in record["actions"] for action in actions)):
                raise ConnectionError("connection_grants_invalid")
            if provider in MAIL_PROVIDERS and f"{provider}.get_message" in actions and f"{provider}.list_messages" not in actions:
                raise ConnectionError("connection_grants_invalid")
            seen.add(record["id"])
            expected = {key: item[key] for key in ("id", "revision") if key in item}
            if expected and (set(expected) != {"id", "revision"} or not isinstance(expected["id"], str)
                    or type(expected["revision"]) is not int or expected["revision"] < 1):
                raise ConnectionError("connection_grants_invalid")
            normalized.append({"connectionId": record["id"], "resources": sorted(set(resources)),
                "actions": sorted(set(actions)), **expected})
        return normalized

    def call(self, owner: str, snapshot: builtins.list[dict[str, Any]], connection_id: str,
             action: str, resource: str, arguments: Any, *, run_id: str | None = None) -> Any:
        record = self._connection(owner, connection_id)
        provider = record["provider"]
        if record["status"] != "connected" or not _supported(record):
            raise ConnectionError("connection_unavailable", 409)
        if action not in PROVIDERS[provider].actions or not providers.valid_resource(provider, resource):
            raise ConnectionError("connection_access_denied", 403)
        for grant in snapshot:
            current = self._current_grant(owner, grant)
            if (current and current["connectionId"] == grant["connectionId"] == connection_id
                    and action in grant["actions"] and action in current["actions"]
                    and resource in grant["resources"] and resource in current["resources"]):
                if not isinstance(arguments, dict):
                    raise ConnectionError("connection_arguments_invalid")
                token = self.token(owner, connection_id)
                try:
                    if provider in MAIL_PROVIDERS:
                        if not run_id:
                            raise ConnectionError("connection_run_unavailable", 409)
                        references = mail.MailReferences(connection_id, run_id, self._seal, self._open)
                        return mail.call(provider, token, action, arguments, references)
                    return providers.call(provider, token, action, resource, arguments)
                except ConnectionError as error:
                    if error.code == "connection_reconnect_required":
                        self._unavailable(owner, record, token)
                    raise
        raise ConnectionError("connection_access_denied", 403)


def _public(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key != "sealedSecret"}


def _supported(record: dict[str, Any]) -> bool:
    provider = record.get("provider")
    return provider in PROVIDERS and (provider not in MAIL_PROVIDERS
        or record.get("mailAuthorizationVersion") == MAIL_AUTHORIZATION_VERSION)


def _require_scope(provider: str, tokens: dict[str, Any]) -> None:
    scopes = set(str(tokens.get("scope", "")).replace(",", " ").split())
    required = PROVIDERS[provider].required_scope
    if provider == "outlook":
        scopes = {scope.lower().removeprefix("https://graph.microsoft.com/") for scope in scopes}
        required = required.lower().removeprefix("https://graph.microsoft.com/")
    if required not in scopes:
        raise ConnectionError("connection_permissions_invalid", 422)


def _tokens(tokens: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {key: tokens[key] for key in ("access_token", "refresh_token") if tokens.get(key)}
    if tokens.get("expires_in"):
        result["expiresAt"] = time.time() + tokens["expires_in"]
    if tokens.get("refresh_token_expires_in"):
        result["refreshExpiresAt"] = time.time() + tokens["refresh_token_expires_in"]
    return result
