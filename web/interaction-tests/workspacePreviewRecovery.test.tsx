import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RelayApiError } from "../src/api";
import { WorkspaceFilePreview } from "../src/components/workspace/WorkspaceFilePreview";

it.each([
  [new Error("internal transport detail"), "workspace.preview_error"],
  [new RelayApiError("private path", 404), "workspace.preview_missing"],
  [new RelayApiError("private node", 503), "workspace.shared_unavailable"],
])("announces a readable preview error and retries the selected file", (error, label) => {
  const onRetry = vi.fn();
  const view = render(<WorkspaceFilePreview name="report.txt" isLoading={false} error={error} view="source" onRetry={onRetry} />);
  expect(screen.getByRole("alert").textContent).toContain(label);
  expect(screen.queryByText(error.message)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "workspace.retry" }));
  expect(onRetry).toHaveBeenCalledOnce();
  view.rerender(<WorkspaceFilePreview name="report.txt" isLoading error={error} view="source" onRetry={onRetry} />);
  expect(screen.queryByRole("button", { name: "workspace.retry" })).toBeNull();
});
