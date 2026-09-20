import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RuntimeRefreshButton } from "../src/components/computer/RuntimeRefreshButton";
import { requestRuntimeRefresh, getRuntimeRefresh } from "../src/api";
vi.mock("../src/api", () => ({ requestRuntimeRefresh: vi.fn(), getRuntimeRefresh: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it("waits for daemon acknowledgement before reporting a completed refresh", async () => {
  vi.mocked(requestRuntimeRefresh).mockResolvedValue({ commandId: "refresh-1" });
  vi.mocked(getRuntimeRefresh).mockResolvedValue({ status: "completed" });
  render(<RuntimeRefreshButton nodeId="node-1" online supported busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "computer.refresh_runtimes" }));
  await waitFor(() => expect(requestRuntimeRefresh).toHaveBeenCalledWith("node-1"));
  expect(await screen.findByText("computer.refresh_completed")).toBeTruthy();
});
it("disables unsupported and offline computers", () => {
  const view = render(<RuntimeRefreshButton nodeId="node-1" online={false} supported busy={false} />);
  expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  view.rerender(<RuntimeRefreshButton nodeId="node-1" online supported={false} busy={false} />);
  expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
});
