import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { RelayArtifact } from "relay-core";
import { ArtifactBody } from "../src/components/artifact/ArtifactBody";
import { RecordArtifactPreview } from "../src/components/task-record/RecordArtifactPreview";
import { artifactPreviewMode, artifactRenderMode } from "../src/lib/artifactPreview";

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>图片 #1</text><script>alert(1)</script></svg>';
vi.mock("../src/api", () => ({ readArtifactText: vi.fn(async () => svg) }));
vi.mock("@/components/ui/DialogProvider", () => ({ useDialogs: () => ({ announce: vi.fn() }) }));

function artifact(contentType?: string, path = "diagrams/flow.SVG"): RelayArtifact {
  return { id: "svg", kind: "workspace_file", title: "Flow diagram", workspaceRelativePath: path, contentType, createdAt: "2026-11-10T00:00:00Z" };
}

it.each(["image/svg+xml", "text/plain", "application/xml", "application/octet-stream", undefined])(
  "offers an SVG image presentation and source for %s", (contentType) => {
    expect(artifactPreviewMode(artifact(contentType))).toBe("image");
    expect(artifactRenderMode(artifact(contentType))).toBe("svg");
  },
);

it("recognizes SVG MIME types without a filename extension", () => {
  expect(artifactRenderMode(artifact("IMAGE/SVG+XML; charset=utf-8", "diagram"))).toBe("svg");
});

it("renders SVG bytes in an isolated image and keeps source available", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file = artifact("text/plain");
  const body = (view: "preview" | "source") => <QueryClientProvider client={client}>
    <ArtifactBody artifact={file} sessionId="thread" view={view} />
  </QueryClientProvider>;
  const { rerender, container } = render(body("preview"));
  const image = await screen.findByRole("img", { name: "Flow diagram" });
  expect(image.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  expect(container.querySelector("svg, script, iframe")).toBeNull();
  rerender(body("source"));
  expect(screen.queryByRole("img")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe(svg);
  rerender(body("preview"));
  expect(screen.getByRole("img", { name: "Flow diagram" })).toBeTruthy();
  client.clear();
});

it("offers working preview/source controls in the task file pane", async () => {
  const client = new QueryClient();
  const { container } = render(<QueryClientProvider client={client}>
    <RecordArtifactPreview artifact={{ ...artifact("application/octet-stream"), sessionId: "thread" }} onBack={vi.fn()} />
  </QueryClientProvider>);
  await screen.findByRole("img", { name: "Flow diagram" });
  fireEvent.click(screen.getByRole("button", { name: "artifact.view_source" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe(svg);
  fireEvent.click(screen.getByRole("button", { name: "artifact.view_preview" }));
  expect(screen.getByRole("img", { name: "Flow diagram" })).toBeTruthy();
  client.clear();
});
