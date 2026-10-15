"""In-memory stand-in for the Railway GraphQL and Cloudflare v4 APIs.

Serves Railway at /graphql/v2 and Cloudflare at /client/v4, keyed on the
operation names deploy/lib/railway.sh sends. GET /__state dumps everything,
including per-operation call counts, for tests/run.sh to assert on; POST
/__seed_route adds a Worker route someone else owns.

    python3 mock_api.py <port>
"""

import base64
import json
import re
from email import policy
from email.parser import BytesParser
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

RAILWAY_TOKEN = "test-railway-token"
CLOUDFLARE_TOKEN = "test-cloudflare-token"
ZONE = "get-relay.cc"

STATE = {
    "calls": {},
    "workspaces": [{"id": "ws-1", "name": "Personal"}],
    "projects": {},
    "volumes": [],
    "dns": [],
    "settings": {"ssl": "flexible", "always_use_https": "off", "http3": "off", "0rtt": "off",
                 "early_hints": "off", "tiered_cache_smart_topology_enable": "off"},
    "routes": [],
    # Worker scripts by name, and asset contents by hash, as uploaded.
    "workers": {},
    "assets": {},
    # A rule someone else owns; the deploy script must leave it in place.
    "rulesets": {
        "http_request_late_transform": [
            {
                "id": "foreign-1",
                "version": "3",
                "description": "someone else's rule",
                "expression": '(http.host eq "blog.get-relay.cc")',
                "action": "rewrite",
                "action_parameters": {"headers": {"X-Other": {"operation": "set", "value": "1"}}},
                "enabled": True,
            }
        ]
    },
}


def new_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def count(name):
    STATE["calls"][name] = STATE["calls"].get(name, 0) + 1


def project():
    return next(iter(STATE["projects"].values()))


def service(service_id):
    return project()["services"][service_id]


def domain_status(domain):
    label = domain[: -len(ZONE)].rstrip(".")
    target = f"{(label or 'apex')}-x1y2.up.railway.app"
    host = f"_railway-verify.{label}" if label else "_railway-verify"
    return {
        "verificationDnsHost": host,
        "verificationToken": f"railway-verify={uuid.uuid4().hex[:12]}",
        "dnsRecords": [
            {
                "fqdn": domain,
                "recordType": "DNS_RECORD_TYPE_CNAME",
                "requiredValue": target,
                "purpose": "DNS_RECORD_PURPOSE_TRAFFIC_ROUTE",
            },
            {
                "fqdn": f"_acme-challenge.{domain}",
                "recordType": "DNS_RECORD_TYPE_CNAME",
                "requiredValue": f"{domain}.authorize.railwaydns.net",
                "purpose": "DNS_RECORD_PURPOSE_ACME_DNS01_CHALLENGE",
            },
        ],
    }


def add_service(name, deployed=False):
    sid = new_id("svc")
    project()["services"][sid] = {
        "name": name,
        "config": {},
        "repo": None,
        "branch": None,
        "variables": {},
        "domains": [],
        "deployments": [{"id": new_id("dep"), "status": "SUCCESS"}] if deployed else [],
    }
    return sid


def edges(nodes):
    return {"edges": [{"node": n} for n in nodes]}


