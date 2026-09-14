import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ShareSkillDrawer } from "../src/components/ShareSkillDrawer";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: any) => ({ "skills.share_managed": "Share managed skill", "skills.close": "Close", "skills.share_delivery_note": "Assignments are resolved on every run.", "skills.employee_scope": "Employee", "skills.all_current_future_agents": "All current and future agents", "skills.teams": "Teams", "skills.agents": "Agents", "skills.granted": "Granted", "skills.revoke": "Revoke", "skills.cancel": "Cancel", "skills.sharing": "Sharing…", "skills.share_with_count": `Share with ${options?.count}`, "skills.member_count": `${options?.count} members` }[key] ?? key) }) }));

const { assignSkill, revokeSkillAssignment } = vi.hoisted(() => ({
  assignSkill: vi.fn(async () => ({})),
  revokeSkillAssignment: vi.fn(async () => undefined),
}));
vi.mock("../src/api", async (original) => ({ ...(await original<Record<string, unknown>>()), assignSkill, revokeSkillAssignment }));

const skill = {
  id: "skill-1", ownerEmployeeId: "employee-1", namespace: "relay", name: "release", slug: "relay/release",
  displayName: "Release notes", description: "Draft release notes", visibility: "private" as const, source: "authored" as const,
  currentRevisionId: "revision-1", stableRevisionId: "revision-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  grantedAgentIds: [], assignments: [{ id: "assignment-1", skillId: "skill-1", targetType: "agent" as const, targetId: "agent-1", mode: "optional" as const, pin: "stable" as const, invocation: "implicit" as const, createdByEmployeeId: "employee-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], files: [], revisions: [],
};
const agents = [
  { id: "agent-1", displayName: "Claude editor", executorKind: "claude", enabled: true },
  { id: "agent-2", displayName: "Codex reviewer", executorKind: "codex", enabled: true },
] as any;
const teams = [{ id: "team-1", name: "Launch team", memberAgentIds: ["agent-1", "agent-2"] }] as any;
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>; }

it("assigns a team scope without expanding it into agent grants", async () => {
  const user = userEvent.setup();
  render(<ShareSkillDrawer skill={skill} agents={agents} teams={teams} employeeId="employee-1" onClose={vi.fn()} />, { wrapper });
  await user.click(screen.getByRole("button", { name: "Launch team · 2 members" }));
  await user.click(screen.getByRole("button", { name: "Share with 1" }));
  expect(assignSkill).toHaveBeenCalledWith("skill-1", { targetType: "team", targetId: "team-1", mode: "optional", pin: "stable", invocation: "implicit" });
});

it("revokes a managed assignment inline and explains dynamic delivery", async () => {
  const user = userEvent.setup();
  render(<ShareSkillDrawer skill={skill} agents={agents} teams={teams} employeeId="employee-1" onClose={vi.fn()} />, { wrapper });
  expect(screen.getByText(/every run/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  expect(revokeSkillAssignment).toHaveBeenCalledWith("skill-1", "assignment-1");
});
