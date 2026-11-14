import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AgentSkillsPanel } from "../src/components/AgentSkillsPanel";
import type { UserAgent } from "../src/types";

const { revokeSkill, revokeSkillAssignment } = vi.hoisted(() => ({
  revokeSkill: vi.fn(async () => undefined),
  revokeSkillAssignment: vi.fn(async () => undefined),
}));
vi.mock("../src/api", async (original) => ({
  ...(await original<Record<string, unknown>>()), revokeSkill, revokeSkillAssignment,
}));

it("shows inherited skills and revokes direct assignments through their own API", async () => {
  const user = userEvent.setup();
  const agent = {
    id: "agent-1", skills: [
      { source: "catalog", skillId: "inherited", name: "inherited", assignmentId: "user-assignment", inherited: true },
      { source: "catalog", skillId: "assigned", name: "assigned", assignmentId: "agent-assignment", inherited: false },
      { source: "catalog", skillId: "legacy", name: "legacy" },
    ],
  } as UserAgent;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentSkillsPanel agent={agent} canEdit />
    </QueryClientProvider>,
  );
  const inherited = screen.getByRole("button", { name: "inherited" }).closest("li")!;
  expect(within(inherited).queryByRole("button", { name: "skills.revoke" })).toBeNull();
  const assigned = screen.getByRole("button", { name: "assigned" }).closest("li")!;
  await user.click(within(assigned).getByRole("button", { name: "skills.revoke" }));
  expect(revokeSkillAssignment).toHaveBeenCalledWith("assigned", "agent-assignment");
  expect(revokeSkill).not.toHaveBeenCalled();
  const legacy = screen.getByRole("button", { name: "legacy" }).closest("li")!;
  await user.click(within(legacy).getByRole("button", { name: "skills.revoke" }));
  expect(revokeSkill).toHaveBeenCalledWith("legacy", "agent-1");
});
