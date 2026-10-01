import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AgentProfilePanel } from "../src/components/AgentProfilePanel";
import type { EmployeeAgent } from "../src/types";

vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/LazyMarkdown", () => ({ Markdown: () => null }));

it("reports dirty changes from edit events and clears them on cancel", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const onDirtyChange = vi.fn();
  const agent = { id: "a", displayName: "Ada", instructions: "Build things", enabled: true, executorKind: "codex", placements: [] } as unknown as EmployeeAgent;
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><AgentProfilePanel agent={agent} canEditMeta onDirtyChange={onDirtyChange} /></QueryClientProvider>);
  expect(onDirtyChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "agents_page.edit_profile" }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole("textbox", { name: "admin.v2.agent_name" }), { target: { value: "Ada changed" } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.change(screen.getByRole("textbox", { name: "admin.v2.agent_name" }), { target: { value: "Ada" } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole("textbox", { name: "admin.v2.agent_name" }), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "admin.v2.cancel" }));
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});
