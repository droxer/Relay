import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { BacklogStats } from "../src/components/task-board/BacklogChrome";

const FLOW_POLICY_KEY = ["task-flow-policy"] as const;

it("subscribes to the task flow policy cache without requiring a fetch function", async () => {
  const client = new QueryClient();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  render(<BacklogStats tasks={[]} />, { wrapper });
  expect(screen.getByText("backlog.wip_limit").nextElementSibling?.textContent).toBe("—");

  act(() => {
    client.setQueryData(FLOW_POLICY_KEY, { wipLimit: 5, scope: "employee" });
  });

  await waitFor(() => {
    expect(screen.getByText("backlog.wip_limit").nextElementSibling?.textContent).toBe("5");
  });
  expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("No queryFn was passed"));
  client.clear();
});
