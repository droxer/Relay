"""Publish the exported web UI as a Cloudflare Worker with static assets.

Uses the Workers direct-upload API, so no wrangler or Node is needed:
https://developers.cloudflare.com/workers/static-assets/direct-upload/

    CLOUDFLARE_API_TOKEN=... python3 workers_deploy.py \
        --api-url https://api.cloudflare.com/client/v4 --account <id> \
        --script relay-web --assets web/out --worker deploy/workers/worker.js \
        --headers deploy/workers/_headers --api-origin https://api.example.com

The token comes from the environment so it never appears in argv. Files whose
hash Cloudflare already holds are not uploaded again.
"""

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

COMPATIBILITY_DATE = "2025-09-01"
# Cloudflare caps one upload request; stay well under it.
MAX_BATCH_BYTES = 40 * 1024 * 1024

for extension, mime in {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
    ".txt": "text/plain",
    ".json": "application/json",
}.items():
    mimetypes.add_type(mime, extension)


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def request(method, url, token, body=None, content_type=None):
    req = urllib.request.Request(url, method=method, data=body)
    req.add_header("Authorization", f"Bearer {token}")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as error:
        payload = error.read()
    except urllib.error.URLError as error:
        fail(f"Cloudflare API unreachable for {method} {url}: {error.reason}")
    try:
        data = json.loads(payload)
    except ValueError:
        fail(f"Cloudflare API returned non-JSON for {method} {url}")
    if not data.get("success"):
        errors = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in data.get("errors") or [])
        fail(f"Cloudflare API {method} {url}: {errors or 'request failed'}")
    return data.get("result") or {}


def multipart(parts):
    """parts: (name, filename | None, content_type, bytes) tuples."""
    boundary = uuid.uuid4().hex
    chunks = []
    for name, filename, content_type, data in parts:
        disposition = f'form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: {disposition}\r\n"
            f"Content-Type: {content_type}\r\n\r\n".encode()
        )
        chunks.append(data)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def asset_hash(data, path):
    # The documented scheme: SHA-256 of the base64 content plus the extension.
    encoded = base64.b64encode(data).decode()
    return hashlib.sha256((encoded + path.suffix.lstrip(".")).encode()).hexdigest()[:32]


def collect(root):
    files = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = "/" + path.relative_to(root).as_posix()
        # _headers travels in the script's config, never as a served file.
        if relative in ("/_headers", "/_redirects"):
            continue
        data = path.read_bytes()
        files[relative] = {"path": path, "hash": asset_hash(data, path), "size": len(data)}
    if "/index.html" not in files:
        fail(f"{root} has no index.html; is it a static export?")
    return files


def batches(hashes, by_hash):
    batch, size = [], 0
    for item in hashes:
        item_size = by_hash[item]["size"]
        if batch and size + item_size > MAX_BATCH_BYTES:
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += item_size
    if batch:
        yield batch


def upload_assets(args, token, files):
    manifest = {name: {"hash": f["hash"], "size": f["size"]} for name, f in files.items()}
    session = request(
        "POST",
        f"{args.api_url}/accounts/{args.account}/workers/scripts/{args.script}/assets-upload-session",
        token,
        json.dumps({"manifest": manifest}).encode(),
        "application/json",
    )
    completion = session.get("jwt")
    by_hash = {f["hash"]: f for f in files.values()}
    wanted = [h for bucket in session.get("buckets") or [] for h in bucket]
    for batch in batches(wanted, by_hash):
        parts = []
        for item in batch:
            path = by_hash[item]["path"]
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            parts.append((item, item, mime, base64.b64encode(path.read_bytes())))
        body, content_type = multipart(parts)
        result = request(
            "POST",
            f"{args.api_url}/accounts/{args.account}/workers/assets/upload?base64=true",
            session["jwt"],
            body,
            content_type,
        )
        completion = result.get("jwt") or completion
    if not completion:
        fail("Cloudflare returned no assets completion token")
    print(f"    {len(files)} assets, {len(wanted)} uploaded", file=sys.stderr)
    return completion


def bindings(args):
    result = [{"type": "assets", "name": "ASSETS"}]
    if args.api_origin:
        # worker.js sends /install.sh here; the API serves the script.
        result.append({"type": "plain_text", "name": "RELAY_API_ORIGIN", "text": args.api_origin.rstrip("/")})
    return result


def publish(args, token, completion):
    config = {
        "html_handling": "auto-trailing-slash",
        # A miss falls through to worker.js, which draws the app-shell line.
        "not_found_handling": "none",
    }
    if args.headers:
        config["_headers"] = Path(args.headers).read_text()
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": COMPATIBILITY_DATE,
        "assets": {"jwt": completion, "config": config},
        "bindings": bindings(args),
    }
    body, content_type = multipart([
        ("metadata", None, "application/json", json.dumps(metadata).encode()),
        ("worker.js", "worker.js", "application/javascript+module", Path(args.worker).read_bytes()),
    ])
    request("PUT", f"{args.api_url}/accounts/{args.account}/workers/scripts/{args.script}", token, body, content_type)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--script", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--headers")
    parser.add_argument("--api-origin", help="API origin that /install.sh redirects to")
    args = parser.parse_args()
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        fail("CLOUDFLARE_API_TOKEN is not set")
    root = Path(args.assets)
    if not root.is_dir():
        fail(f"assets directory not found: {root}")
    files = collect(root)
    publish(args, token, upload_assets(args, token, files))
    print(f"    Worker {args.script} published", file=sys.stderr)


if __name__ == "__main__":
    main()