def railway(op, v):
    count(op)
    if op == "Workspaces":
        return {"me": {"workspaces": STATE["workspaces"]}}
    if op == "Projects":
        return {"projects": edges([{"id": pid, "name": p["name"]} for pid, p in STATE["projects"].items()])}
    if op == "ProjectCreate":
        pid = new_id("prj")
        env = v["input"].get("defaultEnvironmentName") or "production"
        STATE["projects"][pid] = {"name": v["input"]["name"], "environments": {new_id("env"): env}, "services": {}}
        return {"projectCreate": {"id": pid}}
    if op == "Environments":
        envs = STATE["projects"][v["id"]]["environments"]
        return {"project": {"environments": edges([{"id": k, "name": n} for k, n in envs.items()])}}
    if op == "Services":
        svcs = STATE["projects"][v["id"]]["services"]
        return {"project": {"services": edges([{"id": k, "name": s["name"]} for k, s in svcs.items()])}}
    if op == "PostgresTemplate":
        return {"template": {"id": "tmpl-postgres", "serializedConfig": {"services": {}}}}
    if op == "TemplateDeploy":
        assert v["input"]["templateId"] == "tmpl-postgres"
        add_service("Postgres", deployed=True)
        return {"templateDeployV2": {"workflowId": new_id("wf")}}
    if op == "ServiceCreate":
        return {"serviceCreate": {"id": add_service(v["input"]["name"])}}
    if op == "ServiceConfig":
        assert not v["input"].get("railwayConfigFile"), "Config as Code is deprecated"
        assert v["input"].get("builder") in {"HEROKU", "NIXPACKS", "PAKETO", "RAILPACK"}, "Problem processing request: invalid GraphQL Builder enum"
        service(v["serviceId"])["config"] = v["input"]
        return {"serviceInstanceUpdate": True}
    if op == "Variables":
        return {"variables": service(v["s"])["variables"]}
    if op == "VariablesUpsert":
        assert v["input"]["skipDeploys"] is True
        service(v["input"]["serviceId"])["variables"].update(v["input"]["variables"])
        return {"variableCollectionUpsert": True}
    if op == "Volumes":
        return {"environment": {"volumeInstances": edges(STATE["volumes"])}}
    if op == "VolumeCreate":
        STATE["volumes"].append({"serviceId": v["input"]["serviceId"], "mountPath": v["input"]["mountPath"]})
        return {"volumeCreate": {"id": new_id("vol")}}
    if op == "Domains":
        svc = service(v["s"])
        return {"domains": {"serviceDomains": [], "customDomains": svc["domains"]}}
    if op == "DomainCreate":
        domain = v["input"]["domain"]
        service(v["input"]["serviceId"])["domains"].append({"domain": domain, "status": domain_status(domain)})
        return {"customDomainCreate": {"id": new_id("dom")}}
    if op == "Instance":
        repo = service(v["s"])["repo"]
        return {"serviceInstance": {"source": {"repo": repo} if repo else None}}
    if op == "Connect":
        svc = service(v["id"])
        assert svc["config"], "repo connected before the config-as-code path was set"
        assert svc["variables"], "repo connected before variables were set"
        svc["repo"], svc["branch"] = v["input"]["repo"], v["input"]["branch"]
        return {"serviceConnect": {"id": v["id"]}}
    if op == "Deploy":
        svc = service(v["s"])
        assert svc["repo"], "deploy before the repo was connected"
        assert re.fullmatch(r"[0-9a-f]{40}", v.get("commitSha", "")), "release must pin a commit"
        dep = {"id": new_id("dep"), "status": STATE.get("deployment_status", {}).get(svc["name"], "SUCCESS"), "commitSha": v["commitSha"]}
        svc["deployments"].insert(0, dep)
        return {"serviceInstanceDeployV2": dep["id"]}
    if op == "FailureLogs":
        for svc in project()["services"].values():
            if any(dep["id"] == v["id"] for dep in svc["deployments"]):
                return {"buildLogs": [{"message": svc["name"] + " build failure detail"}], "deploymentLogs": []}
        raise ValueError("unknown deployment")
    if op == "Deployments":
        return {"deployments": edges(service(v["input"]["serviceId"])["deployments"])}
    raise ValueError(f"unhandled Railway operation {op}")


def cloudflare(method, path, query, body):
    parts = path.split("/")[3:]  # after /client/v4
    if parts == ["zones"]:
        count("cf.zones")
        return 200, [{"id": "zone-1", "name": ZONE, "account": {"id": "acct-1"}}] if query.get("name") == [ZONE] else []
    if parts[0] == "accounts":
        return workers(method, parts[1], parts[2:], body)
    zone_id, rest = parts[1], parts[2:]
    assert zone_id == "zone-1"
    if rest == ["dns_records"] and method == "GET":
        count("cf.dns.list")
        return 200, [r for r in STATE["dns"] if r["name"] == query["name"][0]]
    if rest == ["dns_records"] and method == "POST":
        count("cf.dns.create")
        record = {"id": new_id("rec"), "proxied": False, **body}
        if record["type"] == "TXT":
            record["content"] = f'"{record["content"]}"'  # Cloudflare quotes TXT values
        STATE["dns"].append(record)
        return 200, record
    if rest[0] == "dns_records" and method == "PUT":
        count("cf.dns.update")
        record = next(r for r in STATE["dns"] if r["id"] == rest[1])
        record.update(body)
        return 200, record
    if rest == ["cache", "tiered_cache_smart_topology_enable"]:
        if method == "PATCH":
            count("cf.settings.tiered_cache_smart_topology_enable")
            STATE["settings"][rest[1]] = body["value"]
        return 200, {"id": rest[1], "value": STATE["settings"][rest[1]]}
    if rest == ["workers", "routes"] and method == "GET":
        return 200, STATE["routes"]
    if rest == ["workers", "routes"] and method == "POST":
        count("cf.routes.create")
        assert body["script"] in STATE["workers"], "route to a Worker that does not exist"
        route = {"id": new_id("route"), **body}
        STATE["routes"].append(route)
        return 200, route
    if rest[:2] == ["workers", "routes"] and method == "PUT":
        count("cf.routes.update")
        route = next(r for r in STATE["routes"] if r["id"] == rest[2])
        route.update(body)
        return 200, route
    if rest[0] == "settings":
        if method == "PATCH":
            count(f"cf.settings.{rest[1]}")
            STATE["settings"][rest[1]] = body["value"]
        return 200, {"id": rest[1], "value": STATE["settings"][rest[1]]}
    if rest[:2] == ["rulesets", "phases"]:
        phase = rest[2]
        if method == "GET":
            if phase not in STATE["rulesets"]:
                return 404, None
            return 200, {"phase": phase, "rules": STATE["rulesets"][phase]}
        count(f"cf.rules.{phase}")
        rules = [{"id": r.get("id") or new_id("rule"), "version": "1", **r} for r in body["rules"]]
        STATE["rulesets"][phase] = rules
        return 200, {"phase": phase, "rules": rules}
    raise ValueError(f"unhandled Cloudflare call {method} {path}")


