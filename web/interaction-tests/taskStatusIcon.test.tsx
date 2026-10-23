import { render } from "@testing-library/react";
import { createElement } from "react";
import { expect, it } from "vitest";

import { TaskStatusIcon } from "../src/components/TaskStatusIcon";
import type { TaskStatus } from "../src/types";

function glyph(status: TaskStatus): string {
  const { container } = render(createElement(TaskStatusIcon, { status }));
  // The shape without its hue: a status must read apart from its neighbours
  // with colour removed.
  return container.querySelector("svg")!.innerHTML;
}

it("draws waiting on a person apart from running, by shape and not hue alone", () => {
  expect(glyph("waiting_for_human")).not.toEqual(glyph("running"));
});

it("marks a waiting task with a still centre dot, not a progress fill", () => {
  const { container } = render(createElement(TaskStatusIcon, { status: "waiting_for_human" }));
  expect(container.querySelector(".task-status-fill")).toBeNull();
  expect(container.querySelector(".task-status-wait")).not.toBeNull();
});

it("draws progress as one fill class that only running animates", () => {
  const { container } = render(createElement(TaskStatusIcon, { status: "running" }));
  expect(container.querySelector(".task-status-fill")).not.toBeNull();
  const review = render(createElement(TaskStatusIcon, { status: "review" }));
  expect(review.container.querySelector(".task-status-fill")).not.toBeNull();
});
