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

from ..core.connections import ConnectionConfig, ConnectionError, PROVIDERS, safe_return
from ..core.ids import new_database_id, now_iso
from ..persistence.connection.store import DatabaseConnectionStore
from . import providers


class ConnectionService:
    def __init__(self, store: DatabaseConnectionStore, configs: dict[str, ConnectionConfig], encryption_key: str | None):
        self.store, self.configs = store, configs
        self.cipher = Fernet(encryption_key.encode()) if encryption_key else None

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
        return [row for row in self.store.list(owner) if row["status"] != "disconnected"]

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
        if reconnect_id and self._connection(owner, reconnect_id)["provider"] != provider:
            raise ConnectionError("connection_identity_mismatch", 409)
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        self.store.issue_state(owner, state, self._seal({"provider": provider,
            "session": hashlib.sha256(session.encode()).hexdigest(), "verifier": verifier,
            "returnTo": return_to, "reconnectId": reconnect_id}))
        definition = PROVIDERS[provider]
        fields = {"client_id": config.client_id, "redirect_uri": config.callback_url,
            "response_type": "code", "scope": definition.scopes, "state": state}
        if definition.pkce:
            fields.update(code_challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode(),
                code_challenge_method="S256")
        if provider == "google-drive":
            fields.update(access_type="offline", prompt="consent")
        return definition.authorize_url + "?" + urlencode(fields)

    def complete(self, owner: str, session: str, provider: str, state: str, *, code: str | None,
                 denied: bool = False) -> tuple[dict[str, Any] | None, str]:
        sealed = self.store.consume_state(owner, state)
        pending = self._open(sealed) if sealed else {}
        if (pending.get("provider") != provider or not secrets.compare_digest(pending.get("session", ""),
                hashlib.sha256(session.encode()).hexdigest())):
            raise ConnectionError("connection_state_invalid")
        if denied:
            return None, pending["returnTo"]
        if not code or len(code) > 2000 or provider not in self.configs:
            raise ConnectionError("connection_state_invalid")
        config = self.configs[provider]
        fields = {"code": code, "redirect_uri": config.callback_url, "grant_type": "authorization_code"}
        if PROVIDERS[provider].pkce:
            fields["code_verifier"] = pending["verifier"]
        tokens = providers.exchange(config, fields)
        identity = providers.identity(provider, tokens["access_token"])
        reconnect_id = pending.get("reconnectId")
        old = self._connection(owner, reconnect_id) if reconnect_id else None
        if old and (old["subject"] != identity["subject"] or old["tenant"] != identity["tenant"]
                    or old["status"] == "disconnected"):
            raise ConnectionError("connection_identity_mismatch", 409)
        record = {"id": reconnect_id or new_database_id(), "provider": provider, **identity,
            "label": old["label"] if old else identity["identity"], "status": "connected",
            "revision": old["revision"] + 1 if old else 1, "updatedAt": now_iso(),
            "actions": list(PROVIDERS[provider].actions)}
        self.store.save(owner, record, self._seal(_tokens(tokens)))
        return record, pending["returnTo"]

    def token(self, owner: str, connection_id: str) -> str:
        with self.store.lock(connection_id):
            record = self._connection(owner, connection_id)
            if record["status"] != "connected" or record["provider"] not in self.configs:
                raise ConnectionError("connection_unavailable", 409)
            secret = self._open(record["sealedSecret"])
            if secret.get("expiresAt", float("inf")) <= time.time() + 60:
                if not secret.get("refresh_token"):
                    self._unavailable(owner, record)
                    raise ConnectionError("connection_reconnect_required", 409)
                try:
                    refreshed = providers.exchange(self.configs[record["provider"]],
                        {"grant_type": "refresh_token", "refresh_token": secret["refresh_token"]})
                except ConnectionError as error:
                    if error.code == "connection_reconnect_required":
                        self._unavailable(owner, record)
                    raise
                secret = {**secret, **_tokens(refreshed)}
                self.store.save(owner, _public(record), self._seal(secret))
            return str(secret["access_token"])

    def _unavailable(self, owner: str, record: dict[str, Any]) -> None:
        self.store.save(owner, {**_public(record), "status": "reconnect_required",
            "revision": record["revision"] + 1, "updatedAt": now_iso()}, record.get("sealedSecret"))

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
        result = self.grants(owner, "task" if task_id else "thread", task_id or thread_id)
        for grant in result:
            record = self._connection(owner, grant["connectionId"])
            if record["status"] != "connected" or record["provider"] not in self.configs:
                raise ConnectionError("connection_unavailable", 409)
            current = self._current_grant(owner, grant)
            if not current or not current["resources"] or not current["actions"]:
                raise ConnectionError("connection_access_denied", 403)
        return result

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
        if target_type not in {"thread", "task", "automation"} or not isinstance(raw, list) or len(raw) > 10:
            raise ConnectionError("connection_grants_invalid")
        normalized, seen = [], set()
        for item in raw:
            if not isinstance(item, dict) or set(item) - {"id", "revision", "connectionId", "resources", "actions"}:
                raise ConnectionError("connection_grants_invalid")
            record = self._connection(owner, item.get("connectionId", ""))
            if record["status"] != "connected" or record["id"] in seen:
                raise ConnectionError("connection_grants_invalid")
            resources, actions = item.get("resources"), item.get("actions")
            if (not isinstance(resources, list) or not 1 <= len(resources) <= 100
                    or not all(providers.valid_resource(record["provider"], resource) for resource in resources)
                    or not isinstance(actions, list) or not actions
                    or not all(isinstance(action, str) and action in record["actions"] for action in actions)):
                raise ConnectionError("connection_grants_invalid")
            seen.add(record["id"])
            normalized.append({"connectionId": record["id"], "resources": sorted(set(resources)), "actions": sorted(set(actions))})
        return self.store.set_grants(owner, target_type, target_id, normalized)

    def call(self, owner: str, snapshot: builtins.list[dict[str, Any]], connection_id: str,
             action: str, resource: str, arguments: Any) -> Any:
        record = self._connection(owner, connection_id)
        if record["status"] != "connected":
            raise ConnectionError("connection_unavailable", 409)
        for grant in snapshot:
            current = self._current_grant(owner, grant)
            if (current and current["connectionId"] == grant["connectionId"] == connection_id
                    and action in grant["actions"] and action in current["actions"]
                    and resource in grant["resources"] and resource in current["resources"]):
                if not isinstance(arguments, dict):
                    raise ConnectionError("connection_arguments_invalid")
                try:
                    return providers.call(record["provider"], self.token(owner, connection_id), action, resource, arguments)
                except ConnectionError as error:
                    if error.code == "connection_reconnect_required":
                        self._unavailable(owner, self._connection(owner, connection_id))
                    raise
        raise ConnectionError("connection_access_denied", 403)


def _public(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key != "sealedSecret"}


def _tokens(tokens: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {key: tokens[key] for key in ("access_token", "refresh_token") if key in tokens}
    if tokens.get("expires_in"):
        result["expiresAt"] = time.time() + tokens["expires_in"]
    return result
