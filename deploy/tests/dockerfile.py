"""Check Railway's cache-mount requirements before submitting a build."""
import re
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
