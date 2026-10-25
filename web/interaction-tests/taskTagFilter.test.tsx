import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaskTagList } from "../src/components/TaskTags";
import { TagFilterContext } from "../src/components/tagFilter";

it("draws plain badges when no list offers a tag filter", () => {
  render(<TaskTagList tags={["bug", "billing"]} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("bug")).toBeTruthy();
});

it("makes each tag a toggle that filters its list by that tag", () => {
  const onSelect = vi.fn();
  render(
    <TagFilterContext value={{ active: "all", onSelect }}>
      <TaskTagList tags={["bug", "billing"]} />
    </TagFilterContext>,
  );
  const [bug, billing] = screen.getAllByRole("button");
  expect(bug.getAttribute("aria-pressed")).toBe("false");
  expect(billing.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(bug);
  expect(onSelect).toHaveBeenCalledWith("bug");
});

it("marks the tag the list is filtered on and clears the filter when it is clicked again", () => {
  const onSelect = vi.fn();
  render(
    <TagFilterContext value={{ active: "Bug", onSelect }}>
      <TaskTagList tags={["bug", "billing"]} />
    </TagFilterContext>,
  );
  const [bug, billing] = screen.getAllByRole("button");
  // Tags compare case-insensitively, so a ?tag=Bug link presses "bug".
  expect(bug.getAttribute("aria-pressed")).toBe("true");
  expect(billing.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(bug);
  expect(onSelect).toHaveBeenCalledWith("all");
});

it("keeps a tag click from also opening the row it sits in", () => {
  const onRow = vi.fn();
  render(
    <div onClick={onRow}>
      <TagFilterContext value={{ active: "all", onSelect: vi.fn() }}>
        <TaskTagList tags={["bug"]} />
      </TagFilterContext>
    </div>,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(onRow).not.toHaveBeenCalled();
});

it("draws the filtered tag first so a capped row never folds it into +N", () => {
  render(
    <TagFilterContext value={{ active: "release", onSelect: vi.fn() }}>
      <TaskTagList tags={["bug", "billing", "release"]} max={2} />
    </TagFilterContext>,
  );
  const [first] = screen.getAllByRole("button");
  expect(first.textContent).toBe("release");
  expect(first.getAttribute("aria-pressed")).toBe("true");
});
