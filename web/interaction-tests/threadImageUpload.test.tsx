import { File } from "node:buffer";
import { expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { uploadThreadImage } from "../src/api-client/sessions";
import { useComposerImages } from "../src/components/composer/ComposerImages";

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

it("explains a dropped upload instead of showing the browser's network error", async () => {
  // Safari rejects fetch with a bare TypeError("Load failed") when the
  // connection drops mid-upload, which is common on a phone's uplink.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  const { result } = renderHook(() => useComposerImages("thread-1"));
  await act(() => result.current.add([file as unknown as globalThis.File]));
  expect(result.current.error).toBe("composer.image_failed"); // setup's t() returns the key
  expect(result.current.busy).toBe(false);
});

it("shows the server's reason when it refuses an upload", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Too many image uploads. Try again shortly." }), { status: 429 })));
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  const { result } = renderHook(() => useComposerImages("thread-1"));
  await act(() => result.current.add([file as unknown as globalThis.File]));
  expect(result.current.error).toBe("Too many image uploads. Try again shortly.");
});

it("preserves server upload errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Storage unavailable" }), { status: 503 })));
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  await expect(uploadThreadImage(file as unknown as globalThis.File)).rejects.toThrow("Storage unavailable");
});
