import { render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";

const SOURCE = [
  "[x](javascript:alert(1)) and [y](JAVASCRIPT:alert(2))",
  "",
  "[z](vbscript:msgbox(1)) [d](data:text/html;base64,PGgxPg==)",
  "",
  "![img](javascript:alert(3)) [ok](https://example.com)",
].join("\n");

it("never puts a javascript: (or other script-capable) URL into the DOM", async () => {
  const { container } = render(<Markdown text={SOURCE} />);
  await waitFor(() => expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull());

  for (const element of container.querySelectorAll("[href], [src], [title]")) {
    for (const attribute of ["href", "src", "title"]) {
      const value = element.getAttribute(attribute) ?? "";
      expect(value.trim().toLowerCase()).not.toMatch(/^(javascript|vbscript|data):/);
    }
  }
  expect(container.innerHTML.toLowerCase()).not.toContain("javascript:");
  expect(container.textContent).toContain("x");
});
