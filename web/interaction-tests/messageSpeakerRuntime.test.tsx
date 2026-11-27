import { render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { expect, it, vi } from "vitest";
import { MessageBlock, projectMessages, type DerivedMessage } from "../src/components/MessageBlock";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { RelaySession } from "../src/types";

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
  expect(within(header).getByText("role_levels.badge_senior")).toBeTruthy();
  expect(within(header).getByText("admin.v2.agent_role.reviewer")).toBeTruthy();
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

it("shows the Task Thread speaker and profile image when the run started before the transcript window", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: {} });
  const startedAt = "2026-10-26T10:00:00Z";
  const completedAt = "2026-10-26T10:01:00Z";
  const session: RelaySession = {
    id: "task-thread",
    taskGoal: "Review the change",
    workspacePath: "/workspace",
    participants: ["human", "claude"],
    status: "completed",
    phase: "completed",
    createdAt: startedAt,
    updatedAt: completedAt,
    agentRuns: [{
      id: "run-1", agent: "claude", logicalAgentId: "reviewer", status: "completed",
      startedAt, completedAt, artifactIds: [],
    }],
    artifacts: [],
    decisions: [],
    collaborationRounds: [],
    eventStart: 3,
    events: [{
      id: "completed", sessionId: "task-thread", timestamp: completedAt, type: "agent.completed",
      runId: "run-1", agent: "claude", status: "completed", exitCode: 0,
    }],
  };
  const profileImage = "/profile-images/agents/reviewer.webp";
  const messages = projectMessages(session, i18n.t);

  const { container } = render(<DialogProvider>
    {messages.map((message) => <MessageBlock key={message.id} message={message} sessionId={session.id}
      logicalAgentNames={{ reviewer: "Reviewer", builder: "Builder" }}
      logicalAgentImages={{ reviewer: profileImage }}
      agentDisplayNames={{ claude: "Builder" }} />)}
  </DialogProvider>);

  expect(screen.getByText("Reviewer")).toBeTruthy();
  expect(container.querySelector(".rail-node-agent img")?.getAttribute("src")).toBe(profileImage);
});
