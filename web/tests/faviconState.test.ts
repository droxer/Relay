import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FAVICON_INK, faviconState, faviconSvg } from "../src/lib/faviconState.js";
import type { ThreadItem } from "../src/lib/threads.js";
import type { RelaySession } from "../src/types.js";

function item(partial: Partial<RelaySession> = {}, extra: Partial<ThreadItem> = {}): ThreadItem {
  return {
    session: {
      id: partial.id ?? "ses_1",
      workspacePath: "/workspace",
      taskGoal: "Ship pricing copy",
      participants: ["human", "claude"],
      status: "completed",
      phase: "completed",
      createdAt: "2026-10-23T00:00:00.000Z",
      updatedAt: "2026-10-23T00:00:00.000Z",
      agentRuns: [],
      artifacts: [],
      decisions: [],
      collaborationRounds: [],
      events: [],
      ...partial,
    } as RelaySession,
    participants: [],
    ...extra,
  } as ThreadItem;
}

const strokes = (svg: string) => [...svg.matchAll(/<path [^>]*stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1]);

describe("favicon state", () => {
  it("is idle when nothing runs and nothing waits", () => {
    assert.equal(faviconState([item(), item({ id: "ses_2" })]), "idle");
    assert.equal(faviconState([]), "idle");
  });

  it("is running while an agent works on any thread", () => {
    assert.equal(faviconState([item(), item({ id: "ses_2", status: "running" })]), "running");
    assert.equal(faviconState([item({}, { runningAgent: "claude" })]), "running");
  });

  it("puts a person first: needs-you outranks running", () => {
    const waiting = item({ id: "ses_w", status: "waiting_for_human" });
    assert.equal(faviconState([item({ status: "running" }), waiting]), "waiting");
  });
});

describe("favicon mark", () => {
  it("lights only the half that is acting", () => {
    assert.deepEqual(strokes(faviconSvg("idle")), [FAVICON_INK.unlit, FAVICON_INK.unlit]);
    assert.deepEqual(strokes(faviconSvg("running")), [FAVICON_INK.unlit, FAVICON_INK.live]);
    assert.deepEqual(strokes(faviconSvg("waiting")), [FAVICON_INK.action, FAVICON_INK.unlit]);
  });

  it("draws the same geometry and canvas as the static favicon", () => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (!existsSync(path.join(dir, "web", "public", "favicon.svg"))) dir = path.dirname(dir);
    const shipped = readFileSync(path.join(dir, "web", "public", "favicon.svg"), "utf8");
    const geometry = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(geometry(faviconSvg("idle")), geometry(shipped));
    assert.deepEqual(strokes(shipped), [FAVICON_INK.action, FAVICON_INK.live]);
    assert.ok(shipped.includes(`fill="${FAVICON_INK.canvas}"`));
  });
});
