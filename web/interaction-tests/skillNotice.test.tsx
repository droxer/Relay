import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MessageBlock } from "../src/components/MessageBlock";
import { projectMessages } from "../src/lib/projectMessages";

it("keeps a skipped-skills notice in stream order and renders it in the thread", () => {
  const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as any;
  const session = {
    id: "thread-1", taskGoal: "ship", createdAt: "2026-09-14T00:00:00Z", events: [
      { id: "user-1", type: "user.message", sessionId: "thread-1", timestamp: "2026-09-14T00:00:00Z", text: "ship" },
      { id: "notice-1", type: "system.notice", sessionId: "thread-1", timestamp: "2026-09-14T00:00:01Z", runId: "run-1", agent: "codex", text: "Two skills could not be delivered.", reason: "skills-skipped", skillsSkipped: [{ skillId: "skill-1", slug: "relay/release", reason: "daemon unsupported" }] },
    ], agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], status: "running",
  } as any;
  const messages = projectMessages(session, t);
  expect(messages.map((message) => message.id)).toEqual(["thread-1:goal", "user-1", "notice-1"]);
  render(<MessageBlock message={messages[2]} sessionId="thread-1" />);
  expect(screen.getByText("Two skills could not be delivered.")).toBeTruthy();
});
