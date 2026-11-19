"""Bounded read-only Inbox operations and opaque, run-bound references."""

import base64
import binascii
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from ..core.connections import ConnectionError
from . import providers
from .mail_oauth import GMAIL, GRAPH_INBOX

MAX_BODY_BYTES = 16 * 1024
REFERENCE_TTL = 15 * 60
GRAPH_FIELDS = "id,parentFolderId,from,subject,receivedDateTime,isRead"
GRAPH_HEADERS = {"Prefer": 'IdType="ImmutableId"'}
RFC3339 = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", re.ASCII)
MESSAGE_ID = re.compile(r"[A-Za-z0-9_+=/-]{1,1024}", re.ASCII)
GRAPH_INBOX_PATH = re.compile(r"/v1\.0/me/mailfolders(?:/([^/]+)|\('([^/']+)'\))/messages", re.IGNORECASE | re.ASCII)


class MailReferences:
    def __init__(self, connection_id: str, run_id: str, seal: Callable, unseal: Callable):
        self.context = {"connectionId": connection_id, "runId": run_id, "resource": "inbox"}
        self.seal = seal
        self.unseal = unseal

    def issue(self, purpose: str, value: str, filters: dict[str, Any] | None = None) -> str:
        return self.seal({**self.context, "purpose": purpose, "value": value, "filters": filters,
                          "expiresAt": time.time() + REFERENCE_TTL})

    def read(self, purpose: str, token: Any, filters: dict[str, Any] | None = None) -> str:
        error = "connection_cursor_invalid" if purpose == "mail-cursor" else "connection_arguments_invalid"
        if not isinstance(token, str) or not 1 <= len(token) <= 16_384:
            raise ConnectionError(error)
        try:
            claims = self.unseal(token)
        except ConnectionError as exc:
            raise ConnectionError(error) from exc
        if (claims.get("purpose") != purpose or claims.get("filters") != filters
                or any(claims.get(key) != value for key, value in self.context.items())
                or claims["expiresAt"] <= time.time()):
            raise ConnectionError(error)
        return str(claims["value"])


def call(provider: str, token: str, action: str, arguments: dict[str, Any], references: MailReferences) -> dict[str, Any]:
    if action == f"{provider}.get_message":
        if set(arguments) != {"messageId"}:
            raise ConnectionError("connection_arguments_invalid")
        message_id = references.read("mail-message", arguments["messageId"])
        original, text = _get_message(provider, token, message_id)
        body = text.encode("utf-8", errors="replace")
        return {**original, "id": arguments["messageId"], "body": body[:MAX_BODY_BYTES].decode("utf-8", errors="ignore"),
                "truncated": len(body) > MAX_BODY_BYTES}

    if action != f"{provider}.list_messages":
        raise ConnectionError("connection_access_denied", 403)
    filters = _filters(arguments)
    cursor = references.read("mail-cursor", arguments["cursor"], filters) if "cursor" in arguments else None
    if provider == "gmail":
        messages, next_cursor = _gmail_list(token, filters, cursor)
    else:
        messages, next_cursor = _outlook_list(token, filters, cursor)
    return {
        "messages": [{**item, "id": references.issue("mail-message", item["id"])} for item in messages],
        "nextCursor": references.issue("mail-cursor", next_cursor, filters) if next_cursor else None,
    }


def _filters(arguments: dict[str, Any]) -> dict[str, Any]:
    limit, unread, after = arguments.get("limit", 20), arguments.get("unreadOnly", False), arguments.get("receivedAfter")
    if (set(arguments) - {"limit", "unreadOnly", "receivedAfter", "cursor"}
            or type(limit) is not int or not 1 <= limit <= 25 or not isinstance(unread, bool)):
        raise ConnectionError("connection_arguments_invalid")
    timestamp = None
    if "receivedAfter" in arguments:
        if not isinstance(after, str) or not RFC3339.fullmatch(after):
            raise ConnectionError("connection_arguments_invalid")
        try:
            timestamp = datetime.fromisoformat(after).astimezone(UTC).isoformat()
        except (ValueError, OverflowError) as exc:
            raise ConnectionError("connection_arguments_invalid") from exc
    return {"limit": limit, "unreadOnly": unread, "receivedAfter": timestamp}


