"""Validate committed snapshots, including an unfixed remote-style snapshot."""
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
validator = root / "deploy/validate-source.py"
with tempfile.TemporaryDirectory() as temporary:
    repo = Path(temporary)
    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
    git("init", "-q")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Deployment test")
    required = ["backend/Dockerfile", "web/Dockerfile", "web/Caddyfile", "tools/build-computer.mjs", "package.json", "package-lock.json", "tsconfig.options.json", "backend/pyproject.toml", "backend/uv.lock", "packages/relay-core/package.json", "packages/relay-daemon/package.json", "web/package.json"]
    for name in required:
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((root / name).read_bytes())
    git("add", ".")
    git("commit", "-qm", "valid source")
    good = git("rev-parse", "HEAD")
    path = repo / "backend/Dockerfile"
    path.write_text(path.read_text() + "\nRUN --mount=type=cache,target=/root/.cache/uv true\n")
    (repo / "web/Dockerfile").unlink()
    git("add", "-A")
    git("commit", "-qm", "invalid source")
    bad = git("rev-parse", "HEAD")
    # Repair the working tree: validation must still reject the selected commit.
    path.write_bytes((root / "backend/Dockerfile").read_bytes())
    (repo / "web/Dockerfile").write_bytes((root / "web/Dockerfile").read_bytes())
    for sha, expected in [(good, 0), (bad, 1)]:
        result = subprocess.run(["python3", str(validator), "--git-dir", str(repo / ".git"), "--commit", sha], capture_output=True, text=True, check=False)
        assert result.returncode == expected, result.stdout + result.stderr
        if expected:
            assert "web/Dockerfile" in result.stderr and "cache" in result.stderr, result.stderr
    print("ok    source validation reads the selected commit, not repaired local files")
