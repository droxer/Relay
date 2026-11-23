import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useTranscriptWindow } from "../src/hooks/useTranscriptWindow";

const readingPosition = { hold: () => {}, keep: () => {} };

it("opens on the latest page and keeps mounted turns through a large catch-up", () => {
  const view = renderHook(
    ({ total, eventStart, hasEvents }) => useTranscriptWindow("thread", total, eventStart, hasEvents, readingPosition),
    { initialProps: { total: 1, eventStart: 0, hasEvents: false } },
  );

  view.rerender({ total: 100, eventStart: 5, hasEvents: true });
  expect(view.result.current.start).toBe(60);

  view.rerender({ total: 180, eventStart: 5, hasEvents: true });
  expect(view.result.current.start).toBe(60);
});
