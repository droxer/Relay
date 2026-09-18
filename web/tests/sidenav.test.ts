import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  clampSidenavWidth,
  maxSidenavWidth,
  SIDENAV_VIEWPORT_SHARE,
  SIDENAV_WIDTH_DEFAULT,
  SIDENAV_WIDTH_MAX,
  SIDENAV_WIDTH_MIN,
} from "../src/lib/sidenav.js";
import { TRANSCRIPT_MIN_WIDTH } from "../src/lib/threadSpace.js";

describe("clampSidenavWidth", () => {
  it("keeps the dragged width inside the rail bounds", () => {
    assert.equal(clampSidenavWidth(SIDENAV_WIDTH_DEFAULT), SIDENAV_WIDTH_DEFAULT);
    assert.equal(clampSidenavWidth(10), SIDENAV_WIDTH_MIN);
    assert.equal(clampSidenavWidth(10_000), SIDENAV_WIDTH_MAX);
    assert.equal(clampSidenavWidth(Number.NaN), SIDENAV_WIDTH_DEFAULT);
  });

  it("honours a tighter ceiling from the available room", () => {
    assert.equal(clampSidenavWidth(300, 240), 240);
    assert.equal(clampSidenavWidth(200, 240), 200);
    // A ceiling below the minimum still yields a usable rail.
    assert.equal(clampSidenavWidth(300, 40), SIDENAV_WIDTH_MIN);
    assert.equal(clampSidenavWidth(10_000, 10_000), SIDENAV_WIDTH_MAX);
  });
});

describe("maxSidenavWidth", () => {
  it("lets the rail take only what the chat column can spare", () => {
    // 480px chat column, 420px floor → 60px of room on top of the current
    // width. Kept under SIDENAV_WIDTH_MAX so this exercises the room
    // calculation rather than the absolute cap.
    assert.equal(
      maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, 480),
      SIDENAV_WIDTH_DEFAULT + (480 - TRANSCRIPT_MIN_WIDTH),
    );
  });

  it("caps at the absolute maximum however wide the chat column is", () => {
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, 4000), SIDENAV_WIDTH_MAX);
  });

  it("shrinks the ceiling below the current width once the floor is crossed", () => {
    // This is what makes the transcript-floor guard give room back when the
    // rail is expanded on top of an already-tight chat column.
    assert.ok(maxSidenavWidth(300, TRANSCRIPT_MIN_WIDTH - 100) < 300);
  });

  it("falls back to the absolute maximum with nothing to measure", () => {
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, null), SIDENAV_WIDTH_MAX);
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, Number.NaN), SIDENAV_WIDTH_MAX);
  });

  it("never reports a ceiling below the rail minimum", () => {
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_MIN, 0), SIDENAV_WIDTH_MIN);
  });

  it("never lets a drag outrun the viewport cap the grid applies", () => {
    /* The shell track's preferred width is min(--sidenav-w-open, Nvw), so below
       the crossover CSS renders the rail narrower than the dragged number. A
       ceiling that ignored that would let the handle detach from the pointer:
       the stored width climbs, the rendered rail does not move. The share here
       and the vw in palette.css are one number (shellColumns.test.ts pins the
       pair together). */
    const viewport = 1024;
    const share = Math.round(SIDENAV_VIEWPORT_SHARE * viewport);
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, 4000, viewport), share);
    // A viewport wide enough that px wins is the old behaviour, unchanged.
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, 4000, 2560), SIDENAV_WIDTH_MAX);
    // Nothing measurable: fall back to the room calculation, as before.
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, 4000, null), SIDENAV_WIDTH_MAX);
  });

  it("keeps the viewport cap from ever reporting below the rail minimum", () => {
    assert.equal(maxSidenavWidth(SIDENAV_WIDTH_DEFAULT, 4000, 320), SIDENAV_WIDTH_MIN);
  });

  it("shares the transcript floor with the other panes", () => {
    // The rail, the thread list and the space panel all yield to the same
    // floor — three panes competing for one column with three different
    // floors would let two of them each think there was room.
    assert.equal(maxSidenavWidth(200, TRANSCRIPT_MIN_WIDTH), 200);
  });
});

describe("sidenav destinations", () => {
  const readWeb = (path: string) => readFileSync(resolve("web", path), "utf8");
  const source = readWeb("src/components/SideNav.tsx");
  const routes = [...readWeb("src/lib/viewTypes.ts")
    .match(/export type AppRoute =([^;]+);/)![1]!
    .matchAll(/"([a-z]+)"/g)].map((match) => match[1]!);
  const anchors = new Map(
    [...source.matchAll(/className=\{`sidenav-btn ([^`]*)`\}[\s\S]{0,120}?href=\{hrefForRoute\("([a-z]+)"\)\}/g)]
      .map((match) => [match[2]!, match[1]!] as const),
  );
  const overflow = new Set(
    [...source.matchAll(/\{\s*route:\s*"([a-z]+)"/g)].map((match) => match[1]!),
  );

  /* `skills` shipped listed only in MORE_ROUTES — the mobile overflow — while
     the More button itself is hidden on desktop, so the rail never offered it.
     Every destination needs a rail anchor, and every anchor hidden on phones
     needs its More entry. */
  /* `channels` is deliberately kept out of the nav — designIssues.test.ts
     enforces its absence — and stays reachable through the command palette. */
  const HIDDEN_ROUTES = new Set(["channels"]);

  it("gives every app route a rail anchor", () => {
    assert.ok(routes.length >= 10);
    for (const route of routes) {
      if (HIDDEN_ROUTES.has(route)) {
        assert.ok(!anchors.has(route), `${route} is meant to stay out of the rail`);
        continue;
      }
      assert.ok(anchors.has(route), `${route} has no sidenav anchor`);
    }
  });

  it("keeps mobile-hidden routes in the More menu", () => {
    for (const [route, classes] of anchors) {
      if (!classes.includes("sidenav-secondary-item") && !classes.includes("sidenav-overflow-item")) continue;
      assert.ok(overflow.has(route), `${route} is hidden on mobile but missing from MORE_ROUTES`);
    }
  });
});
