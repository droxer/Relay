import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { setup } from "./threadDispatchSetup";
import { useThreadDispatch } from "../src/hooks/useThreadDispatch";
it("reuses the opening request identity after an ambiguous failure", async () => {
 const {deps,dispatch,session}=setup();
 dispatch.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(session);
 const view=renderHook(()=>useThreadDispatch(deps));
 await act(async()=>{await view.result.current.sendMessage();});
 await act(async()=>{await view.result.current.sendMessage();});
 expect(dispatch.mock.calls[0][0].idempotencyKey).toBeTruthy();
 expect(dispatch.mock.calls[1][0].idempotencyKey).toBe(dispatch.mock.calls[0][0].idempotencyKey);
 view.unmount();
});
