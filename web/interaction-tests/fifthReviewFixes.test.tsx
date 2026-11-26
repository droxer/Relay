import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { setup } from "./threadDispatchSetup";
import { useThreadDispatch } from "../src/hooks/useThreadDispatch";

it("reuses the opening request identity after an ambiguous failure", async () => {
  const { deps, dispatch, session } = setup();
  dispatch.mockRejectedValueOnce(new TypeError("Response lost")).mockResolvedValueOnce(session);
  const view = renderHook(() => useThreadDispatch(deps));
  await act(async () => { expect(await view.result.current.sendMessage()).toBe(false); });
  await act(async () => { expect(await view.result.current.messageRetry?.retry()).toBe(true); });
  const [original, replay] = dispatch.mock.calls.map(([input]) => input);
  expect(original.idempotencyKey).toBeTruthy();
  expect(replay).toEqual(original);
  view.unmount();
});
