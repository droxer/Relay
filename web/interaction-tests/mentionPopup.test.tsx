import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { expect, it, vi } from "vitest";
import { MentionPopup } from "../src/components/composer/MentionPopup";
import { CommandInput } from "../src/components/ui/command";
import { Textarea } from "../src/components/ui/textarea";
import type { MentionCandidate } from "../src/lib/mentions";

/* The mention popup moved onto base-ui's Combobox, which means the composer's
   TEXTAREA is now a `Combobox.Input`. That is the risky part of the change:
   the textarea is the app's most-used control and it has three keyboard jobs
   the combobox knows nothing about — Cmd/Ctrl+Enter sends, a bare Enter
   inserts a newline, and the arrows move the caret between lines. Every one of
   those has to survive the popup being closed, and the send has to survive it
   being open.

   This harness is the composer's wiring in miniature: the same
   Combobox.Input-renders-a-Textarea shape, the same keydown ordering. */

const CANDIDATES: MentionCandidate[] = [
  { id: "a1", displayName: "Ada", eligible: true } as MentionCandidate,
  { id: "a2", displayName: "Alan", eligible: true } as MentionCandidate,
  { id: "a3", displayName: "Offline", eligible: false, reason: "offline" } as MentionCandidate,
];

function Harness({ matches, onPick, onSend }: {
  matches: MentionCandidate[];
  onPick: (c: MentionCandidate) => void;
  onSend: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <MentionPopup matches={matches} onPick={onPick}>
      <CommandInput
        render={<Textarea ref={ref} rows={1} /> as never}
        type={undefined}
        aria-label="Message"
        value={text}
        onChange={(e: any) => setText(e.target.value)}
        onKeyDown={(e: any) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
      />
    </MentionPopup>
  );
}

function setup(matches: MentionCandidate[]) {
  const onPick = vi.fn();
  const onSend = vi.fn();
  render(<Harness matches={matches} onPick={onPick} onSend={onSend} />);
  return { onPick, onSend, field: screen.getByLabelText("Message") };
}

it("lists candidates, keeping ineligible ones visible but unselectable", () => {
  setup(CANDIDATES);
  const options = screen.getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "Ada",
    "Alan",
    "Offlinecomposer.mention_reason.offline",
  ]);
  expect(options[2].getAttribute("data-disabled")).not.toBeNull();
});

it("renders no list when there is no open mention", () => {
  setup([]);
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});

it("picks the highlighted candidate on Enter", async () => {
  const user = userEvent.setup();
  const { onPick, field } = setup(CANDIDATES);
  field.focus();
  await user.keyboard("{ArrowDown}");
  await user.keyboard("{Enter}");
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
});

it("never picks an ineligible candidate", async () => {
  const user = userEvent.setup();
  const { onPick, field } = setup([CANDIDATES[2]]);
  field.focus();
  await user.keyboard("{ArrowDown}");
  await user.keyboard("{Enter}");
  expect(onPick).not.toHaveBeenCalled();
});

/* The three regressions this migration could plausibly cause. */

it("still sends on Cmd+Enter while the popup is open", async () => {
  const user = userEvent.setup();
  const { onSend, onPick, field } = setup(CANDIDATES);
  field.focus();
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect(onSend).toHaveBeenCalledTimes(1);
  // The modifier means "send", so the open list must not also accept.
  expect(onPick).not.toHaveBeenCalled();
});

it("still sends on Ctrl+Enter while the popup is closed", async () => {
  const user = userEvent.setup();
  const { onSend, field } = setup([]);
  field.focus();
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(onSend).toHaveBeenCalledTimes(1);
});

it("leaves a bare Enter to the textarea when the popup is closed", async () => {
  const user = userEvent.setup();
  const { onSend, onPick, field } = setup([]);
  field.focus();
  await user.type(field, "one{Enter}two");
  expect(onSend).not.toHaveBeenCalled();
  expect(onPick).not.toHaveBeenCalled();
  // The newline reached the value rather than being swallowed as a selection.
  expect((field as HTMLTextAreaElement).value).toBe("one\ntwo");
});

it("keeps the textarea a textarea", () => {
  const { field } = setup([]);
  expect(field.tagName).toBe("TEXTAREA");
});

it("announces as a plain textarea until an @ is in flight", () => {
  const { field } = setup([]);
  // The old implementation set these five conditionally by hand; base-ui does
  // the same thing, and this pins that it still does — a composer that claims
  // to be a combobox at rest would be announced wrongly on every focus.
  expect(field.getAttribute("role")).toBeNull();
  expect(field.getAttribute("aria-expanded")).toBeNull();
  expect(field.getAttribute("aria-controls")).toBeNull();
  expect(field.getAttribute("aria-activedescendant")).toBeNull();
  // `Combobox.Input` assumes an <input> and sets type="text", which is not a
  // valid attribute on a <textarea>; the composer clears it.
  expect(field.getAttribute("type")).toBeNull();
});

it("wires the combobox ARIA to the list once an @ is in flight", () => {
  const { field } = setup(CANDIDATES);
  expect(field.getAttribute("role")).toBe("combobox");
  expect(field.getAttribute("aria-expanded")).toBe("true");
  expect(field.getAttribute("aria-controls")).toBe("composer-mention-list");
  expect(field.getAttribute("aria-autocomplete")).toBe("list");
  const active = field.getAttribute("aria-activedescendant");
  expect(active).toBeTruthy();
  expect(document.getElementById(active!)?.getAttribute("role")).toBe("option");
});
