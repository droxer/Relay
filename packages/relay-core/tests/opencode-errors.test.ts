import assert from "node:assert/strict";
import { it } from "node:test";
import { formatOpenCodeToolError } from "../src/opencode-errors.js";

it("unwraps OpenCode tool errors while preserving unfamiliar diagnostics", () => {
  for (const value of ["  Permission denied\n", '{"metadata":{},"error":"Permission denied"}', '{"error":{"message":"Permission denied"}}', '{"error":"{\\"error\\":\\"Permission denied\\"}"}']) {
    assert.deepEqual(formatOpenCodeToolError("read", value), { text: "Permission denied", tone: "bad" });
  }
  for (const value of ["{broken", '{"metadata":{}}', '{"error":null}', '{"error":""}', "42"]) {
    assert.deepEqual(formatOpenCodeToolError("read", value), { text: value, tone: "bad" });
  }
});

it("distinguishes cancellations and web access failures without rewriting unrelated tools", () => {
  assert.deepEqual(formatOpenCodeToolError("websearch", "Web search canceled"), { text: "Web search canceled.", tone: "warn" });
  assert.deepEqual(formatOpenCodeToolError("webfetch", "Request cancelled by user"), { text: "Request cancelled by user", tone: "warn" });
  const forbidden = "StatusCode: non 2xx status code (403 GET https://example.com/)";
  assert.deepEqual(formatOpenCodeToolError("webfetch", forbidden), { text: "This website denied access (HTTP 403). Try another source.", tone: "bad" });
  assert.deepEqual(formatOpenCodeToolError("bash", forbidden), { text: forbidden, tone: "bad" });
  const unavailable = "StatusCode: non 2xx status code (503 GET https://example.com/)";
  assert.deepEqual(formatOpenCodeToolError("webfetch", unavailable), { text: unavailable, tone: "bad" });
});
