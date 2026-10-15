import { act, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

// Every react-markdown render is a full remark/rehype parse of its children, so
// counting renders per text counts parses. The stand-in renders the source
// verbatim so the DOM still says which block is which.
const parses = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    parses.push(children);
    return createElement("div", { "data-testid": "md-block" }, children);
  },
}));

import { AgentStream } from "../src/components/AgentStream";
import { preloadMarkdown } from "../src/components/LazyMarkdown";

function piDeltas(...deltas: string[]): string {
  return [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
    ...deltas.map((delta) => JSON.stringify({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    })),
  ].join("\n");
}

// The lazy Markdown chunk suspends each block once, and its plain-text fallback
// already shows the words — so wait for the parsed blocks themselves.
async function blockTexts(count: number): Promise<string[]> {
  await waitFor(() => expect(screen.getAllByTestId("md-block")).toHaveLength(count));
  return screen.getAllByTestId("md-block").map((node) => node.textContent ?? "");
}

function renderStream(stdout: string, streaming: boolean) {
  return createElement(AgentStream, { agent: "pi", stdout, stderr: "", streaming, collaborations: [] });
}

beforeEach(async () => {
  parses.length = 0;
  // Reduced motion reveals streamed text at once, so each update is one frame.
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => { preloadMarkdown(); });
});

it("re-parses only the growing tail block while a reply streams", async () => {
  const first = "# Plan\n\n";
  const fence = "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n";
  const view = render(renderStream(piDeltas(first, fence, "Closing"), true));
  expect(await blockTexts(3)).toEqual([first, fence, "Closing"]);
  const parsedBefore = parses.length;

  view.rerender(renderStream(piDeltas(first, fence, "Closing", " words."), true));
  expect(await blockTexts(3)).toEqual([first, fence, "Closing words."]);
  expect(parses.slice(parsedBefore)).toEqual(["Closing words."]);
});

it("parses settled text as one document", async () => {
  const text = "# Plan\n\nBody.";
  const view = render(renderStream(piDeltas(text), true));
  expect(await blockTexts(2)).toEqual(["# Plan\n\n", "Body."]);

  view.rerender(renderStream(piDeltas(text), false));
  expect(await blockTexts(1)).toEqual([text]);
});
