import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { ProjectDashboard } from "../src/components/ProjectDashboard";

const FLOW_POLICY_KEY = ["task-flow-policy"] as const;

it("subscribes to the task flow policy cache without requiring a fetch function", async () => {
  const client = new QueryClient();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  const { container } = render(<ProjectDashboard tasks={[]} />, { wrapper });
  // No policy cached yet: the work-in-progress tile carries no limit hint.
  expect(container.querySelector(".adm-dash-tile-hint")).toBeNull();

  act(() => {
    client.setQueryData(FLOW_POLICY_KEY, { wipLimit: 5, scope: "employee" });
  });

  await waitFor(() => {
    expect(container.querySelector(".adm-dash-tile-hint")).not.toBeNull();
  });
  expect(screen.getByText("backlog.metric_active").nextElementSibling?.textContent).toBe("0");
  expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("No queryFn was passed"));
  client.clear();
});
