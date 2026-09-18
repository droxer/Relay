import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampThreadListWidth,
  maxThreadListWidth,
  THREAD_LIST_VIEWPORT_SHARE,
  THREAD_LIST_WIDTH_DEFAULT,
  THREAD_LIST_WIDTH_MAX,
  THREAD_LIST_WIDTH_MIN,
} from "../src/lib/threadList.js";
import { TRANSCRIPT_MIN_WIDTH } from "../src/lib/threadSpace.js";

/* The thread rail's drag clamps. The sidenav and the space panel are tested
   beside their own modules; this file existed nowhere, which is why the rail
   was the pane whose ceiling drifted from the other two. */

describe("clampThreadListWidth", () => {
  it("holds the rail between its own bounds", () => {
    assert.equal(clampThreadListWidth(THREAD_LIST_WIDTH_DEFAULT), THREAD_LIST_WIDTH_DEFAULT);
    assert.equal(clampThreadListWidth(10), THREAD_LIST_WIDTH_MIN);
    assert.equal(clampThreadListWidth(10_000), THREAD_LIST_WIDTH_MAX);
    assert.equal(clampThreadListWidth(Number.NaN), THREAD_LIST_WIDTH_DEFAULT);
  });

  it("takes a lower ceiling from the caller but never one below the floor", () => {
    assert.equal(clampThreadListWidth(400, 300), 300);
    assert.equal(clampThreadListWidth(260, 300), 260);
    assert.equal(clampThreadListWidth(400, 40), THREAD_LIST_WIDTH_MIN);
  });
});

describe("maxThreadListWidth", () => {
  it("lets the rail take only what the chat column can spare", () => {
    assert.equal(
      maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, 480),
      THREAD_LIST_WIDTH_DEFAULT + (480 - TRANSCRIPT_MIN_WIDTH),
    );
  });

  it("caps at the absolute maximum however wide the chat column is", () => {
    assert.equal(maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, 4000), THREAD_LIST_WIDTH_MAX);
  });

  it("falls back to the absolute maximum with nothing to measure", () => {
    assert.equal(maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, null), THREAD_LIST_WIDTH_MAX);
    assert.equal(maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, Number.NaN), THREAD_LIST_WIDTH_MAX);
  });

  it("never lets a drag outrun the viewport cap the grid applies", () => {
    /* The shell track asks for min(--thread-w, Nvw). Below the crossover the
       rendered rail is the vw value, so a ceiling that knew only about px
       would let the stored width climb while the handle stood still under the
       pointer. One share, stated here and mirrored in palette.css. */
    const viewport = 1024;
    assert.equal(maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, 4000, viewport), Math.round(THREAD_LIST_VIEWPORT_SHARE * viewport));
    assert.equal(maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, 4000, 2560), THREAD_LIST_WIDTH_MAX);
    assert.equal(maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, 4000, null), THREAD_LIST_WIDTH_MAX);
    assert.equal(maxThreadListWidth(THREAD_LIST_WIDTH_DEFAULT, 4000, 320), THREAD_LIST_WIDTH_MIN);
  });

  it("shares the transcript floor with the other panes", () => {
    assert.equal(maxThreadListWidth(260, TRANSCRIPT_MIN_WIDTH), 260);
  });
});
