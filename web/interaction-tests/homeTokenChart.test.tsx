import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { HomeTokenStats } from "../src/api-client/home";
import { HomeTokenChart } from "../src/components/home/HomeTokenChart";

const counts = { fresh: 100, input: 100, output: 0, cacheWrite: 0, cacheRead: 0, cache: 0, total: 100 };

function data(...dates: string[]): HomeTokenStats {
  return {
    ...counts, available: true, bucketSize: "day", unreportedRuns: [],
    daily: dates.map(date => ({ ...counts, date })),
  };
}

const chart = (tokens: HomeTokenStats) => <HomeTokenChart tokens={tokens} isLoading={false} isError={false} />;
const selected = () => screen.queryByRole("button", { pressed: true });

it("keeps the same token bucket selected as the window moves and clears it when the bucket leaves", () => {
  const view = render(chart(data("2026-11-25", "2026-11-26", "2026-11-27")));
  const bucket = screen.getAllByRole("button")[1];
  fireEvent.click(bucket);
  expect(selected()).toBe(bucket);

  view.rerender(chart(data("2026-11-26", "2026-11-27", "2026-11-28")));
  expect(selected()).toBe(bucket);

  view.rerender(chart(data("2026-11-27", "2026-11-28", "2026-11-29")));
  expect(selected()).toBeNull();
  expect(view.container.querySelector("[data-dim='true']")).toBeNull();
});

it("clears the readout when the same date starts a bucket of a different size", () => {
  const tokens = data("2026-11-01");
  const view = render(chart(tokens));
  fireEvent.click(screen.getByRole("button"));
  expect(selected()).toBeTruthy();
  view.rerender(chart({ ...tokens, bucketSize: "month" }));
  expect(selected()).toBeNull();
});
