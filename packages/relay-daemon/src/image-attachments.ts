/** Download only backend-issued image references into the mounted run workspace. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ThreadImageAttachment } from "relay-core";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

export async function materializeImages(options: {
  attachments: ThreadImageAttachment[];
  hostPath: string;
  executionPath: string;
  fetchImage(id: string): Promise<Response>;
}) {
  const { attachments, hostPath, executionPath } = options;
  if (attachments.length > 4) throw new Error("Too many image attachments.");
  const images: Array<{ path: string; mediaType: string }> = [];
  if (!attachments.length) return { images, cleanup() {} };
  const root = realpathSync(hostPath);
  let parent = root;
  for (const part of [".relay", "image-inputs"]) {
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe image input directory.");
  }
  const directory = mkdtempSync(join(parent, "run-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    for (const image of attachments) {
      if (!/^[a-f0-9-]{36}$/i.test(image.id) || !/^[a-f0-9]{64}$/.test(image.sha256)
          || !Object.hasOwn(EXTENSIONS, image.mediaType) || !Number.isSafeInteger(image.bytes)
          || image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES) throw new Error("Invalid image attachment.");
      const response = await options.fetchImage(image.id);
      if (!response.ok || !response.body) throw new Error(`Image attachment unavailable (${response.status}).`);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > image.bytes || bytes > MAX_IMAGE_BYTES) throw new Error("Image attachment exceeds its declared size.");
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const content = Buffer.concat(chunks);
      if (bytes !== image.bytes || createHash("sha256").update(content).digest("hex") !== image.sha256) {
        throw new Error("Image attachment failed integrity verification.");
      }
      const file = join(directory, `${images.length}.${EXTENSIONS[image.mediaType]}`);
      writeFileSync(file, content, { flag: "wx", mode: 0o600 });
      const runtimePath = executionPath === hostPath ? file
        : `${executionPath.replace(/[\\/]+$/, "")}/${relative(root, file).split(sep).join("/")}`;
      images.push({ path: runtimePath, mediaType: image.mediaType });
    }
    return { images, cleanup };
  } catch (error) { cleanup(); throw error; }
}
