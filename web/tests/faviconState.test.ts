import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FAVICON_INK, FAVICON_PATHS, faviconState, faviconSvg } from "../src/lib/faviconState.js";
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
    const ink = FAVICON_INK;
    assert.deepEqual(strokes(faviconSvg("idle")), [ink.unlit, ink.unlit]);
    assert.deepEqual(strokes(faviconSvg("running")), [ink.unlit, ink.live]);
    assert.deepEqual(strokes(faviconSvg("waiting")), [ink.action, ink.unlit]);
  });

  it("keeps an idle mark legible on its tile", () => {
    // WCAG relative luminance; an unlit chevron at the old ~2.7:1 vanished
    // in a 16px tab.
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const hue of [FAVICON_INK.unlit, FAVICON_INK.action, FAVICON_INK.live]) {
      assert.ok(contrast(hue, FAVICON_INK.canvas) >= 4.5, `${hue} on ${FAVICON_INK.canvas}`);
    }
  });

  it("draws one register, whatever the viewer's color scheme", () => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (!existsSync(path.join(dir, "web", "public", "favicon.svg"))) dir = path.dirname(dir);
    const shipped = readFileSync(path.join(dir, "web", "public", "favicon.svg"), "utf8");
    assert.doesNotMatch(shipped, /prefers-color-scheme/);
    const geometry = (svg: string) => [...svg.matchAll(/<path [^>]*d="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(geometry(faviconSvg("idle")), geometry(shipped));
    assert.deepEqual(geometry(shipped), [FAVICON_PATHS.lead, FAVICON_PATHS.trail]);
    assert.deepEqual(strokes(shipped), [FAVICON_INK.action, FAVICON_INK.live]);
    assert.ok(shipped.includes(`fill="${FAVICON_INK.canvas}"`));
  });
});
