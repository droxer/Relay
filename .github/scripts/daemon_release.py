"""Require a newer Daemon release when a change affects the personal installer bundle."""

import json
import subprocess
import sys

from relay.core.client_version import client_version_key

DAEMON_MANIFEST = "packages/relay-daemon/package.json"
BUNDLE_SOURCES = (
    "packages/relay-core/src", "packages/relay-core/tsconfig.json", "packages/relay-core/package.json",
    "packages/relay-daemon/src", "packages/relay-daemon/tsconfig.json", DAEMON_MANIFEST,
    "tsconfig.options.json", "tools/build-computer.mjs",
)
# The compiler and the dependencies copied by tools/build-computer.mjs.
BUNDLE_DEPENDENCIES = ("typescript", "smol-toml", "jsonc-parser", "undici")


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True)


def read_json(revision: str, path: str) -> dict:
    return json.loads(git("show", f"{revision}:{path}"))


def build_inputs(revision: str) -> tuple:
    packages = read_json(revision, "package-lock.json")["packages"]
    compiler_and_dependencies = tuple(packages.get(f"node_modules/{name}") for name in BUNDLE_DEPENDENCIES)
    build_command = read_json(revision, "package.json")["scripts"].get("build:computer")
    return build_command, compiler_and_dependencies


def check_release(base: str, head: str) -> None:
    base_version = read_json(base, DAEMON_MANIFEST)["version"]
    head_version = read_json(head, DAEMON_MANIFEST)["version"]
    base_key = client_version_key(base_version)
    head_key = client_version_key(head_version)
    if base_key is None or head_key is None:
        raise ValueError(f"{DAEMON_MANIFEST} must use a valid release version")
    locked_version = read_json(head, "package-lock.json")["packages"]["packages/relay-daemon"]["version"]
    if locked_version != head_version:
        raise ValueError("Update the relay-daemon workspace version in package-lock.json to match its manifest")
    changed = git("diff", "--name-only", base, head, "--", *BUNDLE_SOURCES)
    if (changed or build_inputs(base) != build_inputs(head)) and head_key <= base_key:
        raise ValueError(f"Personal Computer installer inputs changed. Bump relay-daemon past {base_version}.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: daemon_release.py BASE HEAD")
    try:
        check_release(*sys.argv[1:])
    except ValueError as error:
        sys.exit(str(error))
