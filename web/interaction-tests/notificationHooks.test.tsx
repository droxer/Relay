import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useNotifications, useNotificationPreferences } from "../src/hooks/useNotifications";
import { clearNotifications, listNotifications, getNotificationPreferences, updateNotificationPreferences } from "../src/api";
import { NotificationsSection } from "../src/components/settings/NotificationsSection";

const auth = vi.hoisted(() => ({ user: { id: "account-a" } as { id: string } | null }));
vi.mock("../src/hooks/useAuthSession", () => ({ useAuthSession: () => auth }));
vi.mock("../src/hooks/useMutationError", () => ({ useMutationError: () => ({ reportMutationError: vi.fn() }) }));
vi.mock("../src/api", () => ({
  NOTIFICATION_KINDS: ["task_completed", "computer_status", "client_outdated"],
  listNotifications: vi.fn(), getNotificationPreferences: vi.fn(),
  markNotificationsRead: vi.fn(), clearNotifications: vi.fn(), updateNotificationPreferences: vi.fn(),
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  auth.user = { id: "account-a" };
  vi.mocked(listNotifications).mockReset().mockResolvedValue({ notifications: [{
    id: "private-notice", kind: "task_completed", data: { taskId: "private-task", title: "Private task", status: "done" },
    createdAt: "2026-10-16T09:00:00Z", readAt: null,
  }], unreadCount: 1 });
  vi.mocked(getNotificationPreferences).mockReset().mockResolvedValue({ mutedKinds: ["task_completed"], kinds: ["task_completed", "computer_status"] });
  vi.mocked(updateNotificationPreferences).mockReset();
});

it("never shows another account's cached inbox or preferences while the new fetch fails", async () => {
  const { client, wrapper } = setup();
  const hook = () => ({ inbox: useNotifications({ enabled: true, onOpen: vi.fn() }), prefs: useNotificationPreferences() });
  const first = renderHook(hook, { wrapper });
  await waitFor(() => expect(first.result.current.inbox.notices).toHaveLength(1));
  await waitFor(() => expect(first.result.current.prefs.preferences?.mutedKinds).toEqual(["task_completed"]));
  first.unmount();
  auth.user = { id: "account-b" };
  vi.mocked(listNotifications).mockRejectedValue(new Error("offline"));
  vi.mocked(getNotificationPreferences).mockRejectedValue(new Error("offline"));
  const second = renderHook(hook, { wrapper });
  expect(second.result.current.inbox.notices).toEqual([]);
  expect(second.result.current.prefs.preferences).toBeUndefined();
  await waitFor(() => expect(second.result.current.inbox.isError).toBe(true));
  expect(second.result.current.inbox.notices).toEqual([]);
  expect(second.result.current.prefs.preferences).toBeUndefined();
  second.unmount(); client.clear();
});

it("removes a dismissed notice at once and restores it when the clear fails", async () => {
  const { client, wrapper } = setup();
  let fail!: (error: Error) => void;
  vi.mocked(clearNotifications).mockReset().mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = renderHook(() => useNotifications({ enabled: true, onOpen: vi.fn() }), { wrapper });
  await waitFor(() => expect(view.result.current.notices).toHaveLength(1));
  act(() => view.result.current.dismiss(view.result.current.notices[0]));
  await waitFor(() => expect(view.result.current.notices).toEqual([]));
  expect(view.result.current.unreadCount).toBe(0);
  expect(clearNotifications).toHaveBeenCalledWith(["private-notice"]);
  await act(async () => { fail(new Error("offline")); });
  await waitFor(() => expect(view.result.current.notices).toHaveLength(1));
  expect(view.result.current.unreadCount).toBe(1);
  view.unmount(); client.clear();
});

it("clears the whole inbox", async () => {
  const { client, wrapper } = setup();
  vi.mocked(clearNotifications).mockReset().mockResolvedValue({ unreadCount: 0 });
  const view = renderHook(() => useNotifications({ enabled: true, onOpen: vi.fn() }), { wrapper });
  await waitFor(() => expect(view.result.current.notices).toHaveLength(1));
  vi.mocked(listNotifications).mockResolvedValue({ notifications: [], unreadCount: 0 });
  act(() => view.result.current.clearAll());
  await waitFor(() => expect(view.result.current.notices).toEqual([]));
  expect(clearNotifications).toHaveBeenCalledWith("all");
  expect(view.result.current.unreadCount).toBe(0);
  view.unmount(); client.clear();
});

it("blocks overlapping preference saves, then allows the next change using saved preferences", async () => {
  const { client, wrapper } = setup();
  let finish!: (value: { mutedKinds: string[]; kinds: string[] }) => void;
  vi.mocked(updateNotificationPreferences).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = renderHook(() => useNotificationPreferences(), { wrapper });
  await waitFor(() => expect(view.result.current.preferences).toBeDefined());
  act(() => {
    view.result.current.setKindEnabled("computer_status", false);
    view.result.current.setKindEnabled("task_completed", true);
  });
  await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(1));
  expect(view.result.current.isSaving).toBe(true);
  expect(updateNotificationPreferences).toHaveBeenLastCalledWith(["task_completed", "computer_status"]);
  await act(async () => { finish({ mutedKinds: ["task_completed", "computer_status"], kinds: ["task_completed", "computer_status"] }); });
  await waitFor(() => expect(view.result.current.isSaving).toBe(false));
  act(() => view.result.current.setKindEnabled("task_completed", true));
  await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(2));
  expect(updateNotificationPreferences).toHaveBeenLastCalledWith(["computer_status"]);
  await act(async () => { finish({ mutedKinds: ["computer_status"], kinds: ["task_completed", "computer_status"] }); });
  view.unmount(); client.clear();
});

