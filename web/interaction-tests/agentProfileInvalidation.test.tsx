import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AgentProfilePanel } from "../src/components/AgentProfilePanel";
import { updateOwnUserAgent } from "../src/api";
import type { UserAgent } from "../src/types";

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  updateOwnUserAgent: vi.fn(),
}));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/LazyMarkdown", () => ({ Markdown: () => null }));

it("refreshes only the agent, admin agent, and team lists after a profile edit", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const agent = { id: "a", displayName: "Ada", instructions: "Build things", enabled: true, executorKind: "codex", placements: [] } as unknown as UserAgent;
  vi.mocked(updateOwnUserAgent).mockResolvedValue({ agent: { ...agent, displayName: "Ada Two" } } as never);
  const client = new QueryClient();
  const keys = {
    userAgents: ["user-agents", "u1"],
    adminAgents: ["admin", "agents"],
    teams: ["teams", "u1"],
    tasks: ["relay", "tasks"],
    sessions: ["relay", "sessions"],
    adminUsers: ["admin", "users"],
  } as const;
  for (const key of Object.values(keys)) client.setQueryData(key, { seeded: true });
  render(<QueryClientProvider client={client}><AgentProfilePanel agent={agent} canEditMeta /></QueryClientProvider>);

  fireEvent.click(screen.getByRole("button", { name: "agents_page.edit_profile" }));
  fireEvent.change(screen.getByRole("textbox", { name: "admin.v2.agent_name" }), { target: { value: "Ada Two" } });
  fireEvent.click(screen.getByRole("button", { name: "agents_page.save_profile" }));

  await waitFor(() => expect(updateOwnUserAgent).toHaveBeenCalled());
  const invalidated = (key: readonly string[]) => client.getQueryState(key)?.isInvalidated;
  await waitFor(() => expect(invalidated(keys.userAgents)).toBe(true));
  expect(invalidated(keys.adminAgents)).toBe(true);
  expect(invalidated(keys.teams)).toBe(true);
  expect(invalidated(keys.tasks)).toBe(false);
  expect(invalidated(keys.sessions)).toBe(false);
  expect(invalidated(keys.adminUsers)).toBe(false);
  client.clear();
});
