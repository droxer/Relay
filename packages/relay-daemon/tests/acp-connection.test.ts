import assert from "node:assert/strict";
import test from "node:test";
import { withAcpChild } from "../src/permission-adapters/acp-connection.js";

for (const stream of ["input", "output"]) {
  test(`ACP rejects pending requests when the runtime closes its ${stream} stream`, async () => {
    let ready!: () => void;
    const inputClosed = new Promise<void>(resolve => { ready = resolve; });
    const script = stream === "output"
      ? "process.stdout.end(); setInterval(() => {}, 1000)"
      : `require('node:fs').closeSync(0); process.stdout.write('{"method":"ready"}\\n'); setInterval(() => {}, 1000)`;
    await assert.rejects(withAcpChild({
      label: "test runtime", command: process.execPath, args: ["-e", script],
      cwd: process.cwd(), env: process.env, stderr: { write() {} },
      signal: AbortSignal.timeout(5000), onRequest: async () => ({}),
      onNotification: () => ready(),
    }, async (connection) => {
      if (stream === "input") await inputClosed;
      await connection.request("initialize", {});
    }), /closed|EPIPE|write/i);
  });
}
