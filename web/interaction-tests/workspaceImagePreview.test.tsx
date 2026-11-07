import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { WorkspaceFilePreview, useWorkspaceFileView } from "../src/components/workspace/WorkspaceFilePreview";

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>图片</text></svg>';
const file = {
  scope: "shared" as const,
  nodeId: "computer-1",
  source: "live" as const,
  path: "icon.svg",
  exists: true,
  isBinary: false,
  bytes: 80,
  content: svg,
  contentBase64: null,
  truncated: false,
  limitBytes: 262144,
  generatedAt: "2026-11-07T00:00:00Z",
};

it("previews a text SVG as an image by default", () => {
  function Preview() {
    const { view, setView } = useWorkspaceFileView("icon.svg");
    return <>
      <button onClick={() => setView(view === "preview" ? "source" : "preview")}>Toggle</button>
      <WorkspaceFilePreview name="icon.svg" data={file} isLoading={false} error={null} view={view} />
    </>;
  }
  render(<Preview />);
  const image = screen.getByRole("img", { name: "icon.svg" });
  expect(image.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  expect(document.querySelector("svg")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(document.querySelector("code")?.textContent).toBe(svg);
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  expect(screen.getByRole("img", { name: "icon.svg" })).toBeTruthy();
});

it("keeps SVG source readable when source view is selected", () => {
  render(<WorkspaceFilePreview name="icon.svg" data={file} isLoading={false} error={null} view="source" />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(document.querySelector("code")?.textContent).toBe(svg);
});

it("continues to preview binary PNG bytes", () => {
  render(<WorkspaceFilePreview name="photo.png" data={{ ...file, isBinary: true, content: null, contentBase64: "iVBORw0KGgo=" }} isLoading={false} error={null} view="preview" />);
  expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
});
