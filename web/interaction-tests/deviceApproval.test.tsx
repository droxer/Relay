import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DeviceApproval } from "../src/components/computer/DeviceApproval";
import { approveComputerAuthorization, getComputerAuthorization } from "../src/api";
vi.mock("../src/api", () => ({ approveComputerAuthorization: vi.fn(), getComputerAuthorization: vi.fn() }));
it("shows the machine and directory and requires an explicit click", async () => {
  vi.mocked(getComputerAuthorization).mockResolvedValue({ displayName: "Laptop", workspacePath: "/Users/alice/work", status: "pending" });
  vi.mocked(approveComputerAuthorization).mockResolvedValue({ status: "approved" });
  render(<DeviceApproval code="browser-code" />);
  expect(await screen.findByText("/Users/alice/work")).toBeTruthy();
  expect(approveComputerAuthorization).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "computer.device_approve" }));
  expect(await screen.findByText("computer.device_approved")).toBeTruthy();
  expect(approveComputerAuthorization).toHaveBeenCalledWith("browser-code");
});
