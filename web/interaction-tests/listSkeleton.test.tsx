import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { expect, it } from "vitest";

import { ListSkeleton } from "../src/components/ListSkeleton";

it("announces loading by name while drawing rows the shape of the list", () => {
  const { container } = render(createElement(ListSkeleton, { label: "Loading agents", rows: 4 }));
  expect(screen.getByRole("status").textContent).toContain("Loading agents");
  const rows = container.querySelectorAll(".list-skeleton-row");
  expect(rows).toHaveLength(4);
  for (const row of rows) expect(row.getAttribute("aria-hidden")).toBe("true");
});

it("defaults to a screenful of rows", () => {
  const { container } = render(createElement(ListSkeleton, { label: "Loading" }));
  expect(container.querySelectorAll(".list-skeleton-row").length).toBeGreaterThanOrEqual(5);
});
