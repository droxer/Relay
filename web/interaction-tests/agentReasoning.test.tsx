import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { AgentStream } from "../src/components/AgentStream";

// Recorded Codex shape: one `reasoning` item per step, each written as a bold
// title with an optional body. A turn used to render one collapsed row per
// item — a column of identical controls — with the `**` markers left showing.
const REASONING = [
  {
    type: "item.completed",
    item: {
      id: "r1",
      type: "reasoning",
      text: "**Installing curated skill**\n\nPreparing to run the installer with escalated permissions.",
    },
  },
  { type: "item.completed", item: { id: "r2", type: "reasoning", text: "**Switching to python3**" } },
  { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Installed." } },
]
  .map((event) => JSON.stringify(event))
  .join("\n");

// While the run is live the answer has not arrived yet, so reasoning is the
// trailing block — the only visible progress the turn has.
const LIVE_REASONING = REASONING.split("\n").slice(0, 2).join("\n");

function renderStream(streaming: boolean) {
  return render(
    <AgentStream
      agent="codex"
      stdout={streaming ? LIVE_REASONING : REASONING}
      stderr=""
      streaming={streaming}
      collaborations={[]}
    />,
  );
}

it("collapses a settled turn's reasoning into one header naming the first step", async () => {
  const { container } = renderStream(false);

  const headers = screen.getAllByRole("button", { expanded: false });
  expect(headers).toHaveLength(1);
  expect(within(headers[0]!).getByText("Installing curated skill")).toBeTruthy();
  expect(container.querySelector(".agent-thinking-body")).toBeNull();

  await userEvent.click(headers[0]!);

  const body = container.querySelector(".agent-thinking-body");
  expect(body).not.toBeNull();
  expect([...body!.querySelectorAll(".agent-thinking-title")].map((el) => el.textContent)).toEqual([
    "Installing curated skill",
    "Switching to python3",
  ]);
  // The titles are structure, not text: no `**` reaches the transcript.
  expect(container.textContent).not.toContain("**");
});

it("opens live reasoning on the step the agent is on now, and lets the reader close it", async () => {
  const { container } = renderStream(true);

  const header = screen.getByRole("button", { expanded: true });
  expect(within(header).getByText("Switching to python3")).toBeTruthy();
  expect(container.querySelector(".agent-thinking-body")).not.toBeNull();

  await userEvent.click(header);

  expect(container.querySelector(".agent-thinking-body")).toBeNull();
});
