"""Keep hard-loaded client routes aligned with the frontend route catalogue."""
from pathlib import Path
import re

import pytest

from relay.api.web.routes import _is_client_route
from relay.api.web.ui import web_ui_asset_response


def client_paths() -> list[str]:
    config = (Path(__file__).resolve().parents[3] / "web" / "next.config.ts").read_text()
    block = re.search(r"const CLIENT_ROUTES = \[(.*?)\] as const;", config, re.S)
    assert block is not None
    paths = re.findall(r'"(/[^"\n]+)"', block[1])
    return [path.replace(":path*", "record") for path in paths]


@pytest.mark.parametrize("path", client_paths())
def test_client_route_loads_shell_and_redirects_to_web_origin(tmp_path: Path, path: str) -> None:
    (tmp_path / "index.html").write_text("<html>Relay</html>")
    assert _is_client_route(path.lstrip("/")), path
    response = web_ui_asset_response(path.lstrip("/"), tmp_path)
    assert response.status_code == 200, path
    assert response.body == b"<html>Relay</html>"


@pytest.mark.parametrize("path", ["unknown", "api/v1/unknown", "_next/static/missing.js", "tasks/missing.js"])
def test_missing_assets_and_unknown_roots_do_not_load_shell(tmp_path: Path, path: str) -> None:
    (tmp_path / "index.html").write_text("<html>Relay</html>")
    assert web_ui_asset_response(path, tmp_path).status_code == 404
