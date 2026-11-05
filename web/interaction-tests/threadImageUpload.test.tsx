import { File } from "node:buffer";
import { expect, it, vi } from "vitest";
import { uploadThreadImage } from "../src/api-client/sessions";

it.each(["image/jpeg", "image/png", "image/webp"])("uploads complete %s bytes without File or Blob serialization", async (type) => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const file = new File([bytes], "photo", { type });
  const buffer = await file.arrayBuffer();
  vi.spyOn(file, "arrayBuffer").mockResolvedValue(buffer);
  const attachment = { id: "image-1", mediaType: type, bytes: bytes.length };
  // Keep the request on fetch's byte-buffer path: the upload must not
  // require the network process to resolve either a File or a Blob.
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.body).toBe(buffer);
    const request = new Request("https://relay.example/api/v1/thread-attachments", init);
    const received = await request.arrayBuffer();
    expect(new Uint8Array(received)).toEqual(bytes);
    return new Response(JSON.stringify(attachment), { status: 201 });
  });
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  await expect(uploadThreadImage(file as unknown as globalThis.File, controller.signal)).resolves.toEqual(attachment);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/thread-attachments"), expect.objectContaining({
    method: "POST", credentials: "include", signal: controller.signal,
    headers: { "Content-Type": type },
  }));
});

it("does not upload when reading the selected photo fails", async () => {
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Photo is no longer readable"));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(uploadThreadImage(file as unknown as globalThis.File)).rejects.toThrow("Photo is no longer readable");
  expect(fetch).not.toHaveBeenCalled();
});

it("does not upload if the draft is cancelled while reading the photo", async () => {
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  const controller = new AbortController();
  vi.spyOn(file, "arrayBuffer").mockImplementation(async () => {
    controller.abort();
    return new ArrayBuffer(5);
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(uploadThreadImage(file as unknown as globalThis.File, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves server upload errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Storage unavailable" }), { status: 503 })));
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  await expect(uploadThreadImage(file as unknown as globalThis.File)).rejects.toThrow("Storage unavailable");
});
