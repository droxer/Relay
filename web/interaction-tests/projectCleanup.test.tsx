import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useRelayMutations } from "../src/hooks/useRelayMutations";
import { deleteProject } from "../src/api";
import en from "../src/i18n/locales/en/translation.json";

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("../src/api", () => ({ deleteProject: vi.fn(), RelayApiError: class extends Error {} }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce }) }));
vi.mock("../src/hooks/useMutationError", () => ({ useMutationError: () => ({ reportMutationError: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string) => key.split(".").reduce<any>((value, part) => value?.[part], en) ?? key,
}) }));

it.each(["queued", "waiting_for_upgrade"] as const)("clears deleted records and accurately reports %s cleanup", async (workspaceCleanup) => {
  announce.mockClear();
  const client = new QueryClient();
  const projects = ["relay", "projects"];
  const tasks = ["relay", "tasks"];
  const sessions = ["relay", "sessions"];
  client.setQueryData(projects, [{ id: "deleted" }, { id: "kept" }]);
  for (const key of [tasks, sessions]) client.setQueryData(key, [{ id: "owned", projectId: "deleted" }, { id: "other", projectId: "kept" }]);
  vi.mocked(deleteProject).mockResolvedValue({ deletedProjectId: "deleted", workspaceCleanup, cleanupCommandId: "cleanup" });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useRelayMutations(), { wrapper });
  await act(async () => { await view.result.current.deleteProjectMutation.mutateAsync({ projectId: "deleted", expectedVersion: 1 }); });
  expect(client.getQueryData(projects)).toEqual([{ id: "kept" }]);
  for (const key of [tasks, sessions]) expect(client.getQueryData(key)).toEqual([{ id: "other", projectId: "kept" }]);
  const message = announce.mock.calls[0][0];
  expect(message.tone).toBe(workspaceCleanup === "waiting_for_upgrade" ? "warn" : "info");
  expect(message.message).toContain(workspaceCleanup === "waiting_for_upgrade" ? "Update and reconnect Relay Computer" : "queued");
  view.unmount();
  client.clear();
});
