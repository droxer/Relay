import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeImages } from "../src/image-attachments.js";

const content = Buffer.from("image bytes");
const image = { id: "b85cf5a8-1c08-4143-a925-56f42e585716", mediaType: "image/png" as const, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };

for (const guest of [false, true]) test(`image materialization and cleanup (${guest ? "guest" : "local"})`, async () => {
  const hostPath = mkdtempSync(join(tmpdir(), "relay-image-"));
  try {
    const result = await materializeImages({ attachments: [image], hostPath, executionPath: guest ? "/workspace" : hostPath, fetchImage: async () => new Response(content) });
    const path = guest ? result.images[0]!.path.replace("/workspace", hostPath) : result.images[0]!.path;
    assert.deepEqual(readFileSync(path), content);
    if (guest) assert.ok(result.images[0]!.path.startsWith("/workspace/.relay/"));
    result.cleanup();
    assert.equal(existsSync(path), false);
  } finally { rmSync(hostPath, { recursive: true, force: true }); }
});

for (const [name, response] of [
  ["corrupt", () => new Response("wrong bytes")],
  ["oversize", () => new Response(Buffer.alloc(image.bytes + 1))],
  ["unavailable", () => new Response("missing", { status: 404 })],
] as const) test(`refuses ${name} downloads and removes partial staging`, async () => {
  const hostPath = mkdtempSync(join(tmpdir(), "relay-image-"));
  try {
    await assert.rejects(materializeImages({ attachments: [image], hostPath, executionPath: hostPath, fetchImage: async () => response() }));
    assert.deepEqual(readdirSync(join(hostPath, ".relay", "image-inputs")), []);
  } finally { rmSync(hostPath, { recursive: true, force: true }); }
});

test("rejects traversal, oversized manifests, and symlinked workspace control directories", async () => {
  const hostPath = mkdtempSync(join(tmpdir(), "relay-image-"));
  const external = mkdtempSync(join(tmpdir(), "relay-image-outside-"));
  const options = { hostPath, executionPath: hostPath, fetchImage: async () => { throw new Error("must not fetch"); } };
  try {
    await assert.rejects(materializeImages({ ...options, attachments: [{ ...image, id: "../../outside" }] }), /Invalid/);
    await assert.rejects(materializeImages({ ...options, attachments: Array(5).fill(image) }), /Too many/);
    rmSync(join(hostPath, ".relay"), { recursive: true });
    symlinkSync(external, join(hostPath, ".relay"), "dir");
    await assert.rejects(materializeImages({ ...options, attachments: [image] }), /Unsafe/);
    assert.deepEqual(readdirSync(external), []);
  } finally { rmSync(hostPath, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
});
