import assert from "node:assert/strict";
import { test } from "node:test";
const { authorizeComputer } = await import("../src/" + "device-setup.js");

test("device setup opens approval and exchanges only the device credential", async () => {
  const opened: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const result = await authorizeComputer({ backendUrl: "https://relay.test", workspace: "/work", displayName: "Laptop",
    openBrowser: (url: string) => { opened.push(url); }, pollIntervalMs: 1,
    fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(requests.length === 1
        ? { deviceCode: "device-secret", userCode: "browser-code", verificationUrl: "https://relay.test/computer?connect=browser-code", expiresIn: 600 }
        : { sandboxId: "node-1", employeeId: "alice", token: "node-secret", workspacePath: "/work" }), { status: requests.length === 1 ? 201 : 200 });
    },
  });
  assert.equal(result.token, "node-secret");
  assert.deepEqual(opened, ["https://relay.test/computer?connect=browser-code"]);
  assert.equal((requests[1].init?.headers as Record<string, string>).Authorization, "Device device-secret");
  assert.ok(requests.every(request => !request.url.includes("device-secret")));
});

test("device setup refuses an approval URL on a different origin", async () => {
  await assert.rejects(authorizeComputer({ backendUrl: "https://relay.test", workspace: "/work", displayName: "Laptop",
    openBrowser: () => { throw new Error("must not open"); },
    fetchFn: async () => new Response(JSON.stringify({ deviceCode: "secret", verificationUrl: "https://other.test/", expiresIn: 600 })),
  }), /origin/);
});
