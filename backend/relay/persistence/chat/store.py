"""Chat configuration and credentials, isolated by integration in the database."""

from collections.abc import Iterator
from contextlib import AbstractAsyncContextManager, contextmanager, nullcontext
import os
import secrets
from typing import Any

from cryptography.fernet import Fernet
from sqlalchemy import inspect, select

from ...core.ids import new_relay_id, now_iso
from ...chat.rules import (
    SECRET_FIELDS,
    _conversation_allowed,
    _conversation_key,
    _identity_link,
    _provider,
    _public_config,
    _required_string,
    _status,
    _string,
    list_field,
    public_callback_base_url,
)
from ..engine import create_all_tables, shared_engine, store_transaction
from ..resource_lock import resource_transaction
from ..sql import metadata as shared_metadata
from ..tables import chat as tables
from . import integrations as records
from . import secrets as credentials
from .audit import append_audit_event, read_audit_events
from .backfill import convert_sqlite_records
from .configuration_backfill import convert_sqlite_configuration
from .conversations import bind_conversation, clear_conversations, get_conversation
from .coordination import chat_operation, provider_operation


class DatabaseChatIntegrationStore:
    metadata = shared_metadata
    documents = tables.documents

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        raw_key = os.environ.get("RELAY_CHAT_SECRET_KEY", "").strip()
        self._secret_cipher = Fernet(raw_key.encode()) if raw_key else None
        if create_schema:
            create_all_tables(self.engine)
            if self.engine.dialect.name == "sqlite":
                convert_sqlite_records(self.engine)
                convert_sqlite_configuration(self.engine)

    def verify_schema(self) -> None:
        required = {
            "chat_documents",
            "chat_audit_events",
            "chat_conversations",
            "chat_integrations",
            "chat_integration_secrets",
        }
        with self.engine.connect() as conn:
            missing = required - set(inspect(conn).get_table_names())
            if missing:
                raise RuntimeError(
                    f"Database is missing chat record tables: {', '.join(sorted(missing))}. Run backend migrations."
                )
            legacy = conn.scalar(
                select(self.documents.c.document_key)
                .where(
                    self.documents.c.document_key.in_(("audit", "conversations", "integrations")),
                )
                .limit(1)
            )
            if legacy:
                raise RuntimeError("Legacy chat records require migrations through 20261106_0117 before startup.")

    def _prepare_credentials(self) -> None:
        credentials.ensure_legacy_secrets_converted(self.engine, self._secret_cipher)

    @contextmanager
    def _mutation(self, integration_id: str) -> Iterator[None]:
        self._prepare_credentials()
        with resource_transaction(self.engine, f"chat-integration:{integration_id}"):
            yield

    def list_integrations(self) -> list[dict[str, Any]]:
        self._prepare_credentials()
        return [self._public(item, keys) for item, keys in records.public_records(self.engine)]

    def get_integration(self, integration_id: str) -> dict[str, Any]:
        self._prepare_credentials()
        rows = records.public_records(self.engine, integration_id)
        if not rows:
            raise KeyError(integration_id)
        return self._public(*rows[0])

    @staticmethod
    def _public(integration: dict[str, Any], keys: list[str]) -> dict[str, Any]:
        return {
            **integration,
            "secretConfigured": bool(keys),
            "secretKeys": list(keys),
            "identityLinkCount": len(list_field(integration, "identityLinks")),
            "allowedConversationCount": len(list_field(integration, "allowedConversations")),
        }

    def _public_integration(self, integration: dict[str, Any]) -> dict[str, Any]:
        return self._public(integration, credentials.secret_keys(self.engine, integration["id"]))

    def create_integration(self, payload: dict[str, Any], actor: str | None = None) -> dict[str, Any]:
        payload = dict(payload)
        provider = _provider(payload.get("provider"))
        raw_secrets = payload.get("secrets")
        values = dict(raw_secrets) if isinstance(raw_secrets, dict) else {}
        if provider == "telegram":
            values["webhookSecret"] = secrets.token_urlsafe(32)
        now = now_iso()
        integration: dict[str, Any] = {
            "id": new_relay_id("chat"),
            "provider": provider,
            "displayName": _string(payload.get("displayName")) or provider.title(),
            "tenantId": _string(payload.get("tenantId")),
            "status": "draft",
            "config": _public_config(payload.get("config")),
            "health": {"ok": False, "message": "Not checked yet.", "lastCheckedAt": None},
            "identityLinks": [],
            "allowedConversations": [],
            "createdAt": now,
            "updatedAt": now,
        }
        with self._mutation(integration["id"]):
            records.write_integration(self.engine, integration, create=True)
            self._write_secret_patch(integration["id"], values)
            self._audit("chat.integration.created", integration["id"], actor, {"provider": provider})
            return self._public_integration(integration)

    def update_integration(
        self, integration_id: str, payload: dict[str, Any], actor: str | None = None
    ) -> dict[str, Any]:
        guard = (
            chat_operation(self.engine, integration_id)
            if {"tenantId", "config", "secrets", "status"}.intersection(payload)
            else nullcontext()
        )
        with guard, self._mutation(integration_id):
            integration = records.read_integration(self.engine, integration_id)
            patch = payload.get("secrets")
            if integration.get("provider") == "telegram" and isinstance(patch, dict) and "webhookSecret" in patch:
                raise ValueError("Use the Telegram webhook secret rotation action instead.")
            updated = dict(integration)
            if "displayName" in payload:
                name = _string(payload.get("displayName"))
                if not name:
                    raise ValueError("displayName is required.")
                updated["displayName"] = name
            if "tenantId" in payload:
                updated["tenantId"] = _string(payload.get("tenantId"))
            if "status" in payload:
                updated["status"] = _status(payload.get("status"))
            if "config" in payload:
                updated["config"] = _public_config(payload.get("config"))
            if {"tenantId", "config", "secrets"}.intersection(payload):
                updated["health"] = {
                    "ok": False,
                    "message": "Run the provider connection check again.",
                    "lastCheckedAt": None,
                }
                if updated.get("status") == "active":
                    updated["status"] = "degraded"
            updated["updatedAt"] = now_iso()
            records.write_integration(self.engine, updated)
            self._write_secret_patch(integration_id, patch)
            self._audit("chat.integration.updated", integration_id, actor, {"fields": sorted(payload)})
            return self._public_integration(updated)

    def _validate_activation_integration(self, integration: dict[str, Any]) -> None:
        public = self._public_integration(integration)
        if public["identityLinkCount"] == 0:
            raise ValueError("Add at least one identity link before activation.")
        if public["allowedConversationCount"] == 0:
            raise ValueError("Add at least one allowed conversation before activation.")
        if not public["secretConfigured"]:
            raise ValueError("Configure provider secrets before activation.")
        if not public.get("health", {}).get("ok"):
            raise ValueError("Run a successful provider connection check before activation.")
        if integration.get("provider") == "telegram":
            public_callback_base_url(integration)

    def validate_activation(self, integration_id: str) -> None:
        self._prepare_credentials()
        with store_transaction(self.engine):
            self._validate_activation_integration(records.read_integration(self.engine, integration_id))

    def activate_integration(self, integration_id: str, actor: str | None = None) -> dict[str, Any]:
        with self._mutation(integration_id):
            integration = records.read_integration(self.engine, integration_id)
            self._validate_activation_integration(integration)
            updated = {**integration, "status": "active", "updatedAt": now_iso()}
            records.write_integration(self.engine, updated)
            self._audit("chat.integration.activated", integration_id, actor, {})
            return self._public_integration(updated)

    def provider_operation(self, integration_id: str) -> AbstractAsyncContextManager[None]:
        return provider_operation(self.engine, integration_id)

    def validate_telegram_webhook_rotation(self, integration_id: str) -> None:
        self._prepare_credentials()
        with store_transaction(self.engine):
            integration = records.read_integration(self.engine, integration_id)
            if integration.get("provider") != "telegram":
                raise ValueError("Webhook secret rotation is only available for Telegram integrations.")
            values = credentials.read_secret(self.engine, self._secret_cipher, integration_id)
            if not _string(values.get("botToken")):
                raise ValueError("Configure the Telegram bot token before rotating the webhook secret.")
            public_callback_base_url(integration)

    def set_telegram_webhook_secret(
        self, integration_id: str, webhook_secret: str, actor: str | None = None
    ) -> dict[str, Any]:
        with self._mutation(integration_id):
            integration = records.read_integration(self.engine, integration_id)
            if integration.get("provider") != "telegram":
                raise ValueError("Webhook secret rotation is only available for Telegram integrations.")
            self._write_secret_patch(integration_id, {"webhookSecret": webhook_secret})
            updated = {**integration, "updatedAt": now_iso()}
            records.write_integration(self.engine, updated)
            self._audit("chat.integration.webhook_secret_rotated", integration_id, actor, {})
            return self._public_integration(updated)

    def check_integration(
        self, integration_id: str, actor: str | None = None, provider_health: tuple[bool, str] | None = None
    ) -> dict[str, Any]:
        with self._mutation(integration_id):
            integration = records.read_integration(self.engine, integration_id)
            public = self._public_integration(integration)
            checks = []
            if public["secretConfigured"]:
                checks.append("secrets")
            if public["identityLinkCount"] > 0:
                checks.append("identity links")
            if public["allowedConversationCount"] > 0:
                checks.append("allowed conversations")
            configured = len(checks) == 3
            missing = [label for label in ("secrets", "identity links", "allowed conversations") if label not in checks]
            provider_ok, message = provider_health or (False, "Provider connection was not checked.")
            ok = configured and provider_ok
            updated = {
                **integration,
                "status": integration.get("status") if ok else "degraded",
                "health": {
                    "ok": ok,
                    "message": message if configured else f"Missing {', '.join(missing)}.",
                    "lastCheckedAt": now_iso(),
                },
                "updatedAt": now_iso(),
            }
            records.write_integration(self.engine, updated)
            self._audit("chat.integration.checked", integration_id, actor, {"ok": ok})
            return self._public_integration(updated)

    @staticmethod
    def _connection_settings(integration: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
        return {
            "provider": integration.get("provider"),
            "tenantId": integration.get("tenantId"),
            "config": dict(integration.get("config") or {}),
            "secrets": dict(values),
        }

    def connection_settings(self, integration_id: str) -> dict[str, Any]:
        self._prepare_credentials()
        integration, ciphertext = records.settings_record(self.engine, integration_id)
        return self._connection_settings(integration, credentials.decrypt_secret(self._secret_cipher, ciphertext))

    def runtime_integrations(self) -> list[dict[str, Any]]:
        self._prepare_credentials()
        return [
            {
                "id": integration["id"],
                **self._connection_settings(integration, credentials.decrypt_secret(self._secret_cipher, ciphertext)),
            }
            for integration, ciphertext in records.runtime_records(self.engine)
        ]

    def _change_collection(
        self,
        integration_id: str,
        collection: str,
        *,
        record: dict[str, Any] | None = None,
        remove_id: str | None = None,
    ) -> dict[str, Any]:
        integration = records.read_integration(self.engine, integration_id)
        existing = list_field(integration, collection)
        if record is not None:
            items = [record, *existing]
        else:
            items = [item for item in existing if item.get("id") != remove_id]
            if len(items) == len(existing):
                raise KeyError(remove_id)
        updated = {
            **integration,
            collection: items,
            "health": {"ok": False, "message": "Run the provider connection check again.", "lastCheckedAt": None},
            "status": "degraded" if integration.get("status") == "active" else integration.get("status"),
            "updatedAt": now_iso(),
        }
        records.write_integration(self.engine, updated)
        return updated

    def add_identity_link(
        self, integration_id: str, payload: dict[str, Any], actor: str | None = None
    ) -> dict[str, Any]:
        with self._mutation(integration_id):
            user_id = _required_string(payload.get("userId"), "userId")
            record = {
                "id": new_relay_id("cil"),
                "externalUserId": _required_string(payload.get("externalUserId"), "externalUserId"),
                "userId": user_id,
                "displayName": _string(payload.get("displayName")),
                "defaultAgentId": _string(payload.get("defaultAgentId")),
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
            updated = self._change_collection(integration_id, "identityLinks", record=record)
            self._audit("chat.identity_link.created", integration_id, actor, {"userId": user_id})
            return self._public_integration(updated)

    def delete_identity_link(self, integration_id: str, link_id: str, actor: str | None = None) -> dict[str, Any]:
        with self._mutation(integration_id):
            updated = self._change_collection(integration_id, "identityLinks", remove_id=link_id)
            self._audit("chat.identity_link.deleted", integration_id, actor, {"linkId": link_id})
            return self._public_integration(updated)

    def add_allowed_conversation(
        self, integration_id: str, payload: dict[str, Any], actor: str | None = None
    ) -> dict[str, Any]:
        with self._mutation(integration_id):
            conversation_id = _required_string(payload.get("conversationId"), "conversationId")
            record = {
                "id": new_relay_id("cac"),
                "conversationId": conversation_id,
                "threadId": _string(payload.get("threadId")),
                "label": _string(payload.get("label")) or conversation_id,
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
            updated = self._change_collection(integration_id, "allowedConversations", record=record)
            self._audit("chat.allowed_conversation.created", integration_id, actor, {"conversationId": conversation_id})
            return self._public_integration(updated)

    def delete_allowed_conversation(
        self, integration_id: str, conversation_record_id: str, actor: str | None = None
    ) -> dict[str, Any]:
        with self._mutation(integration_id):
            updated = self._change_collection(integration_id, "allowedConversations", remove_id=conversation_record_id)
            self._audit(
                "chat.allowed_conversation.deleted",
                integration_id,
                actor,
                {"conversationRecordId": conversation_record_id},
            )
            return self._public_integration(updated)

    def resolve_identity(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        provider, tenant_id = _provider(payload.get("provider")), _string(payload.get("tenantId"))
        external = _required_string(payload.get("externalUserId"), "externalUserId")
        conversation = _required_string(payload.get("conversationId"), "conversationId")
        thread = _string(payload.get("threadId"))
        for integration in records.identity_candidates(self.engine, provider, tenant_id):
            if integration.get("tenantId") and integration.get("tenantId") != tenant_id:
                continue
            if not _conversation_allowed(integration, conversation, thread):
                continue
            link = _identity_link(integration, external)
            if link:
                return {
                    "integrationId": integration["id"],
                    "provider": provider,
                    "tenantId": integration.get("tenantId"),
                    "userId": link["userId"],
                    "displayName": link.get("displayName"),
                    "defaultAgentId": link.get("defaultAgentId"),
                }
        return None

    def get_conversation_session(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        return get_conversation(self.engine, _conversation_key(payload))

    def clear_conversation_sessions(self, session_id: str) -> int:
        return clear_conversations(self.engine, session_id)

    def set_conversation_session(self, payload: dict[str, Any], session_id: str, owner_user_id: str) -> dict[str, Any]:
        now = now_iso()
        return bind_conversation(
            self.engine,
            {
                "key": _conversation_key(payload),
                "provider": _provider(payload.get("provider")),
                "tenantId": _string(payload.get("tenantId")),
                "conversationId": _required_string(payload.get("conversationId"), "conversationId"),
                "threadId": _string(payload.get("threadId")),
                "providerMessageId": _string(payload.get("messageId")),
                "sessionId": session_id,
                "ownerUserId": owner_user_id,
                "createdAt": now,
                "updatedAt": now,
            },
        )

    def audit_events(self, integration_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        return read_audit_events(self.engine, integration_id, limit)

    def _write_secret_patch(self, integration_id: str, raw: Any) -> None:
        if not isinstance(raw, dict):
            return
        patch = {
            str(key): str(value)
            for key, value in raw.items()
            if key in SECRET_FIELDS and value is not None and str(value).strip()
        }
        if not patch:
            return
        if self._secret_cipher is None:
            raise ValueError("RELAY_CHAT_SECRET_KEY is required to store database chat secrets.")
        current = credentials.read_secret(self.engine, self._secret_cipher, integration_id)
        credentials.write_secret(self.engine, self._secret_cipher, integration_id, {**current, **patch})

    def _audit(self, event_type: str, integration_id: str, actor: str | None, payload: dict[str, Any]) -> None:
        append_audit_event(
            self.engine,
            {
                "id": new_relay_id("cae"),
                "type": event_type,
                "integrationId": integration_id,
                "actor": actor,
                "timestamp": now_iso(),
                **payload,
            },
        )
