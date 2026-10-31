import { createContext, useContext, type ReactNode } from "react";
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
/* base-ui's Select portals and animates in jsdom; a context stand-in keeps
   every option on the page and clickable. */
vi.mock("@/components/ui/select", () => {
  type Choice = { value: unknown; onValueChange?: (value: unknown) => void };
  const SelectContext = createContext<Choice>({ value: undefined });
  return {
    Select: ({ value, onValueChange, children }: Choice & { children: ReactNode }) =>
      <SelectContext.Provider value={{ value, onValueChange }}>{children}</SelectContext.Provider>,
    SelectTrigger: ({ children, ...rest }: { children: ReactNode; "aria-labelledby"?: string }) =>
      <div role="combobox" aria-labelledby={rest["aria-labelledby"]}>{children}</div>,
    SelectValue: ({ children }: { children?: ReactNode | ((value: unknown) => ReactNode) }) => {
      const { value } = useContext(SelectContext);
      return <span>{typeof children === "function" ? children(value) : String(value)}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: unknown; children: ReactNode }) => {
      const choice = useContext(SelectContext);
      return <button type="button" role="option" aria-selected={choice.value === value}
        onClick={() => choice.onValueChange?.(value)}>{children}</button>;
    },
  };
});

it("saves the agent's own role with the rest of the profile form", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const agent = { id: "r", displayName: "Rue", instructions: "Check things", enabled: true, executorKind: "codex", defaultRole: "implementer", placements: [] } as unknown as UserAgent;
  vi.mocked(updateOwnUserAgent).mockResolvedValue({ agent: { ...agent, defaultRole: "reviewer" } } as never);
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><AgentProfilePanel agent={agent} canEditMeta /></QueryClientProvider>);

  // Read view: the role is printed, not a control.
  expect(screen.queryByRole("combobox", { name: "admin.v2.agent_role_label" })).toBeNull();
  expect(screen.getByText("admin.v2.agent_role.implementer")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "agents_page.edit_profile" }));
  expect(screen.getByRole("combobox", { name: "admin.v2.agent_role_label" })).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: "admin.v2.agent_role.reviewer" }));
  // Picking a role is a draft like every other field; nothing saves until Save.
  expect(updateOwnUserAgent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "agents_page.save_profile" }));

  await waitFor(() => expect(updateOwnUserAgent).toHaveBeenCalledWith("r", { defaultRole: "reviewer" }));
  client.clear();
});
