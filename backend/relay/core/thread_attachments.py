"""Thread image limits and wire metadata; bytes never enter events."""

from __future__ import annotations

from typing import Any
from uuid import UUID

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_MESSAGE_IMAGES = 4


def attachment_ids(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)) or len(value) > MAX_MESSAGE_IMAGES:
        raise ValueError("Attach at most 4 images.")
    for item in value:
        if not isinstance(item, str):
            raise ValueError("attachmentIds must contain attachment ids.")
        try:
            UUID(item)
        except ValueError as error:
            raise ValueError("attachmentIds must contain attachment ids.") from error
    return tuple(dict.fromkeys(value))


def validate_image(content: bytes, media_type: str) -> None:
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("Images must be between 1 byte and 10 MB.")
    valid = (
        (
            media_type == "image/png"
            and len(content) >= 33
            and content.startswith(b"\x89PNG\r\n\x1a\n")
            and content[12:16] == b"IHDR"
        )
        or (
            media_type == "image/jpeg"
            and len(content) >= 4
            and content.startswith(b"\xff\xd8\xff")
            and content.endswith(b"\xff\xd9")
        )
        or (
            media_type == "image/webp"
            and len(content) >= 20
            and content.startswith(b"RIFF")
            and content[8:12] == b"WEBP"
            and int.from_bytes(content[4:8], "little") + 8 == len(content)
        )
    )
    if not valid:
        raise ValueError("Upload a PNG, JPEG, or WebP image matching its content type.")