def _gmail_list(token: str, filters: dict[str, Any], cursor: str | None) -> tuple[list[dict[str, Any]], str | None]:
    cutoff = datetime.fromisoformat(filters["receivedAfter"]).timestamp() if filters["receivedAfter"] else None
    params: dict[str, Any] = {"labelIds": "INBOX", "maxResults": filters["limit"], "fields": "messages(id),nextPageToken"}
    query = []
    if filters["unreadOnly"]:
        query.append("is:unread")
    if cutoff is not None:
        query.append(f"after:{max(0, int(cutoff) - 1)}")
    if query:
        params["q"] = " ".join(query)
    if cursor:
        params["pageToken"] = cursor
    data = _object(providers.request("GET", f"{GMAIL}/messages", mail=True, token=token, params=params))
    messages = []
    start = time.monotonic()
    for raw in _items(data, "messages", filters["limit"]):
        if time.monotonic() - start > 20:
            raise ConnectionError("connection_provider_unavailable", 502)
        message_id = _provider_id(raw)
        try:
            item = _gmail_get(token, message_id, details=False)
        except ConnectionError as exc:
            if exc.code == "connection_message_unavailable":
                continue
            raise
        metadata = _gmail_metadata(item)
        if filters["unreadOnly"] and not metadata["unread"]:
            continue
        if cutoff is not None and datetime.fromisoformat(metadata["receivedAt"]).timestamp() <= cutoff:
            continue
        messages.append(metadata)
    return messages, _next(data, "nextPageToken")


def _outlook_list(token: str, filters: dict[str, Any], cursor: str | None) -> tuple[list[dict[str, Any]], str | None]:
    inbox = _outlook_inbox_id(token)
    url = _graph_cursor(cursor, inbox) if cursor else f"{GRAPH_INBOX}/messages"
    params: dict[str, Any] = {}
    if not cursor:
        params = {"$select": GRAPH_FIELDS, "$top": filters["limit"]}
        conditions = []
        if filters["receivedAfter"]:
            conditions.append(f"receivedDateTime gt {filters['receivedAfter']}")
        if filters["unreadOnly"]:
            conditions.append("isRead eq false")
        if conditions:
            params["$filter"] = " and ".join(conditions)
    data = _object(providers.request("GET", url, mail=True, token=token, headers=GRAPH_HEADERS, params=params or None))
    items = [_outlook_metadata(item) for item in _items(data, "value", filters["limit"])
             if item.get("parentFolderId") == inbox]
    next_link = _next(data, "@odata.nextLink")
    return items, _graph_cursor(next_link, inbox) if next_link else None


def _graph_cursor(value: str, inbox: str) -> str:
    try:
        url = urlsplit(value)
    except ValueError as exc:
        raise ConnectionError("connection_cursor_invalid") from exc
    folder_path = GRAPH_INBOX_PATH.fullmatch(url.path)
    if (url.scheme != "https" or url.netloc != "graph.microsoft.com" or url.fragment or not folder_path
            or not url.query or any(ord(char) <= 32 for char in value)):
        raise ConnectionError("connection_cursor_invalid")
    folder = unquote(folder_path[1] or folder_path[2])
    if folder.lower() != "inbox" and folder != inbox:
        raise ConnectionError("connection_cursor_invalid")
    return value


def _outlook_inbox_id(token: str) -> str:
    inbox = providers.request("GET", GRAPH_INBOX, mail=True, token=token, headers=GRAPH_HEADERS,
        params={"$select": "id"}, missing="connection_mailbox_unavailable")
    return _provider_id(_object(inbox))


def _get_message(provider: str, token: str, message_id: str) -> tuple[dict[str, Any], str]:
    if provider == "gmail":
        item = _gmail_get(token, message_id, details=True)
        plain, html = _gmail_body(_object(item.get("payload")))
        return _gmail_metadata(item), "\n".join(plain) if plain else _strip_html("\n".join(html))

    inbox = _outlook_inbox_id(token)
    data = _object(providers.request("GET", f"{GRAPH_INBOX}/messages/{quote(message_id, safe='')}",
        mail=True, token=token, headers={"Prefer": 'IdType="ImmutableId", outlook.body-content-type="text"'},
        params={"$select": f"{GRAPH_FIELDS},body"}, missing="connection_message_unavailable"))
    if data.get("parentFolderId") != inbox or _provider_id(data) != message_id:
        raise ConnectionError("connection_message_unavailable", 404)
    body = _object(data.get("body"))
    content = body.get("content")
    if not isinstance(content, str) or body.get("contentType") not in ("text", "html"):
        raise ConnectionError("connection_provider_rejected", 422)
    return _outlook_metadata(data), _strip_html(content) if body["contentType"] == "html" else content


