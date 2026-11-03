import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useComposerImages } from "../src/components/composer/ComposerImages";
import { uploadThreadImage } from "../src/api-client/sessions";

vi.mock("../src/api-client/sessions", () => ({ uploadThreadImage: vi.fn() }));
const attachment = { id: "image-1", mediaType: "image/png", bytes: 10, sha256: "a".repeat(64) };
const file = () => new File(["image data"], "screenshot.png", { type: "image/png" });

function objectUrls() {
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: revoke });
  return revoke;
}

it("uploads once and retains image references for a failed send until explicitly cleared", async () => {
  const revoke = objectUrls();
  vi.mocked(uploadThreadImage).mockResolvedValue(attachment as any);
  const { result } = renderHook(() => useComposerImages("thread-1"));
  await act(async () => { await result.current.add([file()]); });
  expect(result.current.images[0]).toMatchObject({ ...attachment, preview: "blob:preview" });
  expect(result.current.busy).toBe(false);
  expect(uploadThreadImage).toHaveBeenCalledTimes(1);
  act(() => result.current.clear());
  expect(result.current.images).toEqual([]);
  expect(revoke).toHaveBeenCalledWith("blob:preview");
});

it("rejects unsupported types and too many images before uploading", async () => {
  objectUrls();
  vi.mocked(uploadThreadImage).mockClear();
  const { result } = renderHook(() => useComposerImages("thread-1"));
  await act(async () => { await result.current.add([new File(["svg"], "image.svg", { type: "image/svg+xml" })]); });
  expect(result.current.error).toBe("composer.image_limits");
  await act(async () => { await result.current.add(Array.from({ length: 5 }, file)); });
  expect(uploadThreadImage).not.toHaveBeenCalled();
});

it("discards uploads that finish after switching Threads", async () => {
  objectUrls();
  let resolve!: (value: any) => void;
  vi.mocked(uploadThreadImage).mockImplementation(() => new Promise(done => { resolve = done; }));
  const { result, rerender } = renderHook(({ thread }) => useComposerImages(thread), { initialProps: { thread: "thread-1" } });
  let pending!: Promise<void>;
  act(() => { pending = result.current.add([file()]); });
  expect(result.current.busy).toBe(true);
  rerender({ thread: "thread-2" });
  await act(async () => { resolve(attachment); await pending; });
  expect(result.current.images).toEqual([]);
  expect(result.current.busy).toBe(false);
});

it("reports upload failure and allows retry", async () => {
  objectUrls();
  vi.mocked(uploadThreadImage).mockRejectedValueOnce(new Error("Storage unavailable")).mockResolvedValueOnce(attachment as any);
  const { result } = renderHook(() => useComposerImages("thread-1"));
  await act(async () => { await result.current.add([file()]); });
  expect(result.current.error).toBe("Storage unavailable");
  expect(result.current.busy).toBe(false);
  await act(async () => { await result.current.add([file()]); });
  await waitFor(() => expect(result.current.images).toHaveLength(1));
  expect(result.current.error).toBeNull();
});
