"""Reading and writing the retired file stores' JSON, upgraded on read."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ...core.legacy_names import upgrade_legacy_names

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RELAY_DATA_DIR = REPO_ROOT / ".relay"


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return upgrade_legacy_names(json.load(handle))


def write_json(path: Path, value: Any, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if mode is None:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
    else:
        fd = os.open(tmp, flags, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
    tmp.replace(path)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise KeyError(path)
    return [
        upgrade_legacy_names(json.loads(line))
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]
