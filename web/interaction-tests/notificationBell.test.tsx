import { describe, expect, it, vi } from "vitest";
import { cloneElement, createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import type { NotificationsController } from "@/hooks/useNotifications";
import { notificationHref, notificationViews } from "@/lib/notifications";

// A real base-ui Popover never opens under jsdom; render the panel inline.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => createElement("div", null, children),
  PopoverTrigger: ({ render }: any) => cloneElement(render),
  PopoverContent: ({ children }: any) => createElement("div", { role: "dialog" }, children),
}));

const notices = notificationViews([
  { id: "n1", kind: "task_completed", data: { taskId: "t1", title: "Fix login", status: "review", number: 12 }, createdAt: "2026-10-16T09:00:00Z", readAt: null },
  { id: "n2", kind: "computer_status", data: { nodeId: "node1", computerName: "Office Mac", to: "offline" }, createdAt: "2026-10-16T08:00:00Z", readAt: "2026-10-16T08:30:00Z" },
]);

function controller(overrides: Partial<NotificationsController> = {}): NotificationsController {
  return {
    notices,
    unreadCount: 12,
    isPending: false,
    isError: false,
    markAllRead: vi.fn(),
    open: vi.fn(),
    ...overrides,
  };
}

function renderBell(value: NotificationsController, onOpenSettings = vi.fn()) {
  render(
    <NotificationBell
      controller={value}
      hrefFor={(target) => notificationHref(target)}
      settingsHref="/settings/notifications"
      onOpenSettings={onOpenSettings}
    />,
  );
  return { onOpenSettings };
}

describe("NotificationBell", () => {
  it("shows an approval notice and opens the thread where it can be answered", () => {
    const [approval] = notificationViews([{
      id: "n-approval", kind: "approval_requested",
      data: { taskId: "t1", sessionId: "s1", questionId: "q1", title: "Ship it" },
      createdAt: "2026-10-16T09:00:00Z", readAt: null,
    }]);
    const value = controller({ notices: [approval], unreadCount: 1 });
    renderBell(value);
    const row = screen.getByText("notifications.approval_requested").closest("a")!;
    expect(row.getAttribute("href")).toBe("/threads/s1");
    expect(row.hasAttribute("data-unread")).toBe(true);
    fireEvent.click(row);
    expect(value.open).toHaveBeenCalledWith(approval);
  });

  it("caps the unread badge and names the count on the trigger", () => {
    renderBell(controller());
    const trigger = screen.getByRole("button", { name: "notifications.bell_unread" });
    expect(trigger.textContent).toContain("9+");
  });

  it("opens a notice through the controller and links it to its record", () => {
    const value = controller();
    renderBell(value);
    const row = screen.getByText("notifications.task_review").closest("a")!;
    expect(row.getAttribute("href")).toBe("/tasks/t1");
    expect(row.hasAttribute("data-unread")).toBe(true);
    fireEvent.click(row);
    expect(value.open).toHaveBeenCalledWith(notices[0]);
    // A read notice is listed without the unread marker.
    expect(screen.getByText("notifications.computer_offline").closest("a")!.hasAttribute("data-unread")).toBe(false);
  });

  it("leaves a modified click to the browser", () => {
    const value = controller();
    renderBell(value);
    // After React's handler has declined it, keep jsdom from following the link.
    const stopNavigation = (event: Event) => event.preventDefault();
    document.addEventListener("click", stopNavigation);
    fireEvent.click(screen.getByText("notifications.task_review").closest("a")!, { metaKey: true });
    document.removeEventListener("click", stopNavigation);
    expect(value.open).not.toHaveBeenCalled();
  });

  it("marks everything read", () => {
    const value = controller();
    renderBell(value);
    fireEvent.click(screen.getByRole("button", { name: "notifications.mark_all_read" }));
    expect(value.markAllRead).toHaveBeenCalled();
  });

  it("says when the inbox is empty and offers no badge", () => {
    const { onOpenSettings } = renderBell(controller({ notices: [], unreadCount: 0 }));
    expect(screen.getByRole("status").textContent).toBe("notifications.empty");
    const trigger = screen.getByRole("button", { name: "notifications.title" });
    expect(trigger.querySelector(".notif-bell-badge")).toBeNull();
    expect((screen.getByRole("button", { name: "notifications.mark_all_read" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("notifications.settings_link"));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
