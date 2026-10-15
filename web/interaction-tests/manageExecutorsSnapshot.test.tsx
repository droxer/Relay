import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ManageExecutorsDrawer } from "../src/components/admin/ManageExecutorsDrawer";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { AgentName, ControlPanelDaemonNodeRecord } from "../src/types";

vi.mock("@/components/ui/Drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
}));
vi.mock("../src/components/admin/ManageAgentRow", () => ({
  ManageAgentRow: ({ agent, enabled, savedEnabled, onToggle }: {
    agent: AgentName; enabled: boolean; savedEnabled: boolean; onToggle: (agent: AgentName) => void;
  }) => (
    <li>
      <input
        type="checkbox"
        aria-label={agent}
        data-saved={String(savedEnabled)}
        checked={enabled}
        onChange={() => onToggle(agent)}
      />
    </li>
  ),
}));

function node(disabledAgents?: AgentName[]): ControlPanelDaemonNodeRecord {
  return {
    id: "node-1",
    agents: { claude: "ready", codex: "ready" },
    ...(disabledAgents ? { disabledAgents } : {}),
  } as unknown as ControlPanelDaemonNodeRecord;
}

function drawer(target: ControlPanelDaemonNodeRecord | null) {
  return (
    <DialogProvider>
      <ManageExecutorsDrawer
        open
        onClose={() => {}}
        node={target}
        onUpdated={() => {}}
        onSave={async () => ({ node: node() })}
      />
    </DialogProvider>
  );
}

const box = (agent: AgentName) => screen.getByRole("checkbox", { name: agent }) as HTMLInputElement;

describe("ManageExecutorsDrawer snapshot", () => {
  it("captures disabledAgents that arrive after the drawer opened", () => {
    const { rerender } = render(drawer(node()));
    expect(box("codex").checked).toBe(true);
    rerender(drawer(node(["codex"])));
    expect(box("codex").checked).toBe(false);
    expect(box("codex").dataset.saved).toBe("false");
  });

  it("keeps edits made before the saved state arrived", () => {
    const { rerender } = render(drawer(node()));
    fireEvent.click(box("claude"));
    rerender(drawer(node(["codex"])));
    expect(box("claude").checked).toBe(false);
    expect(box("codex").checked).toBe(false);
    expect(box("codex").dataset.saved).toBe("false");
  });

  it("does not wipe pending toggles when the poll replaces the node", () => {
    const { rerender } = render(drawer(node(["codex"])));
    fireEvent.click(box("claude"));
    rerender(drawer(node(["codex"])));
    rerender(drawer(node([])));
    expect(box("claude").checked).toBe(false);
    expect(box("codex").checked).toBe(false);
  });
});
