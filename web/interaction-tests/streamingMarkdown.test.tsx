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

it("keeps OpenCode chunks in the same live paragraph and re-parses only the tail", async () => {
  const delta = (text: string) => `${JSON.stringify({ type: "text", delta: true, part: { type: "text", text } })}\n`;
  const stream = (stdout: string, streaming = true) => createElement(AgentStream, {
    agent: "opencode", stdout, stderr: "", streaming, collaborations: [],
  });
  let stdout = delta("# Plan\n\n") + delta("Hello");
  const view = render(stream(stdout));
  expect(await blockTexts(2)).toEqual(["# Plan\n\n", "Hello"]);
  const paragraph = screen.getAllByTestId("md-block")[1];
  const parsedBefore = parses.length;
  stdout += delta(" ") + delta("**world**.");
  view.rerender(stream(stdout));
  expect(await blockTexts(2)).toEqual(["# Plan\n\n", "Hello **world**."]);
  expect(screen.getAllByTestId("md-block")[1]).toBe(paragraph);
  expect(parses.slice(parsedBefore)).toEqual(["Hello **world**."]);
  view.rerender(stream(stdout, false));
  expect(await blockTexts(1)).toEqual(["# Plan\n\nHello **world**."]);
});

it("reveals OpenCode bursts progressively and flushes the full answer on completion", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const delta = (text: string) => `${JSON.stringify({ type: "text", delta: true, part: { text } })}\n`;
  const stream = (stdout: string, streaming = true) => createElement(AgentStream, {
    agent: "opencode", stdout, stderr: "", streaming, collaborations: [],
  });
  const first = "A smoothly streamed answer. ".repeat(12);
  const view = render(stream(delta(first)));
  await act(async () => { vi.advanceTimersByTime(80); });
  const visible = view.container.querySelector(".agent-prose")!.textContent!;
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.length).toBeLessThan(first.length);
  expect(first.startsWith(visible)).toBe(true);

  const second = "More words arrive while the first burst is revealing.";
  view.rerender(stream(delta(first) + delta(second)));
  expect(view.container.querySelector(".agent-prose")!.textContent).toBe(visible);
  await act(async () => { vi.advanceTimersByTime(80); });
  expect(view.container.querySelector(".agent-prose")!.textContent!.length).toBeGreaterThan(visible.length);
  view.rerender(stream(delta(first) + delta(second), false));
  await act(async () => {});
  expect(view.container.querySelector(".agent-prose")!.textContent).toBe(first + second);
});
