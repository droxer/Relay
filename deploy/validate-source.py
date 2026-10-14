"""Validate build inputs in a Git commit without checking out or executing it."""
import argparse
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--git-dir", required=True)
parser.add_argument("--commit", required=True)
args = parser.parse_args()
if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
    parser.error("commit must be a full lowercase SHA")

required = [
    "backend/Dockerfile", "web/Dockerfile", "web/Caddyfile",
    "tools/build-computer.mjs", "package.json", "package-lock.json",
    "tsconfig.options.json", "backend/pyproject.toml", "backend/uv.lock",
    "packages/relay-core/package.json", "packages/relay-daemon/package.json",
    "web/package.json",
]
errors = []
contents = {}
for name in required:
    result = subprocess.run(
        ["git", "--git-dir", args.git_dir, "show", f"{args.commit}:{name}"],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        errors.append(f"missing required build input: {name}")
    else:
        contents[name] = result.stdout.decode("utf-8", errors="replace")
for name in ("backend/Dockerfile", "web/Dockerfile"):
    for mount in re.findall(r"--mount=([^\s]+)", contents.get(name, "")):
        fields = dict(part.split("=", 1) for part in mount.split(",") if "=" in part)
        if fields.get("type") == "cache":
            cache_id = fields.get("id", "")
            if not cache_id.startswith("s/") or "$" in cache_id:
                errors.append(f"{name}: Railway cache mount needs a literal service-scoped id")
if errors:
    print(f"Release source {args.commit} is not ready:", file=sys.stderr)
    for error in errors:
        print(f"  {error}", file=sys.stderr)
    print("Commit and push the source fixes, then select that commit before releasing.", file=sys.stderr)
    sys.exit(1)
print(f"Release source {args.commit}: required build inputs and cache mounts verified")
