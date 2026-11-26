import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FAVICON_INK, FAVICON_INK_LIGHT, FAVICON_PATHS, faviconState, faviconSvg } from "../src/lib/faviconState.js";
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

const pathFills = (svg: string) => [...svg.matchAll(/<path [^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);

describe("favicon state", () => {
  it("is idle when nothing runs and nothing waits", () => {
    assert.equal(faviconState([item(), item({ id: "ses_2" })]), "idle");
    assert.equal(faviconState([]), "idle");
  });

  it("is running while an agent works on any thread", () => {
    assert.equal(faviconState([item(), item({ id: "ses_2", status: "running" })]), "running");
    assert.equal(faviconState([item({}, { runningAgent: "claude" })]), "running");
  });

  it("stays idle for a run that is only queued: no agent is working yet", () => {
    const queued = item({ status: "running", execution: { phase: "queued" } as RelaySession["execution"] });
    assert.equal(faviconState([queued]), "idle");
  });

  it("puts a person first: needs-you outranks running", () => {
    const waiting = item({ id: "ses_w", status: "waiting_for_human" });
    assert.equal(faviconState([item({ status: "running" }), waiting]), "waiting");
  });
});

describe("favicon mark", () => {
  it("keeps idle tabs monochrome with a bronze baton and lights the acting side during activity", () => {
    const ink = FAVICON_INK;
    assert.deepEqual(pathFills(faviconSvg("idle")), [ink.unlit, ink.action, ink.unlit]);
    assert.deepEqual(pathFills(faviconSvg("running")), [ink.unlit, ink.live, ink.live]);
    assert.deepEqual(pathFills(faviconSvg("waiting")), [ink.action, ink.action, ink.unlit]);
  });

  it("keeps an idle mark legible on its tile", () => {
    // WCAG relative luminance: the rails stay bright enough to preserve the
    // silhouette beside the colored activity indicator.
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
    for (const ink of [FAVICON_INK, FAVICON_INK_LIGHT]) {
      assert.ok(contrast(ink.unlit, ink.canvas) >= 12, `${ink.unlit} on ${ink.canvas}`);
      for (const hue of [ink.unlit, ink.action, ink.live]) {
        assert.ok(contrast(hue, ink.canvas) >= 4.5, `${hue} on ${ink.canvas}`);
      }
    }
  });

  it("adapts to the viewer's color scheme with a dark default", () => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (!existsSync(path.join(dir, "web", "public", "favicon.svg"))) dir = path.dirname(dir);
    const shipped = readFileSync(path.join(dir, "web", "public", "favicon.svg"), "utf8");
    assert.match(shipped, /prefers-color-scheme: light/);
    for (const hex of [FAVICON_INK_LIGHT.canvas, FAVICON_INK_LIGHT.outline, FAVICON_INK_LIGHT.unlit, FAVICON_INK_LIGHT.action]) {
      assert.ok(shipped.includes(hex), `favicon.svg light register must include ${hex}`);
      assert.ok(faviconSvg("idle").includes(hex), `faviconSvg light register must include ${hex}`);
    }
    assert.ok(faviconSvg("running").includes(FAVICON_INK_LIGHT.live));
    const geometry = (svg: string) => [...svg.matchAll(/<path [^>]*d="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(geometry(faviconSvg("idle")), geometry(shipped));
    assert.deepEqual(geometry(shipped), [FAVICON_PATHS.top, FAVICON_PATHS.baton, FAVICON_PATHS.bottom]);
    assert.deepEqual(pathFills(shipped), [FAVICON_INK.unlit, FAVICON_INK.action, FAVICON_INK.unlit]);
    assert.deepEqual(pathFills(faviconSvg("idle")), pathFills(shipped));
    assert.ok(shipped.includes(`fill="${FAVICON_INK.canvas}"`));
    const tile = (svg: string) => svg.match(/<rect [^>]*\/>/)?.[0];
    assert.equal(tile(faviconSvg("idle")), tile(shipped));
    assert.deepEqual(
      [...shipped.matchAll(/<path class="(\w+)"/g)].map((m) => m[1]),
      [...faviconSvg("idle").matchAll(/<path class="(\w+)"/g)].map((m) => m[1]),
    );
  });

  it("keeps FAVICON_INK and offline.html aligned with palette.css dark/light registers", () => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (!existsSync(path.join(dir, "web", "src", "styles", "tokens", "palette.css"))) dir = path.dirname(dir);
    const palette = readFileSync(path.join(dir, "web", "src", "styles", "tokens", "palette.css"), "utf8");
    const lightIdx = palette.indexOf('html[data-theme="light"]');
    const darkReg = palette.slice(0, lightIdx);
    const lightReg = palette.slice(lightIdx);
    const tok = (reg: string, name: string) => reg.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`))?.[1];

    assert.equal(FAVICON_INK.canvas, tok(darkReg, "--surface-0"));
    assert.equal(FAVICON_INK.outline, tok(darkReg, "--line-1"));
    assert.equal(FAVICON_INK.action, tok(darkReg, "--brand-lead"));
    assert.equal(FAVICON_INK.live, tok(darkReg, "--live"));
    assert.equal(FAVICON_INK.unlit, tok(darkReg, "--ink-1"));

    assert.equal(FAVICON_INK_LIGHT.canvas, tok(lightReg, "--surface-0"));
    assert.equal(FAVICON_INK_LIGHT.outline, tok(lightReg, "--line-1"));
    assert.equal(FAVICON_INK_LIGHT.action, tok(lightReg, "--brand-lead"));
    assert.equal(FAVICON_INK_LIGHT.live, tok(lightReg, "--live"));
    assert.equal(FAVICON_INK_LIGHT.unlit, tok(lightReg, "--ink-1"));

    const offline = readFileSync(path.join(dir, "web", "public", "offline.html"), "utf8");
    for (const hex of [
      tok(darkReg, "--surface-0"),
      tok(darkReg, "--ink-1"),
      tok(darkReg, "--brand-lead"),
      tok(lightReg, "--surface-0"),
      tok(lightReg, "--ink-1"),
      tok(lightReg, "--brand-lead"),
    ]) {
      assert.ok(hex && offline.includes(hex), `offline.html must include ${hex}`);
    }
    assert.ok(offline.includes(`d="${FAVICON_PATHS.top}"`), "offline.html must use canonical RelayMark top track");
    assert.ok(offline.includes(`d="${FAVICON_PATHS.baton}"`), "offline.html must use canonical RelayMark center baton");
    assert.ok(offline.includes(`d="${FAVICON_PATHS.bottom}"`), "offline.html must use canonical RelayMark bottom track");
  });
});
