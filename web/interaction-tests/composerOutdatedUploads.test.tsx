import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { Composer } from "../src/components/composer/Composer";
import { uploadThreadImage } from "../src/api-client/sessions";
import type { DaemonNodeMonitorRecord } from "../src/types";
import { TooltipProvider } from "../src/components/ui/tooltip";

vi.mock("../src/api-client/sessions", () => ({ uploadThreadImage: vi.fn() }));

const node = (outdated?: boolean) => ({ id: "computer", name: "Computer", agents: {}, capabilities: ["image-attachments"], clientOutdated: outdated }) as DaemonNodeMonitorRecord;
function composer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  return (<TooltipProvider delay={0}><Composer
    logicalAgents={[]} activeLogicalAgentId={null} onLogicalAgentPicked={vi.fn()}
    activeAgentDisplayName="Codex" selectedUser="user" initializingThread={false}
    runtimeNodes={[]} runtimeNodeId="computer" selectedRuntimeNode={node(false)} activeRuntimeNode={node(false)}
    onRuntimeNodeChange={vi.fn()} running={false} onSend={vi.fn()} onCancelRun={vi.fn()}
    {...overrides}
  /></TooltipProvider>);
}

function setup(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  return render(composer(overrides));
}

it("disables upload for the Thread's outdated Computer and explains how to enable it", () => {
  const { container } = setup({ activeRuntimeNode: node(true) });
  expect((screen.getByRole("button", { name: "composer.attach_image" }) as HTMLButtonElement).disabled).toBe(true);
  expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
  const trigger = screen.getByRole("group", { name: "composer.attach_image" });
  expect(trigger.tabIndex).toBe(0);
  expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe("composer.upload_client_outdated");
});

it("blocks screenshot paste and file-change events while leaving text messages enabled", () => {
  vi.mocked(uploadThreadImage).mockClear();
  const { container } = setup({ activeRuntimeNode: node(true) });
  const image = new File(["png"], "screenshot.png", { type: "image/png" });
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [image] } });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [image] } });
  expect(uploadThreadImage).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Text still works" } });
  expect((screen.getByRole("button", { name: "composer.send" }) as HTMLButtonElement).disabled).toBe(false);
});

it("uses the selected Computer while composing a new Thread", () => {
  setup({ initializingThread: true, selectedRuntimeNode: node(true), activeRuntimeNode: node(false) });
  expect((screen.getByRole("button", { name: "composer.attach_image" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps upload enabled for a current client or an older backend without the outdated flag", () => {
  setup({ activeRuntimeNode: node() });
  expect((screen.getByRole("button", { name: "composer.attach_image" }) as HTMLButtonElement).disabled).toBe(false);
});

it("blocks an image draft after switching to an outdated Computer and enables it after updating", async () => {
  vi.stubGlobal("URL", { createObjectURL: () => "blob:preview", revokeObjectURL: vi.fn() });
  vi.mocked(uploadThreadImage).mockResolvedValue({ id: "image-1", mediaType: "image/png", bytes: 3, sha256: "a".repeat(64) });
  const props = { initializingThread: true, selectedRuntimeNode: node(false), activeRuntimeNode: node(true) };
  const { container, rerender } = setup(props);
  expect((screen.getByRole("button", { name: "composer.attach_image" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["png"], "image.png", { type: "image/png" })] } });
  await waitFor(() => expect(container.querySelector(".composer-images img")).toBeTruthy());
  rerender(composer({ ...props, selectedRuntimeNode: node(true) }));
  expect((screen.getByRole("button", { name: "composer.attach_image" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "composer.send" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(composer(props));
  expect((screen.getByRole("button", { name: "composer.send" }) as HTMLButtonElement).disabled).toBe(false);
});

it("removes an attached image and releases its preview URL", async () => {
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:preview", revokeObjectURL: revoke });
  vi.mocked(uploadThreadImage).mockResolvedValue({ id: "image-1", mediaType: "image/png", bytes: 3, sha256: "a".repeat(64) });
  const { container } = setup();
  fireEvent.click(screen.getByRole("button", { name: "composer.attach_image" }));
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["png"], "image.png", { type: "image/png" })] } });
  const remove = await screen.findByRole("button", { name: "composer.remove_image" });
  fireEvent.click(remove);
  expect(container.querySelector(".composer-images img")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:preview");
});
