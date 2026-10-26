import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MessageBlock, type DerivedMessage } from "../src/components/MessageBlock";
import { DialogProvider } from "../src/components/ui/DialogProvider";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

function agentTurn(overrides: Partial<Extract<DerivedMessage, { kind: "agent" }>> = {}): DerivedMessage {
  return {
    kind: "agent",
    id: "turn",
    timestamp: "2026-10-26T10:00:00Z",
    agent: "claude",
    agentId: "agent-1",
    runId: "run-1",
    streaming: false,
    stdout: "",
    stderr: "",
    collaborations: [],
    attachments: [],
    tokenUsage: { input: 10, output: 5, cache: 0, total: 15 },
    outcome: "completed",
    finishedAt: "2026-10-26T10:01:00Z",
    ...overrides,
  } as DerivedMessage;
}

it("shows the runtime beside the agent name, not in the run receipt", () => {
  render(<DialogProvider><MessageBlock message={agentTurn()} sessionId="s" logicalAgentNames={{ "agent-1": "Reviewer" }} /></DialogProvider>);

  const header = screen.getByText("Reviewer").closest("header")!;
  expect(within(header).getByText("Claude")).toBeTruthy();
  const receipt = screen.getByRole("region", { name: "thread.receipt.label" });
  expect(within(receipt).queryByText("Claude")).toBeNull();
  expect(within(receipt).queryByText("thread.receipt.runtime")).toBeNull();
});

it("does not repeat the runtime when the agent is named by its runtime", () => {
  render(<DialogProvider><MessageBlock message={agentTurn({ agentId: undefined })} sessionId="s" /></DialogProvider>);

  const header = screen.getAllByText("Claude")[0].closest("header")!;
  expect(within(header).getAllByText("Claude")).toHaveLength(1);
});