it("keeps preference switches locked across settings remounts until the save settles", async () => {
  const { client, wrapper } = setup();
  let finish!: (value: { mutedKinds: string[]; kinds: string[] }) => void;
  vi.mocked(updateNotificationPreferences).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const first = renderHook(() => useNotificationPreferences(), { wrapper });
  await waitFor(() => expect(first.result.current.preferences).toBeDefined());
  act(() => first.result.current.setKindEnabled("computer_status", false));
  await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = renderHook(() => useNotificationPreferences(), { wrapper });
  expect(second.result.current.isSaving).toBe(true);
  act(() => second.result.current.setKindEnabled("task_completed", true));
  await act(async () => { finish({ mutedKinds: ["task_completed", "computer_status"], kinds: ["task_completed", "computer_status"] }); });
  await waitFor(() => expect(second.result.current.isSaving).toBe(false));
  expect(updateNotificationPreferences).toHaveBeenCalledTimes(1);
  second.unmount(); client.clear();
});

it("rolls back a failed save and unlocks switches for a retry", async () => {
  const { client, wrapper } = setup();
  vi.mocked(updateNotificationPreferences).mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ mutedKinds: ["task_completed", "computer_status"], kinds: ["task_completed", "computer_status"] });
  const view = renderHook(() => useNotificationPreferences(), { wrapper });
  await waitFor(() => expect(view.result.current.preferences).toBeDefined());
  act(() => view.result.current.setKindEnabled("computer_status", false));
  await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.result.current.isSaving).toBe(false));
  expect(view.result.current.preferences?.mutedKinds).toEqual(["task_completed"]);
  act(() => view.result.current.setKindEnabled("computer_status", false));
  await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.result.current.preferences?.mutedKinds).toEqual(["task_completed", "computer_status"]));
  view.unmount(); client.clear();
});

it("disables kind switches in the settings UI while a save is pending", async () => {
  const { client, wrapper } = setup();
  let finish!: (value: { mutedKinds: string[]; kinds: string[] }) => void;
  vi.mocked(updateNotificationPreferences).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<NotificationsSection />, { wrapper });
  const taskSwitch = await screen.findByRole("switch", { name: "notifications.kind.task_completed" });
  const computerSwitch = screen.getByRole("switch", { name: "notifications.kind.computer_status" });
  fireEvent.click(computerSwitch);
  await waitFor(() => expect(taskSwitch.getAttribute("aria-disabled")).toBe("true"));
  expect(computerSwitch.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(taskSwitch);
  expect(updateNotificationPreferences).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ mutedKinds: ["task_completed", "computer_status"], kinds: ["task_completed", "computer_status"] }); });
  await waitFor(() => expect(taskSwitch.getAttribute("aria-disabled")).not.toBe("true"));
  view.unmount(); client.clear();
});

it("keeps a previous account's pending save response out of the current account's cache", async () => {
  const { client, wrapper } = setup();
  let finish!: (value: { mutedKinds: string[]; kinds: string[] }) => void;
  vi.mocked(updateNotificationPreferences).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = renderHook(() => useNotificationPreferences(), { wrapper });
  await waitFor(() => expect(view.result.current.preferences).toBeDefined());
  act(() => view.result.current.setKindEnabled("computer_status", false));
  await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(1));
  auth.user = { id: "account-b" };
  vi.mocked(getNotificationPreferences).mockResolvedValue({ mutedKinds: [], kinds: ["task_completed", "computer_status"] });
  view.rerender();
  await waitFor(() => expect(view.result.current.preferences?.mutedKinds).toEqual([]));
  expect(view.result.current.isSaving).toBe(false);
  await act(async () => { finish({ mutedKinds: ["task_completed", "computer_status"], kinds: ["task_completed", "computer_status"] }); });
  expect(view.result.current.preferences?.mutedKinds).toEqual([]);
  view.unmount(); client.clear();
});
