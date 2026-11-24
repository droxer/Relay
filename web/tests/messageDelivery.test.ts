import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { logout } from "../src/api-client/auth.ts";
import { RelayApiError } from "../src/api-client/client.ts";
import { runLogicalAgents, submitThreadMessage } from "../src/api-client/sessions.ts";

const originalFetch = globalThis.fetch;
const message = {
  text: "Check the latest update",
  intent: "review" as const,
  userMessageId: "evt_1",
  idempotencyKey: "evt_1",
  addressAgentIds: ["reviewer"],
  attachmentIds: ["image_1"],
};

afterEach(() => { globalThis.fetch = originalFetch; });

it("resends the same Thread message after a connection failure and a lost response body", async () => {
  const attempts: { url: string; body: string }[] = [];
  globalThis.fetch = async (url, init) => {
    attempts.push({ url: String(url), body: String(init?.body) });
    if (attempts.length === 1) throw new TypeError("Failed to fetch");
    if (attempts.length === 2) {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError("Connection closed")); },
      }), { status: 202 });
    }
    return Response.json({ id: "thread" }, { status: 202 });
  };

  assert.equal((await submitThreadMessage("thread", message)).id, "thread");
  assert.deepEqual(attempts, Array(3).fill({
    url: "/api/v1/threads/thread/messages?view=compact",
    body: JSON.stringify({
      text: message.text, attachmentIds: message.attachmentIds, intent: message.intent,
      addressAgentIds: message.addressAgentIds, userMessageId: message.userMessageId,
      idempotencyKey: message.idempotencyKey,
    }),
  }));
});

it("retries a new Thread after a gateway error with the original operation ID", async () => {
  const bodies: string[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return new Response("Bad gateway", { status: 502 });
    return Response.json({ id: "new-thread" }, { status: 202 });
  };

  assert.equal((await runLogicalAgents({
    taskGoal: message.text, userMessageId: message.userMessageId, idempotencyKey: message.idempotencyKey,
  })).id, "new-thread");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]).idempotencyKey, message.idempotencyKey);
});

it("sets a fresh deadline after a send times out", async (t) => {
  const firstAttempt = new AbortController();
  const secondAttempt = new AbortController();
  let timeouts = 0;
  t.mock.method(AbortSignal, "timeout", () => ++timeouts === 1 ? firstAttempt.signal : secondAttempt.signal);
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    signals.push(signal);
    if (signals.length === 1) {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return Response.json({ id: "thread" }, { status: 202 });
  };

  const sent = submitThreadMessage("thread", message);
  firstAttempt.abort(new DOMException("Timed out", "TimeoutError"));
  assert.equal((await sent).id, "thread");
  assert.deepEqual(signals, [firstAttempt.signal, secondAttempt.signal]);
});

it("returns the server error after two retries", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return Response.json({ detail: "Temporarily unavailable" }, { status: 503 });
  };

  await assert.rejects(submitThreadMessage("thread", message), { status: 503, message: "Temporarily unavailable" });
  assert.equal(attempts, 3);
});

it("does not replay a pending send after sign-out", async () => {
  let messageAttempts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth/logout")) return Response.json({ ok: true });
    messageAttempts += 1;
    throw new TypeError("Connection closed");
  };

  const sent = assert.rejects(submitThreadMessage("thread", message));
  await logout();
  await sent;
  assert.equal(messageAttempts, 1);
});

it("does not retry rejected sends or sends without stable operation IDs", async () => {
  for (const status of [400, 401, 403, 409, 422, 429]) {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response(null, { status });
    };
    await assert.rejects(submitThreadMessage("thread", message), (error) =>
      error instanceof RelayApiError && error.status === status);
    assert.equal(attempts, 1);
  }

  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(runLogicalAgents({ taskGoal: message.text, userMessageId: message.userMessageId }), TypeError);
  await assert.rejects(submitThreadMessage("thread", { text: message.text, intent: message.intent }), TypeError);
  assert.equal(attempts, 2);
});
