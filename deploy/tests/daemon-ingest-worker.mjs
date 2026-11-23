import assert from "node:assert/strict";
import worker from "../workers/daemon-ingest.js";

const origin = "https://api.example.com";
const ingest = "https://ingest.example.com";
const env = { RELAY_API_HOST: "api.example.com", RELAY_INGEST_ORIGIN: ingest, RELAY_INGEST_EDGE_SECRET: "edge-secret" };
const originalFetch = globalThis.fetch;
const calls = [];
const receipt = new Response("accepted", { headers: { "X-Relay-Report-Id": "receipt" } });
globalThis.fetch = async (request) => {
  calls.push(request);
  return receipt;
};

try {
  assert.equal((await worker.fetch(new Request(ingest + "/api/v1/auth/me"), env)).status, 404);
  assert.equal(calls.length, 0);
  for (const path of ["events", "reports"]) {
    const url = `${origin}/api/v1/daemon-nodes/node-123/${path}?trace=1`;
    const body = '{"text": "unchanged bytes"}';
    const request = new Request(url, {
      method: "POST", body, headers: {
        Authorization: "Bearer node-token", "X-Relay-Report-Digest": "digest",
        "X-Relay-Edge": "untrusted-header", Host: "api.example.com", Cookie: "session=private",
      },
    });
    assert.equal(await worker.fetch(request, env), receipt);
    const forwarded = calls.pop();
    assert.equal(forwarded.url, url.replace(origin, ingest));
    assert.equal(forwarded.redirect, "manual");
    assert.equal(forwarded.headers.get("Authorization"), "Bearer node-token");
    assert.equal(forwarded.headers.get("X-Relay-Report-Digest"), "digest");
    assert.equal(forwarded.headers.get("X-Relay-Edge"), env.RELAY_INGEST_EDGE_SECRET);
    assert.equal(forwarded.headers.get("Host"), null);
    assert.equal(forwarded.headers.get("Cookie"), null);
    assert.equal(await forwarded.text(), body);
  }
  for (const [method, path] of [
    ["GET", "/api/v1/auth/me"],
    ["GET", "/api/v1/daemon-nodes/node-123/commands"],
    ["GET", "/api/v1/daemon-nodes/node-123/events"],
    ["POST", "/api/v1/daemon-nodes/node-123/heartbeat"],
    ["POST", "/api/v1/daemon-nodes/node-123/report-cleanups"],
  ]) {
    const request = new Request(origin + path, { method });
    assert.equal(await worker.fetch(request, env), receipt);
    assert.equal(calls.pop(), request);
  }
  globalThis.fetch = async (request) => {
    calls.push(request);
    throw new Error("ingestion service unavailable");
  };
  const unavailable = await worker.fetch(new Request(origin + "/api/v1/daemon-nodes/node-123/reports", {
    method: "POST", body: "{}",
  }), env);
  assert.equal(unavailable.status, 503);
  assert.equal(calls.length, 1);
} finally {
  globalThis.fetch = originalFetch;
}
