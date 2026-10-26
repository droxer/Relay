import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { DeviceApproval } from "../src/components/computer/DeviceApproval";
import { approveComputerAuthorization, getComputerAuthorization, RelayApiError } from "../src/api";
import type { CurrentUser } from "../src/types";

vi.mock("../src/api", async (importActual) => ({
  RelayApiError: (await importActual<typeof import("../src/api")>()).RelayApiError,
  approveComputerAuthorization: vi.fn(),
  getComputerAuthorization: vi.fn(),
}));

const user = { id: "u-1", username: "alice", role: "user", displayName: "Alice" } as CurrentUser;
const pending = { displayName: "Laptop", workspacePath: "/Users/alice/work", status: "pending" };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderApproval() {
  return render(<DeviceApproval code="browser-code" user={user} />, { wrapper });
}

beforeEach(() => {
  vi.mocked(getComputerAuthorization).mockReset();
  vi.mocked(approveComputerAuthorization).mockReset();
});

it("shows the machine, directory, and account and requires an explicit click", async () => {
  vi.mocked(getComputerAuthorization).mockResolvedValue(pending);
  vi.mocked(approveComputerAuthorization).mockResolvedValue({ status: "approved" });
  renderApproval();
  expect(await screen.findByText("/Users/alice/work")).toBeTruthy();
  expect(screen.getByText("Laptop")).toBeTruthy();
  expect(screen.getByText("Alice (@alice)")).toBeTruthy();
  expect(approveComputerAuthorization).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "computer.device_approve" }));
  await screen.findByRole("heading", { name: "computer.device_approved_title" });
  expect(screen.getByText("computer.device_approved")).toBeTruthy();
  expect(approveComputerAuthorization).toHaveBeenCalledWith("browser-code");
  expect(screen.queryByRole("button", { name: "computer.device_approve" })).toBeNull();
  expect(screen.getByRole("link", { name: "computer.device_open_computers" }).getAttribute("href")).toBe("/computers");
});

it("reads a request approved elsewhere (409) as connected", async () => {
  vi.mocked(getComputerAuthorization).mockResolvedValue(pending);
  vi.mocked(approveComputerAuthorization).mockRejectedValue(new RelayApiError("already approved", 409));
  renderApproval();
  fireEvent.click(await screen.findByRole("button", { name: "computer.device_approve" }));
  await screen.findByRole("heading", { name: "computer.device_approved_title" });
});

it("explains an expired request instead of offering to connect", async () => {
  vi.mocked(getComputerAuthorization).mockRejectedValue(new RelayApiError("expired", 410));
  renderApproval();
  await screen.findByRole("heading", { name: "computer.device_expired_title" });
  expect(screen.queryByRole("button", { name: "computer.device_approve" })).toBeNull();
});

it("offers a retry when the lookup fails for another reason", async () => {
  vi.mocked(getComputerAuthorization)
    .mockRejectedValueOnce(new RelayApiError("boom", 500))
    .mockResolvedValueOnce(pending);
  renderApproval();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "computer.device_retry" }));
  expect(await screen.findByText("/Users/alice/work")).toBeTruthy();
});

it("keeps the request open and shows an error when approval fails", async () => {
  vi.mocked(getComputerAuthorization).mockResolvedValue(pending);
  vi.mocked(approveComputerAuthorization).mockRejectedValue(new RelayApiError("rate limited", 429));
  renderApproval();
  fireEvent.click(await screen.findByRole("button", { name: "computer.device_approve" }));
  expect((await screen.findByRole("alert")).textContent).toBe("computer.device_error");
  expect(screen.getByRole("button", { name: "computer.device_approve" })).toBeTruthy();
});
