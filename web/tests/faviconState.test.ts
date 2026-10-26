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
  it("lights only the half that is acting, in both registers", () => {
    for (const theme of ["dark", "light"] as const) {
      const ink = FAVICON_INK[theme];
      assert.deepEqual(strokes(faviconSvg("idle", theme)), [ink.unlit, ink.unlit]);
      assert.deepEqual(strokes(faviconSvg("running", theme)), [ink.unlit, ink.live]);
      assert.deepEqual(strokes(faviconSvg("waiting", theme)), [ink.action, ink.unlit]);
    }
  });

  it("draws the light register on a white badge with a hairline, the dark one without", () => {
    assert.match(faviconSvg("idle", "light"), /<rect [^>]*fill="#ffffff" stroke="#d9d9d9"/);
    assert.doesNotMatch(faviconSvg("idle", "dark"), /<rect [^>]*stroke=/);
    assert.equal(faviconSvg("running"), faviconSvg("running", "dark"));
  });

  it("draws the same geometry and both registers' colours as the static favicon", () => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (!existsSync(path.join(dir, "web", "public", "favicon.svg"))) dir = path.dirname(dir);
    const shipped = readFileSync(path.join(dir, "web", "public", "favicon.svg"), "utf8");
    const geometry = (svg: string) => [...svg.matchAll(/<path [^>]*d="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(geometry(faviconSvg("idle")), geometry(shipped));
    assert.deepEqual(strokes(shipped), [FAVICON_INK.dark.action, FAVICON_INK.dark.live]);
    assert.ok(shipped.includes(`fill="${FAVICON_INK.dark.canvas}"`));
    const light = shipped.slice(shipped.indexOf("prefers-color-scheme: light"));
    const { canvas, edge, action, live } = FAVICON_INK.light;
    assert.match(light, new RegExp(`\\.canvas \\{ fill: ${canvas}; stroke: ${edge};`));
    assert.match(light, new RegExp(`\\.lead \\{ stroke: ${action}; \\}`));
    assert.match(light, new RegExp(`\\.trail \\{ stroke: ${live}; \\}`));
  });
});
