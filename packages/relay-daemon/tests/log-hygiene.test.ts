import assert from "node:assert/strict";
import test from "node:test";

import { AgentNotInstalledError, agentPreflightError } from "../src/agent-preflight.js";
import { ERROR_DETAIL_LIMIT, errorBodyDetail } from "../src/http-error-detail.js";

const CLOUDFLARE_502 = `<!DOCTYPE html>
<html class="no-js" lang="en-US"><head>
<title>get-relay.cc | 502: Bad gateway</title></head>
<body><span class="hidden" id="cf-footer-ip">117.22.249.38</span></body></html>`;

test("an HTML error page collapses to its title and drops the client IP", () => {
  const detail = errorBodyDetail(CLOUDFLARE_502);
  assert.equal(detail, "HTML error page: get-relay.cc | 502: Bad gateway");
  assert.doesNotMatch(detail, /117\.22/);
});

test("a long plain error body is bounded", () => {
  const detail = errorBodyDetail("x".repeat(5_000));
  assert.equal(detail.length, ERROR_DETAIL_LIMIT + 1);
  assert.equal(errorBodyDetail(' {"error": "node_gone"}\n'), '{"error": "node_gone"}');
});

test("a missing agent CLI is reported as not installed, not as an auth failure", () => {
  for (const stderr of ["bash: codex: command not found", "sh: 1: codex: not found", "zsh: command not found: codex"]) {
    const error = agentPreflightError("codex", { exit_code: 127, stderr });
    assert.ok(error instanceof AgentNotInstalledError, stderr);
    assert.equal(error.message, "Codex is not installed on this computer (`codex` was not found on PATH).");
  }
  assert.ok(agentPreflightError("codex", { exit_code: 127, stderr: "" }) instanceof AgentNotInstalledError);
});

test("a present but failing agent CLI keeps its preflight detail", () => {
  const error = agentPreflightError("codex", { exit_code: 1, stderr: "Not logged in" });
  assert.equal(error instanceof AgentNotInstalledError, false);
  assert.equal(error.message, "Codex auth check failed (exit code 1).\nNot logged in");
});

test('transport failures preserve nested error codes without logging cause payloads', async () => {
  const { transportErrorDetail } = await import('../src/http-error-detail.js');
  const lookup = Object.assign(new Error('private response payload'), {
    code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'api.get-relay.cc',
  });
  const error = new TypeError('fetch failed', { cause: new AggregateError([lookup], 'private aggregate') });
  const detail = transportErrorDetail(error);
  assert.match(detail, /fetch failed/);
  assert.match(detail, /ENOTFOUND/);
  assert.match(detail, /api.get-relay.cc/);
  assert.doesNotMatch(detail, /private/);
  const cyclic = new Error('fetch failed');
  cyclic.cause = cyclic;
  assert.equal(transportErrorDetail(cyclic), 'fetch failed');
});

test('HTTP/2 failures preserve the numeric reset reason without exposing cause messages', async () => {
  const { transportErrorDetail } = await import('../src/http-error-detail.js');
  const cause = Object.assign(new Error('private headers and response data'), {
    code: 'ERR_HTTP2_STREAM_ERROR', http2ErrorCode: 2,
  });
  const detail = transportErrorDetail(new TypeError('fetch failed', { cause }));
  assert.match(detail, /ERR_HTTP2_STREAM_ERROR/);
  assert.match(detail, /http2ErrorCode=2/);
  assert.doesNotMatch(detail, /private/);
  cause.http2ErrorCode = Number.NaN;
  assert.doesNotMatch(transportErrorDetail(new TypeError('fetch failed', { cause })), /http2ErrorCode=/);
});

test('HTTP/2 reset names survive wrappers that omit the numeric code', async () => {
  const { transportErrorDetail } = await import('../src/http-error-detail.js');
  const cause = Object.assign(new Error('Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'), {
    code: 'ERR_HTTP2_STREAM_ERROR',
  });
  assert.match(transportErrorDetail(new TypeError('fetch failed', { cause })), /http2Reset=NGHTTP2_ENHANCE_YOUR_CALM/);
  cause.message = 'Stream closed with error code NGHTTP2_PRIVATE_PAYLOAD';
  assert.doesNotMatch(transportErrorDetail(new TypeError('fetch failed', { cause })), /PRIVATE_PAYLOAD/);
});
