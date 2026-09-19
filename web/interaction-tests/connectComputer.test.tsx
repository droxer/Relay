import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import zhTW from "../src/i18n/locales/zh-TW/translation.json";
import { ConnectComputerDrawer } from "../src/components/computer/ConnectComputerDrawer";
import { createLocalDeviceEnrollment } from "../src/api";

vi.mock("../src/api", () => ({ createLocalDeviceEnrollment: vi.fn() }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string) => key.split(".").reduce<any>((value, part) => value?.[part], en) ?? key,
}) }));

beforeEach(() => { vi.mocked(createLocalDeviceEnrollment).mockReset(); });

it("explains installation before generating a command", () => {
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Get install command" })).toBeTruthy();
  expect(screen.getByText(/No Git or npm required/)).toBeTruthy();
});

it("guides command and token steps without claiming registration means connected", async () => {
  vi.mocked(createLocalDeviceEnrollment).mockResolvedValue({
    node: { id: "computer-1" }, daemonEnv: {}, reused: true, nodeToken: "fixture-token",
    installCommand: "curl -fsSL https://relay.example/computer/install.sh | sh -s -- --sandbox-id computer-1",
    daemonCommand: "old-daemon-command",
  } as Awaited<ReturnType<typeof createLocalDeviceEnrollment>>);
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
  fireEvent.change(document.querySelector('[name="connect-computer-workspace-path"]')!, { target: { value: "/Users/alice/project" } });
  fireEvent.submit(document.querySelector("form")!);
  await waitFor(() => expect(screen.getByText(/curl -fsSL/)).toBeTruthy());
  expect(screen.getByRole("heading", { name: "Run the install command" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Paste your node token" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Waiting for connection");
  expect(screen.queryByText(/already connected/)).toBeNull();
  expect(screen.queryByText("old-daemon-command")).toBeNull();
});

it("does not retain the repository-install instructions in Traditional Chinese", () => {
  expect(zhTW.computer.connect_setup_hint).not.toMatch(/relay-client|export PATH|儲存庫存取/);
});

it("only reports connected after a fresh online status and copies the installer separately from the token", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const response = {
    node: { id: "computer-1", online: true }, daemonEnv: {}, nodeToken: "fixture-token",
    installCommand: "curl -fsSL https://relay.example/computer/install.sh | sh",
  } as Awaited<ReturnType<typeof createLocalDeviceEnrollment>>;
  vi.mocked(createLocalDeviceEnrollment).mockResolvedValue(response);
  const props = { open: true, onClose: vi.fn(), onConnected: vi.fn() };
  const view = render(<ConnectComputerDrawer {...props} />);
  fireEvent.change(document.querySelector('[name="connect-computer-workspace-path"]')!, { target: { value: "/tmp/project" } });
  fireEvent.submit(document.querySelector("form")!);
  await screen.findByRole("heading", { name: "Run the install command" });
  expect(screen.getByRole("status").textContent).toContain("Waiting for connection");
  fireEvent.click(within(screen.getByRole("region", { name: "Run the install command" })).getByRole("button"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(response.installCommand));
  fireEvent.click(within(screen.getByRole("region", { name: "Paste your node token" })).getByRole("button"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("fixture-token"));
  view.rerender(<ConnectComputerDrawer {...props} nodes={[{ ...response.node, online: true, stale: false }]} />);
  expect(screen.getByRole("status").textContent).toContain("Computer connected");
  view.rerender(<ConnectComputerDrawer {...props} nodes={[{ ...response.node, online: true, stale: true }]} />);
  expect(screen.getByRole("status").textContent).toContain("Waiting for connection");
});

it("rejects unsupported Windows paths before registering a computer", () => {
  render(<ConnectComputerDrawer open onClose={vi.fn()} onConnected={vi.fn()} />);
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
  fireEvent.change(document.querySelector('[name="connect-computer-workspace-path"]')!, { target: { value: "/tmp/project" } });
  fireEvent.submit(document.querySelector("form")!);
  expect(await screen.findByText(en.computer.connect_legacy_hint)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Run the install command" })).toBeNull();
  expect(screen.getByText(en.computer.connect_token_on_device)).toBeTruthy();
});