def _gmail_get(token: str, message_id: str, *, details: bool) -> dict[str, Any]:
    params: dict[str, Any] = (
        {"format": "full", "fields": "id,internalDate,labelIds,payload"} if details else
        {"format": "metadata", "metadataHeaders": ["From", "Subject"], "fields": "id,internalDate,labelIds,payload(headers)"}
    )
    data = _object(providers.request("GET", f"{GMAIL}/messages/{quote(message_id, safe='')}", mail=True,
        token=token, params=params, missing="connection_message_unavailable"))
    labels = data.get("labelIds")
    if not isinstance(labels, list) or "INBOX" not in labels or _provider_id(data) != message_id:
        raise ConnectionError("connection_message_unavailable", 404)
    return data


def _gmail_metadata(data: dict[str, Any]) -> dict[str, Any]:
    headers = _object(data.get("payload")).get("headers", [])
    values = {header["name"].lower(): _text(header.get("value")) for header in headers
              if isinstance(header, dict) and isinstance(header.get("name"), str)} if isinstance(headers, list) else {}
    try:
        received = datetime.fromtimestamp(int(data["internalDate"]) / 1000, UTC).isoformat()
    except (KeyError, TypeError, ValueError, OverflowError, OSError) as exc:
        raise ConnectionError("connection_provider_rejected", 422) from exc
    return {"id": _provider_id(data), "sender": values.get("from", ""), "subject": values.get("subject", ""),
            "receivedAt": received, "unread": "UNREAD" in data["labelIds"]}


def _gmail_body(payload: dict[str, Any]) -> tuple[list[str], list[str]]:
    plain: list[str] = []
    html: list[str] = []
    stack = [payload]
    while stack:
        part = stack.pop()
        headers = part.get("headers")
        if part.get("filename") or (isinstance(headers, list) and any(
                isinstance(h, dict) and _text(h.get("name")).lower() == "content-disposition"
                and _text(h.get("value")).lstrip().lower().startswith("attachment") for h in headers)):
            continue
        kind, children, body = part.get("mimeType"), part.get("parts"), part.get("body")
        if kind in ("text/plain", "text/html") and isinstance(body, dict):
            encoded = body.get("data")
            if isinstance(encoded, str) and not body.get("attachmentId"):
                try:
                    text = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8", "replace")
                except (binascii.Error, ValueError) as exc:
                    raise ConnectionError("connection_provider_rejected", 422) from exc
                (plain if kind == "text/plain" else html).append(text)
        elif isinstance(kind, str) and kind.startswith("multipart/") and isinstance(children, list):
            stack.extend(child for child in reversed(children) if isinstance(child, dict))
    return plain, html


def _outlook_metadata(data: dict[str, Any]) -> dict[str, Any]:
    sender = data.get("from")
    address = sender.get("emailAddress") if isinstance(sender, dict) else None
    return {"id": _provider_id(data), "sender": _text(address.get("address")) if isinstance(address, dict) else "",
            "subject": _text(data.get("subject")), "receivedAt": _text(data.get("receivedDateTime")),
            "unread": data.get("isRead") is False}


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConnectionError("connection_provider_rejected", 422)
    return value


def _items(data: dict[str, Any], key: str, limit: int) -> list[dict[str, Any]]:
    items = data.get(key, [])
    if not isinstance(items, list) or len(items) > limit:
        raise ConnectionError("connection_provider_rejected", 422)
    return [_object(item) for item in items]


def _provider_id(data: dict[str, Any]) -> str:
    value = data.get("id")
    if not isinstance(value, str) or not MESSAGE_ID.fullmatch(value):
        raise ConnectionError("connection_provider_rejected", 422)
    return value


def _next(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is not None and (not isinstance(value, str) or len(value) > 8192):
        raise ConnectionError("connection_provider_rejected", 422)
    return value


def _text(value: Any) -> str:
    return value[:1024] if isinstance(value, str) else ""


class _BodyText(HTMLParser):
    hidden = {"script", "style", "head", "template"}
    linebreaks = {"p", "br", "div", "li", "tr", "blockquote"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.ignored: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.hidden:
            self.ignored.append(tag)
        elif not self.ignored and tag in self.linebreaks:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if self.ignored and self.ignored[-1] == tag:
            self.ignored.pop()
        elif not self.ignored and tag in self.linebreaks:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.ignored:
            self.parts.append(data)


def _strip_html(value: str) -> str:
    parser = _BodyText()
    parser.feed(value)
    parser.close()
    return "".join(parser.parts).strip()