def form_parts(content_type, raw):
    message = BytesParser(policy=policy.default).parsebytes(
        f"Content-Type: {content_type}\r\n\r\n".encode() + raw)
    return list(message.iter_parts())


def workers(method, account, rest, body):
    """Workers static-assets direct upload: session, buckets, script."""
    assert account == "acct-1"
    if rest[:2] == ["workers", "scripts"] and rest[3:] == ["assets-upload-session"]:
        count("cf.workers.session")
        manifest = body["manifest"]
        missing = sorted({e["hash"] for e in manifest.values()} - set(STATE["assets"]))
        STATE["manifest"] = manifest
        return 200, {"jwt": "upload-jwt" if missing else "completion-jwt", "buckets": [missing] if missing else []}
    if rest == ["workers", "scripts", rest[2]] and method == "PUT":
        count("cf.workers.script")
        content_type, raw = body
        parts = {part.get_param("name", header="content-disposition"): part for part in form_parts(content_type, raw)}
        metadata = json.loads(parts["metadata"].get_content())
        assert metadata["assets"]["jwt"] == "completion-jwt", "script upload without the completion token"
        STATE["workers"][rest[2]] = {
            "metadata": metadata,
            "module": parts[metadata["main_module"]].get_payload(decode=True).decode(),
            "manifest": STATE.get("manifest"),
        }
        return 200, {"id": rest[2]}
    raise ValueError(f"unhandled Workers call {method} {rest}")


def asset_upload(auth, content_type, raw):
    assert auth == "Bearer upload-jwt", "asset upload needs the session JWT"
    count("cf.workers.upload")
    for part in form_parts(content_type, raw):
        name = part.get_param("name", header="content-disposition")
        STATE["assets"][name] = {
            "type": part.get_content_type(),
            "content": base64.b64decode(part.get_payload(decode=True)).decode(errors="replace"),
        }
    return {"jwt": "completion-jwt"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        content_type = self.headers.get("Content-Type", "")
        if content_type.startswith("multipart/"):
            return content_type, raw
        return json.loads(raw) if raw else None

    def handle_any(self, method):
        url = urlparse(self.path)
        if url.path == "/__scenario" and method == "POST":
            STATE["deployment_status"] = self.body()
            return self.send(200, {})
        if url.path == "/__seed_route" and method == "POST":
            STATE["routes"].append({"id": new_id("route"), **self.body()})
            return self.send(200, {})
        if url.path == "/__state":
            return self.send(200, STATE)
        auth = self.headers.get("Authorization", "")
        try:
            if url.path == "/graphql/v2":
                if auth != f"Bearer {RAILWAY_TOKEN}":
                    return self.send(200, {"errors": [{"message": "Not Authorized"}]})
                req = self.body()
                op = re.match(r"\s*(?:query|mutation)\s+(\w+)", req["query"]).group(1)
                return self.send(200, {"data": railway(op, req.get("variables") or {})})
            if url.path == "/client/v4/accounts/acct-1/workers/assets/upload":
                content_type, raw = self.body()
                return self.send(201, {"success": True, "errors": [], "result": asset_upload(auth, content_type, raw)})
            if url.path.startswith("/client/v4/"):
                if auth != f"Bearer {CLOUDFLARE_TOKEN}":
                    return self.send(403, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]})
                status, result = cloudflare(method, url.path, parse_qs(url.query), self.body())
                if status == 404:
                    return self.send(404, {"success": False, "errors": [{"code": 10003, "message": "not found"}]})
                return self.send(status, {"success": True, "errors": [], "result": result})
        except (AssertionError, ValueError, KeyError, StopIteration) as error:
            return self.send(200 if url.path == "/graphql/v2" else 400,
                             {"errors": [{"message": f"mock: {error!r}"}], "success": False})
        return self.send(404, {"error": "unknown path"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_PATCH(self):
        self.handle_any("PATCH")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
