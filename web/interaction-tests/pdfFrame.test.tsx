import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PdfFrame } from "../src/components/artifact/PdfFrame";

describe("PdfFrame", () => {
  it("frames a data: PDF without a sandbox (Chrome blocks sandboxed PDFs) and without a referrer", () => {
    const { container } = render(<PdfFrame src="data:application/pdf;base64,JVBERi0=" title="report.pdf" />);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("data:application/pdf;base64,JVBERi0=");
    expect(frame?.hasAttribute("sandbox")).toBe(false);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("title")).toBe("report.pdf");
  });

  it("refuses anything but a data: PDF, whose opaque origin is the isolation", () => {
    for (const src of ["blob:http://localhost/abc", "/api/v1/raw.pdf", "data:text/html;base64,PGgxPg=="]) {
      const { container, unmount } = render(<PdfFrame src={src} title="x" />);
      expect(container.querySelector("iframe")).toBeNull();
      unmount();
    }
  });
});
