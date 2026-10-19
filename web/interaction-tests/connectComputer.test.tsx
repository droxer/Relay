import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import zhCN from "../src/i18n/locales/zh-CN/translation.json";
import { ConnectComputerDrawer } from "../src/components/computer/ConnectComputerDrawer";
import { createLocalDeviceEnrollment } from "../src/api";

vi.mock("../src/api", () => ({ createLocalDeviceEnrollment: vi.fn(), getComputerSetupCommand: vi.fn().mockResolvedValue({ installCommand: "setup-command", windowsInstallCommand: "irm 'https://relay.example/install.ps1' | iex" }) }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, values?: Record<string, string>) =>
    String(key.split(".").reduce<any>((value, part) => value?.[part], en) ?? key)
      .replace(/\{\{(\w+)\}\}/g, (_, name: string) => values?.[name] ?? ""),
}) }));

beforeEach(() => { vi.mocked(createLocalDeviceEnrollment).mockReset(); });

it("shows only the selected operating system's install command", async () => {
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByText("setup-command")).toBeTruthy();
  expect(screen.getByText("Install command · macOS")).toBeTruthy();
  expect(screen.queryByText("irm 'https://relay.example/install.ps1' | iex")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
  expect(screen.getByText("irm 'https://relay.example/install.ps1' | iex")).toBeTruthy();
  expect(screen.getByText("Install command · Windows")).toBeTruthy();
  expect(screen.getByText(/^Supported · x64 \/ ARM64 · Requires Git for Windows$/)).toBeTruthy();
  expect(screen.queryByText("setup-command")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Linux" }));
  expect(screen.getByText("Install command · Linux")).toBeTruthy();
  expect(screen.getByText("setup-command")).toBeTruthy();
});

it("shows the cloud computer as coming soon, not as a choice", () => {
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  const cloud = screen.getByRole("radio", { name: /Cloud computer/ });
  expect(cloud.getAttribute("aria-disabled") ?? cloud.hasAttribute("disabled").toString()).toBe("true");
  expect(within(cloud).getByText("Coming soon")).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Your computer/ }).getAttribute("aria-checked")).toBe("true");
});

it("explains installation before generating a command", () => {
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manual setup with a computer token" }));
  expect(screen.getByRole("button", { name: "Generate install command" })).toBeTruthy();
  expect(screen.getByText(/No npm or admin rights needed/)).toBeTruthy();
});

it("guides command and token steps without claiming registration means connected", async () => {
  vi.mocked(createLocalDeviceEnrollment).mockResolvedValue({
    node: { id: "computer-1" }, daemonEnv: {}, reused: true, nodeToken: "fixture-token",
    installCommand: "curl -fsSL https://relay.example/install.sh | bash -s -- --sandbox-id computer-1",
    windowsInstallCommand: "& ([scriptblock]::Create((irm 'https://relay.example/install.ps1'))) '--sandbox-id' 'computer-1'",
    daemonCommand: "old-daemon-command",
  } as Awaited<ReturnType<typeof createLocalDeviceEnrollment>>);
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manual setup with a computer token" }));
  fireEvent.change(document.querySelector('[name="connect-computer-workspace-path"]')!, { target: { value: "/Users/alice/project" } });
  fireEvent.submit(document.querySelector("form")!);
  await waitFor(() => expect(screen.getByText(/curl -fsSL/)).toBeTruthy());
  expect(screen.getByRole("heading", { name: "Run the install command" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Enter your computer token" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Waiting for connection");
  expect(screen.queryByText(/already connected/)).toBeNull();
  expect(screen.queryByText("old-daemon-command")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
  expect(screen.getByText("Install command · Windows")).toBeTruthy();
  expect(screen.getByText(/\[scriptblock\]::Create/)).toBeTruthy();
});

it("does not retain the repository-install instructions in Simplified Chinese", () => {
  expect(zhCN.computer.os_shell_hint_linux + zhCN.computer.connect_requirements).not.toMatch(/relay-client|export PATH|仓库访问|存储库访问/);
});

it("only reports connected after a fresh online status and copies the installer separately from the token", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const response = {
    node: { id: "computer-1", online: true }, daemonEnv: {}, nodeToken: "fixture-token",
    installCommand: "curl -fsSL https://relay.example/install.sh | bash",
  } as Awaited<ReturnType<typeof createLocalDeviceEnrollment>>;
  vi.mocked(createLocalDeviceEnrollment).mockResolvedValue(response);
  const props = { open: true, onClose: vi.fn(), onConnected: vi.fn() };
  const view = render(<ConnectComputerDrawer {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Manual setup with a computer token" }));
  fireEvent.change(document.querySelector('[name="connect-computer-workspace-path"]')!, { target: { value: "/tmp/project" } });
  fireEvent.submit(document.querySelector("form")!);
  await screen.findByRole("heading", { name: "Run the install command" });
  expect(screen.getByRole("status").textContent).toContain("Waiting for connection");
  fireEvent.click(within(screen.getByRole("region", { name: "Run the install command" })).getByRole("button"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(response.installCommand));
  fireEvent.click(within(screen.getByRole("region", { name: "Enter your computer token" })).getByRole("button"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("fixture-token"));
  view.rerender(<ConnectComputerDrawer {...props} nodes={[{ ...response.node, online: true, stale: false }]} />);
  expect(screen.getByRole("status").textContent).toContain("Computer connected");
  view.rerender(<ConnectComputerDrawer {...props} nodes={[{ ...response.node, online: true, stale: true }]} />);
  expect(screen.getByRole("status").textContent).toContain("Waiting for connection");
});

it("rejects unsupported Windows paths before registering a computer", () => {
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manual setup with a computer token" }));
  fireEvent.change(document.querySelector('[name="connect-computer-workspace-path"]')!, { target: { value: "C:\\Users\\alice" } });
  fireEvent.submit(document.querySelector("form")!);
  expect(createLocalDeviceEnrollment).not.toHaveBeenCalled();
  expect(screen.getByText(en.computer.connect_workspace_path_error)).toBeTruthy();
});

it("explains when an older backend only returns a manual command", async () => {
  vi.mocked(createLocalDeviceEnrollment).mockResolvedValue({
    node: { id: "computer-1" }, daemonEnv: {}, daemonCommand: "relay-daemon --sandbox none",
  } as Awaited<ReturnType<typeof createLocalDeviceEnrollment>>);
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Manual setup with a computer token" }));
  fireEvent.change(document.querySelector('[name="connect-computer-workspace-path"]')!, { target: { value: "/tmp/project" } });
  fireEvent.submit(document.querySelector("form")!);
  expect(await screen.findByText(en.computer.connect_legacy_hint)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Run the install command" })).toBeNull();
  expect(screen.getByText(en.computer.connect_token_on_device)).toBeTruthy();
});
