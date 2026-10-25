import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentProfilePanel } from "../src/components/AgentProfilePanel";
import { deleteOwnUserAgent, deleteUserAgent } from "../src/api";
import type { UserAgent } from "../src/types";

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api")>()),
  deleteOwnUserAgent: vi.fn(),
  deleteUserAgent: vi.fn(),
}));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../src/components/LazyMarkdown", () => ({ Markdown: () => null }));

const agent = { id: "a", displayName: "Fixer", instructions: "", enabled: true, executorKind: "codex", placements: [] } as unknown as UserAgent;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.mocked(deleteOwnUserAgent).mockReset().mockResolvedValue({ agent } as never);
  vi.mocked(deleteUserAgent).mockReset().mockResolvedValue({ agent } as never);
});

function renderPanel(props: { canManage?: boolean; canEditMeta?: boolean }, onAgentDeleted = vi.fn()) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <AgentProfilePanel agent={agent} {...props} onAgentDeleted={onAgentDeleted} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "admin.v2.delete_agent" }));
  return onAgentDeleted;
}

it("deletes an owner's agent through the owner route, not the admin one", async () => {
  const onAgentDeleted = renderPanel({ canEditMeta: true });

  await waitFor(() => expect(onAgentDeleted).toHaveBeenCalledWith("a"));
  expect(deleteOwnUserAgent).toHaveBeenCalledWith("a");
  expect(deleteUserAgent).not.toHaveBeenCalled();
});

it("keeps the admin route for an admin managing the agent", async () => {
  const onAgentDeleted = renderPanel({ canManage: true });

  await waitFor(() => expect(onAgentDeleted).toHaveBeenCalledWith("a"));
  expect(deleteUserAgent).toHaveBeenCalledWith("a");
  expect(deleteOwnUserAgent).not.toHaveBeenCalled();
});
