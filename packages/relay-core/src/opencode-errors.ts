/** Display-only formatting; the original error stays in the run log. */
export function formatOpenCodeToolError(tool: string, value: string): { text: string; tone: "warn" | "bad" } {
  let text = value.trim();
  // ACP can wrap the error in a JSON-encoded rawOutput envelope.
  for (let depth = 0; depth < 4; depth++) {
    try {
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== "object") break;
      const error = (body as Record<string, unknown>).error;
      const message = typeof error === "string" ? error
        : error && typeof error === "object" ? (error as Record<string, unknown>).message : undefined;
      if (typeof message !== "string" || !message.trim()) break;
      text = message.trim();
    } catch {
      break;
    }
  }
  if (/\bcancelled\b|\bcanceled\b/i.test(text)) {
    return { text: /^(?:Web search|Web fetch) cancel(?:led|ed)\.?$/i.test(text) ? `${text.replace(/\.$/, "")}.` : text, tone: "warn" };
  }
  if (tool === "webfetch" || tool === "websearch") {
    const code = /^StatusCode: non 2xx status code \((\d{3})\b/.exec(text)?.[1];
    if (code === "401") return { text: "This website requires authentication (HTTP 401). Try another source.", tone: "bad" };
    if (code === "403") return { text: "This website denied access (HTTP 403). Try another source.", tone: "bad" };
  }
  return { text, tone: "bad" };
}
