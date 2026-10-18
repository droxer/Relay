from __future__ import annotations

from typing import Any

import httpx

from .integrations import dict_field, public_callback_base_url


async def probe_chat_integration(
    settings: dict[str, Any],
    client: httpx.AsyncClient | None = None,
) -> tuple[bool, str]:
    provider = settings.get("provider")
    secrets = dict_field(settings, "secrets")
    config = dict_field(settings, "config")
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=10)
    try:
        if provider == "discord":
            _required(config, "applicationId")
            public_key = _required(config, "publicKey")
            if len(public_key) != 64 or any(character not in "0123456789abcdefABCDEF" for character in public_key):
                raise ValueError("publicKey must be a 32-byte hexadecimal Discord public key.")
            token = _required(secrets, "botToken")
            response = await client.get(
                "https://discord.com/api/v10/users/@me",
                headers={"Authorization": f"Bot {token}"},
            )
        elif provider == "telegram":
            _required(secrets, "webhookSecret")
            token = _required(secrets, "botToken")
            response = await client.get(f"https://api.telegram.org/bot{token}/getMe")
        elif provider == "lark":
            app_id = _required(config, "appId")
            app_secret = _required(secrets, "appSecret")
            _required(secrets, "verificationToken")
            _required(secrets, "encryptKey")
            response = await client.post(
                "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": app_id, "app_secret": app_secret},
            )
        else:
            return False, "Unsupported chat provider."
    except (httpx.HTTPError, ValueError) as error:
        return False, str(error)
    finally:
        if owns_client:
            await client.aclose()
    if response.is_success:
        try:
            payload = response.json()
        except ValueError:
            return False, "Provider credential check returned an invalid response."
        if provider == "telegram" and payload.get("ok") is not True:
            return False, "Telegram rejected the configured credentials."
        if provider == "lark" and (payload.get("code") != 0 or not payload.get("tenant_access_token")):
            return False, "Lark rejected the configured credentials."
        if provider == "discord" and not payload.get("id"):
            return False, "Discord rejected the configured credentials."
        return True, "Provider credentials verified."
    return False, f"Provider credential check failed with HTTP {response.status_code}."


async def provision_chat_integration(
    settings: dict[str, Any],
    integration_id: str,
    client: httpx.AsyncClient | None = None,
) -> tuple[bool, str]:
    provider = settings.get("provider")
    secrets = dict_field(settings, "secrets")
    config = dict_field(settings, "config")
    try:
        public_base_url = public_callback_base_url({"config": config})
    except ValueError as error:
        return False, str(error)
    callback_url = f"{public_base_url}/webhooks/{provider}/{integration_id}"
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=10)
    try:
        if provider == "telegram":
            token = _required(secrets, "botToken")
            response = await client.post(
                f"https://api.telegram.org/bot{token}/setWebhook",
                json={
                    "url": callback_url,
                    "secret_token": _required(secrets, "webhookSecret"),
                    "allowed_updates": ["message"],
                },
            )
            payload = response.json()
            if not response.is_success or payload.get("ok") is not True:
                return False, "Telegram rejected the webhook configuration."
            response = await client.get(f"https://api.telegram.org/bot{token}/getWebhookInfo")
            payload = response.json()
            if (
                not response.is_success
                or payload.get("ok") is not True
                or not isinstance(payload.get("result"), dict)
                or payload["result"].get("url") != callback_url
            ):
                return False, "Telegram did not confirm the configured webhook URL."
            return True, "Telegram webhook registered."
        return False, "Automatic webhook provisioning is only available for Telegram."
    except (httpx.HTTPError, ValueError) as error:
        return False, str(error)
    finally:
        if owns_client:
            await client.aclose()


def _required(values: dict[str, Any], key: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required for the provider credential check.")
    return value.strip()
