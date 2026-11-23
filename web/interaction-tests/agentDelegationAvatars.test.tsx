import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentDelegationSettings } from "../src/components/AgentDelegationSettings";
import { listUserAgents } from "../src/api";
import type { UserAgent } from "../src/types";

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  listUserAgents: vi.fn(),
}));

const base = { enabled: true, computerId: "c1", supervisorUserId: "u1", availability: "ready", executorKind: "codex", placements: [] };
const owner = { ...base, id: "self", displayName: "Self", delegationAgentIds: ["gone"] } as unknown as UserAgent;
const pictured = { ...base, id: "p", displayName: "Pictured", profileImageUrl: "/profile-images/p.png" } as unknown as UserAgent;
const plain = { ...base, id: "q", displayName: "Plain", profileImageUrl: null } as unknown as UserAgent;

beforeEach(() => {
  vi.mocked(listUserAgents).mockReset().mockResolvedValue({ agents: [owner, pictured, plain] } as never);
});

it("gives every delegation target an avatar, including one no longer eligible", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentDelegationSettings agent={owner} editable onChange={vi.fn()} />
    </QueryClientProvider>,
  );

  await screen.findByRole("checkbox", { name: "Pictured" });
  expect(screen.getByRole("checkbox", { name: "Plain" })).toBeTruthy();
  const rows = Array.from(document.querySelectorAll(".agent-delegation-option")).slice(1);
  expect(rows).toHaveLength(3);
  for (const row of rows) expect(row.querySelector(".agent-state .profile-image")).not.toBeNull();
  expect(rows[0].querySelector("img")?.getAttribute("src")).toBe("/profile-images/p.png");
  expect(rows[1].querySelector(".identity-mark")).not.toBeNull();
});
