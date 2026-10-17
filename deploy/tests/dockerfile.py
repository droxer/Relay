"""Check Railway's cache-mount requirements before submitting a build."""
import re
import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
for dockerfile in (root / "backend/Dockerfile", root / "web/Dockerfile"):
    for mount in re.findall(r"--mount=([^\s]+)", dockerfile.read_text()):
        fields = dict(part.split("=", 1) for part in mount.split(","))
        if fields.get("type") == "cache":
            cache_id = fields.get("id", "")
            assert cache_id.startswith("s/") and "$" not in cache_id, (
                f"{dockerfile.relative_to(root)}: Railway cache mounts require "
                "an explicit literal service-scoped id; omit cache mounts for portable images"
            )
print("ok    Dockerfiles satisfy Railway cache-mount constraints")

backend = (root / "backend/Dockerfile").read_text()
profile = json.loads((root / "deploy/services/backend.json").read_text())
# Railway's published schema limits the command array to one entry.
# https://backboard.railway.app/railway.schema.json
for name in ("backend", "web"):
    commands = json.loads((root / f"deploy/services/{name}.json").read_text())["preDeployCommand"]
    assert isinstance(commands, list) and len(commands) <= 1, (
        f"{name}: Error in preDeployCommand - Invalid input (at most one command)"
    )
assert 'CMD ["relay", "serve-with-worker"]' in backend
assert "RELAY_BACKGROUND_MODE=external" in backend
assert profile["startCommand"] == "relay serve-with-worker"
assert profile["preDeployCommand"] == [
    "/bin/sh -c 'alembic -c backend/alembic.ini upgrade head && relay worker-schema'",
]
# Exercise the exact configured command without a database: both commands
# must run in order, and a migration failure must prevent queue schema setup.
with tempfile.TemporaryDirectory() as directory:
    work = Path(directory)
    for name in ("alembic", "relay"):
        stub = work / name
        stub.write_text(
            '#!/bin/sh\nprintf "%s\\n" "${0##*/} $*" >> "$COMMAND_LOG"\n'
            + ('exit "$MIGRATION_EXIT"\n' if name == "alembic" else 'exit "$SCHEMA_EXIT"\n')
        )
        stub.chmod(0o755)
    log = work / "commands.log"
    for migration_exit, schema_exit in ((0, 0), (7, 0), (0, 9)):
        log.unlink(missing_ok=True)
        result = subprocess.run(
            shlex.split(profile["preDeployCommand"][0]),
            env={**os.environ, "PATH": f"{work}:{os.environ['PATH']}",
                 "COMMAND_LOG": str(log), "MIGRATION_EXIT": str(migration_exit),
                 "SCHEMA_EXIT": str(schema_exit)},
            check=False,
        )
        assert result.returncode == (migration_exit or schema_exit)
        expected = ["alembic -c backend/alembic.ini upgrade head"]
        if not migration_exit:
            expected.append("relay worker-schema")
        assert log.read_text().splitlines() == expected
print("ok    backend deploy migrates, prepares jobs, and supervises the API and worker")
