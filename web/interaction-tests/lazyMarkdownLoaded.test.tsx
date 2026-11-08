import { render } from "@testing-library/react";
import { createElement } from "react";
import { expect, it } from "vitest";

import { Markdown, MarkdownContent, preloadMarkdown } from "../src/components/LazyMarkdown";

// A preloaded pipeline must render on the first commit: a Suspense fallback,
// even for a tick, holds the parsed text back ~300 ms and reflows the turn.
it("renders a preloaded markdown pipeline without its plain-text fallback", async () => {
  preloadMarkdown();
  await import("../src/components/Markdown");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const { container } = render(createElement("div", null,
    createElement(Markdown, { text: "**bold** words" }),
    createElement(MarkdownContent, { text: "*soft* words" }),
  ));

  expect(container.querySelector(".md-plain")).toBeNull();
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("em")?.textContent).toBe("soft");
});
