import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ComputerTokenDrawer } from "../src/components/computer/ComputerTokenDrawer";
import { revealComputerToken, reissueComputerToken } from "../src/api";
import type { ControlPanelDaemonNodeRecord } from "../src/types";

vi.mock("../src/api", () => ({ revealComputerToken: vi.fn(), reissueComputerToken: vi.fn(), RelayApiError: class extends Error {} }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: async () => true }) }));
const node = { id: "local-1", nodeLocation: "employee-device", sandboxMode: "none" } as ControlPanelDaemonNodeRecord;
const credentials = {
  nodeToken: "fixture-token", daemonEnv: {}, daemonCommand: "legacy-daemon-command",
  installCommand: "curl -fsSL https://relay.example/install.sh | sudo bash -s -- --sandbox-id local-1",
};
beforeEach(() => { vi.mocked(revealComputerToken).mockReset(); vi.mocked(reissueComputerToken).mockReset(); });

it("reissues a token without offering recovery of stored secrets", async () => {
  vi.mocked(reissueComputerToken).mockResolvedValue(credentials);
  render(<ComputerTokenDrawer open node={node} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "computer.token_reveal_action" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "computer.token_reissue_action" }));
  expect(await screen.findByText(credentials.installCommand)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "computer.token_reveal_action" })).toBeNull();
  expect(revealComputerToken).not.toHaveBeenCalled();
  expect(screen.queryByText(credentials.daemonCommand)).toBeNull();
  expect(screen.getByText("computer.connect_token_prompt")).toBeTruthy();
});

it("uses the installer returned after reissuing a token", async () => {
  vi.mocked(reissueComputerToken).mockResolvedValue(credentials);
  vi.mocked(reissueComputerToken).mockResolvedValue({ ...credentials, nodeToken: "replacement-token" });
  render(<ComputerTokenDrawer open node={node} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "computer.token_reveal_action" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "computer.token_reissue_action" }));
  await screen.findByText("replacement-token");
  expect(screen.getByText(credentials.installCommand)).toBeTruthy();
  expect(screen.queryByText(credentials.daemonCommand)).toBeNull();
});

it("keeps the daemon command for BoxLite computers without an installer", async () => {
  vi.mocked(reissueComputerToken).mockResolvedValue({ nodeToken: "fixture-token", daemonEnv: {}, daemonCommand: "boxlite-command" });
  render(<ComputerTokenDrawer open node={{ ...node, sandboxMode: "boxlite", nodeLocation: "cloud" }} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "computer.token_reveal_action" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "computer.token_reissue_action" }));
  expect(await screen.findByText("boxlite-command")).toBeTruthy();
  expect(screen.getByText("admin.daemon_command_hint")).toBeTruthy();
});
