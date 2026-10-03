import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebhookSecretPanel } from "../src/components/task-board/WebhookSecretPanel";
import { rotateWebhookSecret, webhookSecretStatus } from "../src/api";

vi.mock("../src/api", () => ({
  RelayApiError: class extends Error {},
  webhookSecretStatus: vi.fn(), rotateWebhookSecret: vi.fn(),
}));

it("keeps the one-time secret out of caches and clears it after unmount", async () => {
  const info = { configured: true, path: "/api/v1/automations/R-1/webhook", header: "X-Relay-Automation-Token" };
  vi.mocked(webhookSecretStatus).mockResolvedValue(info);
  vi.mocked(rotateWebhookSecret).mockResolvedValue({ ...info, secret: "one-time-test-secret" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => <QueryClientProvider client={client}><WebhookSecretPanel taskId="R-1" /></QueryClientProvider>;
  const first = render(view());
  await waitFor(() => expect((screen.getByRole("button", { name: "automation.webhook_rotate" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "automation.webhook_rotate" }));
  expect(rotateWebhookSecret).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "automation.webhook_rotate_confirm" }));
  expect(await screen.findByText("one-time-test-secret")).toBeTruthy();
  expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain("one-time-test-secret");
  expect(client.getMutationCache().getAll()).toHaveLength(0);
  first.unmount();
  render(view());
  expect(screen.queryByText("one-time-test-secret")).toBeNull();
  client.clear();
});
