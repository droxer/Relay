"""Unit checks for workers_deploy.py: asset hashing, collection, batching."""
import importlib.util
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("workers_deploy", Path(__file__).resolve().parents[1] / "workers_deploy.py")
workers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workers)

# The same bytes under another extension are another asset (another type).
a = workers.asset_hash(b"x", Path("a.js"))
assert len(a) == 32 and a == workers.asset_hash(b"x", Path("b.js"))
assert a != workers.asset_hash(b"x", Path("a.css"))
print("ok    asset hashes are 32 hex chars and depend on content and extension")

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    (root / "_next/static").mkdir(parents=True)
    (root / "index.html").write_text("<html></html>")
    (root / "_next/static/app.js").write_text("1")
    (root / "_headers").write_text("/*\n  X: 1\n")
    files = workers.collect(root)
    assert sorted(files) == ["/_next/static/app.js", "/index.html"], files
print("ok    collection keeps served files and leaves _headers to the config")

by_hash = {"a": {"size": 30}, "b": {"size": 30}, "c": {"size": 5}}
workers.MAX_BATCH_BYTES = 50
assert list(workers.batches(["a", "b", "c"], by_hash)) == [["a"], ["b", "c"]]
by_hash["big"] = {"size": 80}
assert list(workers.batches(["big", "c"], by_hash)) == [["big"], ["c"]]
print("ok    uploads batch under the size cap, and an oversized file goes alone")
