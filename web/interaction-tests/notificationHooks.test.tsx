import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNotifications, useNotificationPreferences } from "../src/hooks/useNotifications";
import { markNotificationsRead, clearNotifications, getUnreadNotificationCount, listNotifications, getNotificationPreferences, updateNotificationPreferences } from "../src/api";
import { configurePersonalQueryCache } from "../src/lib/personalQueryCache";
import { NotificationsSection } from "../src/components/settings/NotificationsSection";
import { writeDesktopNotifications } from "../src/lib/appStorage";

const auth = vi.hoisted(() => ({ user: { id: "account-a" } as { id: string } | null }));
vi.mock("../src/hooks/useAuthSession", () => ({ useAuthSession: () => auth }));
vi.mock("../src/hooks/useMutationError", () => ({ useMutationError: () => ({ reportMutationError: vi.fn() }) }));
vi.mock("../src/api", () => ({
  NOTIFICATION_KINDS: ["task_completed", "computer_status", "client_outdated"],
  listNotifications: vi.fn(), getUnreadNotificationCount: vi.fn(), getNotificationPreferences: vi.fn(),
  markNotificationsRead: vi.fn(), clearNotifications: vi.fn(), updateNotificationPreferences: vi.fn(),
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

function useOpenInbox() {
  const inbox = useNotifications({ enabled: true, onOpen: vi.fn() });
  const { observeInbox } = inbox;
  useEffect(observeInbox, [observeInbox]);
  return inbox;
}

beforeEach(() => {
  auth.user = { id: "account-a" };
  writeDesktopNotifications(false);
  vi.mocked(getUnreadNotificationCount).mockReset().mockResolvedValue({ unreadCount: 1 });
  vi.mocked(listNotifications).mockReset().mockResolvedValue({ notifications: [{
    id: "private-notice", kind: "task_completed", data: { taskId: "private-task", title: "Private task", status: "done" },
    createdAt: "2026-10-16T09:00:00Z", readAt: null,
  }], unreadCount: 1 });
  vi.mocked(getNotificationPreferences).mockReset().mockResolvedValue({ mutedKinds: ["task_completed"], kinds: ["task_completed", "computer_status"] });
  vi.mocked(updateNotificationPreferences).mockReset();
});

afterEach(() => vi.unstubAllGlobals());

it("polls only the count until opening the inbox and uses its latest count after closing", async () => {
  const { client, wrapper } = setup();
  configurePersonalQueryCache(client);
  vi.mocked(getUnreadNotificationCount).mockResolvedValue({ unreadCount: 3 });
  const view = renderHook(() => useNotifications({ enabled: true, onOpen: vi.fn() }), { wrapper });
  await waitFor(() => expect(view.result.current.unreadCount).toBe(3));
  expect(listNotifications).not.toHaveBeenCalled();
  let close!: () => void;
  act(() => { close = view.result.current.observeInbox(); });
  await waitFor(() => expect(view.result.current.notices).toHaveLength(1));
  expect(view.result.current.unreadCount).toBe(1);
  act(close);
  expect(view.result.current.unreadCount).toBe(1);
  expect(getUnreadNotificationCount).toHaveBeenCalledOnce();
  expect(listNotifications).toHaveBeenCalledOnce();
  view.unmount(); client.clear();
});

it("keeps fetching detail for desktop notifications while the panel is closed", async () => {
  vi.stubGlobal("Notification", { permission: "granted" });
  writeDesktopNotifications(true);
  const { client, wrapper } = setup();
  const view = renderHook(() => useNotifications({ enabled: true, onOpen: vi.fn() }), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.notices).toHaveLength(1));
    const details = client.getQueryCache().find({ queryKey: ["relay", "notifications", "account-a"], exact: true });
    expect(details?.observers[0]?.options.refetchIntervalInBackground).toBe(true);
    expect(getUnreadNotificationCount).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    client.clear();
    writeDesktopNotifications(false);
  }
});

it("only counts notices when desktop permission is denied, and follows permission changes", async () => {
  const browserNotification = { permission: "denied" };
  vi.stubGlobal("Notification", browserNotification);
  writeDesktopNotifications(true);
  const { client, wrapper } = setup();
  const view = renderHook(() => useNotifications({ enabled: true, onOpen: vi.fn() }), { wrapper });
  try {
    await waitFor(() => expect(getUnreadNotificationCount).toHaveBeenCalledOnce());
    expect(listNotifications).not.toHaveBeenCalled();
    act(() => {
      browserNotification.permission = "granted";
      fireEvent.focus(window);
    });
    await waitFor(() => expect(listNotifications).toHaveBeenCalledOnce());
    act(() => {
      browserNotification.permission = "denied";
      fireEvent.focus(window);
    });
    const details = client.getQueryCache().find({ queryKey: ["relay", "notifications", "account-a"], exact: true });
    expect(details?.isActive()).toBe(false);
  } finally {
    view.unmount();
    client.clear();
  }
});

it("never shows another account's cached inbox or preferences while the new fetch fails", async () => {
  const { client, wrapper } = setup();
  const hook = () => ({ inbox: useOpenInbox(), prefs: useNotificationPreferences() });
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
  const view = renderHook(useOpenInbox, { wrapper });
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
  const view = renderHook(useOpenInbox, { wrapper });
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

it("lets a person retry failed notification preferences without reloading", async () => {
  const { client, wrapper } = setup();
  vi.mocked(getNotificationPreferences).mockRejectedValueOnce(new Error("offline"));
  render(<NotificationsSection />, { wrapper });
  await waitFor(() => expect(screen.getByText("notifications.prefs_load_failed")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "notifications.retry" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "notifications.kind.task_completed" })).toBeTruthy());
  client.clear();
});

it("does not let delayed read receipts restore an obsolete unread count", async () => {
  const {client,wrapper}=setup();
  const notifications=["a","b"].map(id=>({id,kind:"task_completed",data:{taskId:id,title:id,status:"done"},createdAt:"2026-11-10",readAt:null}));
  vi.mocked(listNotifications).mockResolvedValue({notifications,unreadCount:2} as never);
  let first!: (value:{unreadCount:number})=>void;
  vi.mocked(markNotificationsRead).mockReset().mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValueOnce({unreadCount:0});
  const view=renderHook(useOpenInbox,{wrapper});
  await waitFor(()=>expect(view.result.current.notices).toHaveLength(2));
  act(()=>view.result.current.open(view.result.current.notices[0]));
  await waitFor(()=>expect(markNotificationsRead).toHaveBeenCalledTimes(1));
  act(()=>view.result.current.open(view.result.current.notices[1]));
  await waitFor(()=>expect(view.result.current.unreadCount).toBe(0));
  await waitFor(()=>expect(markNotificationsRead).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(client.isMutating()).toBe(1));
  vi.mocked(listNotifications).mockResolvedValue({notifications:notifications.map(n=>({...n,readAt:"2026-11-10"})),unreadCount:0} as never);
  await act(async()=>{first({unreadCount:1});});
  await waitFor(()=>expect(client.isMutating()).toBe(0));
  expect(client.getQueryData<{unreadCount:number}>(["relay","notifications","account-a"])?.unreadCount).toBe(0);
  view.unmount();client.clear();
});


it("reuses a fresh inbox and preferences when Settings is reopened", async () => {
  vi.useFakeTimers();
  const { client, wrapper } = setup();
  configurePersonalQueryCache(client);
  const hook = () => ({ inbox: useOpenInbox(), prefs: useNotificationPreferences() });
  const first = renderHook(hook, { wrapper });
  await act(async () => {});
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  const second = renderHook(hook, { wrapper });
  await act(async () => {});
  expect(listNotifications).toHaveBeenCalledTimes(1);
  expect(getNotificationPreferences).toHaveBeenCalledTimes(1);
  expect(second.result.current.inbox.notices).toHaveLength(1);
  second.unmount(); client.clear();
});
