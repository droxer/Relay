import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CommandMenu } from "../src/components/CommandMenu";
import type { CommandItem } from "../src/lib/commandMenu";

/* The palette moved off a hand-rolled listbox onto base-ui's Combobox. The
   contract it has to keep is behavioural, not structural, so these drive it
   the way a person does: type, arrow, Enter.

   `setup.tsx` stubs the Dialog to render its children inline, which is what
   makes this testable in jsdom — the palette's own markup is what is under
   test, not the portal. */

const COMMANDS: CommandItem[] = [
  { id: "go-threads", group: "navigate", label: "Threads", keywords: ["threads"], hint: "G T" },
  { id: "go-backlog", group: "navigate", label: "Backlog", keywords: ["backlog"], hint: "G B" },
  { id: "new-thread", group: "create", label: "New thread", keywords: ["new"] },
] as CommandItem[];

function renderMenu(onRun = vi.fn(), onClose = vi.fn()) {
  render(<CommandMenu open commands={COMMANDS} onRun={onRun} onClose={onClose} />);
  return { onRun, onClose };
}

it("lists every command under its group heading", () => {
  renderMenu();
  const options = screen.getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "ThreadsG T",
    "BacklogG B",
    "New thread",
  ]);
  // Group headings survive the move to Combobox.Group.
  expect(screen.getByText("command.group_navigate")).toBeTruthy();
  expect(screen.getByText("command.group_create")).toBeTruthy();
});

it("filters through the app's own ranking as you type", async () => {
  const user = userEvent.setup();
  renderMenu();
  await user.type(screen.getByRole("combobox"), "back");
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(1);
  expect(options[0].textContent).toContain("Backlog");
});

it("runs the highlighted command on Enter and closes first", async () => {
  const user = userEvent.setup();
  const order: string[] = [];
  const onRun = vi.fn(() => order.push("run"));
  const onClose = vi.fn(() => order.push("close"));
  renderMenu(onRun, onClose);

  const input = screen.getByRole("combobox");
  await user.type(input, "back");
  await user.keyboard("{Enter}");

  expect(onRun).toHaveBeenCalledWith("go-backlog");
  // Close before run: running a command navigates, and a palette still open
  // over the destination is the bug this ordering prevents.
  expect(order).toEqual(["close", "run"]);
});

it("highlights the first command on open, so a bare Enter runs it", async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  renderMenu(onRun);
  screen.getByRole("combobox").focus();
  await user.keyboard("{Enter}");
  expect(onRun).toHaveBeenCalledWith("go-threads");
});

it("moves the highlight with the arrow keys", async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  renderMenu(onRun);
  screen.getByRole("combobox").focus();
  // The first item is already highlighted, so one step down is the second.
  await user.keyboard("{ArrowDown}");
  await user.keyboard("{Enter}");
  expect(onRun).toHaveBeenCalledWith("go-backlog");
});

it("announces the empty state when nothing matches", async () => {
  const user = userEvent.setup();
  renderMenu();
  await user.type(screen.getByRole("combobox"), "zzzz");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByText("command.empty")).toBeTruthy();
});

it("points the input at the listbox it controls", () => {
  renderMenu();
  const input = screen.getByRole("combobox");
  // The ARIA the old implementation wrote by hand now comes from the
  // primitive; it still has to be there.
  expect(input.getAttribute("aria-expanded")).toBe("true");
  const listId = input.getAttribute("aria-controls");
  expect(listId).toBeTruthy();
  const list = document.getElementById(listId!);
  expect(list).toBeTruthy();
  expect(within(list!).getAllByRole("option").length).toBe(3);
});

it("closes on Escape", () => {
  const { onClose } = renderMenu();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("marks the highlighted row with the attribute the stylesheet paints", async () => {
  const user = userEvent.setup();
  renderMenu();
  screen.getByRole("combobox").focus();
  // command.css paints `.command-item[data-highlighted]`. The old markup used
  // a hand-written `data-active`, so this pins the two to each other — a
  // mismatch here shows up as a palette with no visible selection, which
  // reads as "nothing happened" rather than as a broken rule.
  const first = () => screen.getAllByRole("option")[0];
  expect(first().hasAttribute("data-highlighted")).toBe(true);
  await user.keyboard("{ArrowDown}");
  expect(first().hasAttribute("data-highlighted")).toBe(false);
  expect(screen.getAllByRole("option")[1].hasAttribute("data-highlighted")).toBe(true);
});
