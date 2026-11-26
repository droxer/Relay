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

it("shows the recorded role and level beside the Agent name", () => {
  render(<DialogProvider><MessageBlock message={agentTurn({ role: "reviewer", roleLevel: "senior" })}
    sessionId="s" logicalAgentNames={{ "agent-1": "Reviewer" }} /></DialogProvider>);

  const header = screen.getByText("Reviewer").closest("header")!;
  expect(within(header).getByText("role_levels.senior · admin.v2.agent_role.reviewer")).toBeTruthy();
  expect(within(header).queryByText("Claude")).toBeNull();
  const receipt = screen.getByRole("region", { name: "thread.receipt.label" });
  expect(within(receipt).queryByText("Claude")).toBeNull();
  expect(within(receipt).queryByText("thread.receipt.runtime")).toBeNull();
});

it("shows a recorded legacy role without treating the runtime as the Agent's name", () => {
  render(<DialogProvider><MessageBlock message={agentTurn({ agentId: undefined, role: "reviewer" })} sessionId="s" /></DialogProvider>);

  const header = screen.getByText("backlog.agent").closest("header")!;
  expect(within(header).getByText("admin.v2.agent_role.reviewer")).toBeTruthy();
  expect(within(header).queryByText("Claude")).toBeNull();
});
