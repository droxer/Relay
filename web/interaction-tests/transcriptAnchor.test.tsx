import { afterEach, expect, it } from "vitest";
import { captureTranscriptAnchor, restoreTranscriptAnchor } from "../src/lib/transcriptAnchor";

/** A scroller of stacked turns whose rects follow `scrollTop` and `heights`. */
function transcript(heights: number[], viewport = 300) {
  const scroller = document.createElement("div");
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  scroller.getBoundingClientRect = () => rect(0, viewport);
  const turns = heights.map((_, index) => {
    const turn = document.createElement("div");
    turn.className = "msg";
    turn.getBoundingClientRect = () => {
      const start = heights.slice(0, index).reduce((sum, height) => sum + height, 0);
      return rect(start - scroller.scrollTop, heights[index]);
    };
    scroller.append(turn);
    return turn;
  });
  document.body.append(scroller);
  return { scroller, turns };
}

afterEach(() => { document.body.replaceChildren(); });

it("anchors on the first turn starting in view, not the one straddling the top", () => {
  const { scroller, turns } = transcript([100, 100, 100, 100]);
  scroller.scrollTop = 150;
  expect(captureTranscriptAnchor(scroller)?.element).toBe(turns[2]);
});

it("falls back to the straddling turn when it fills the viewport", () => {
  const { scroller, turns } = transcript([100, 1000, 100]);
  scroller.scrollTop = 300;
  expect(captureTranscriptAnchor(scroller)?.element).toBe(turns[1]);
});

it("undoes a height change above the anchor", () => {
  const heights = [100, 100, 100, 100];
  const { scroller } = transcript(heights);
  scroller.scrollTop = 150;
  const anchor = captureTranscriptAnchor(scroller);
  heights[0] = 160;
  restoreTranscriptAnchor(scroller, anchor);
  expect(scroller.scrollTop).toBe(210);
});

it("leaves the reader's own scrolling alone", () => {
  const { scroller } = transcript([100, 100, 100, 100]);
  scroller.scrollTop = 150;
  const anchor = captureTranscriptAnchor(scroller);
  scroller.scrollTop = 60;
  restoreTranscriptAnchor(scroller, anchor);
  expect(scroller.scrollTop).toBe(60);
});

it("ignores a change below the anchor", () => {
  const heights = [100, 100, 100, 100];
  const { scroller } = transcript(heights);
  scroller.scrollTop = 150;
  const anchor = captureTranscriptAnchor(scroller);
  heights[3] = 400;
  restoreTranscriptAnchor(scroller, anchor);
  expect(scroller.scrollTop).toBe(150);
});
