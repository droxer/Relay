import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { setup } from "./threadDispatchSetup";
import { useThreadDispatch } from "../src/hooks/useThreadDispatch";
import { useThreadQueue } from "../src/hooks/useThreadQueue";
import { useThreadQueueStore } from "../src/lib/threadQueueStore";
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
it("retains a queued message durably until acknowledgement",async()=>{
 sessionStorage.clear();useThreadQueueStore.setState({queues:{}});
 let finish!:(sent:boolean)=>void;
 const handle={current:{send:vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}))}};
 const view=renderHook(({running})=>useThreadQueue({queueKey:"t",running,awaitsPerson:false,composerRef:handle as never,onCancelRun:vi.fn()}),{initialProps:{running:true}});
 act(()=>{view.result.current.enqueue("pending");});
 view.rerender({running:false});
 await waitFor(()=>expect(handle.current.send).toHaveBeenCalled());
 expect(JSON.parse(sessionStorage.getItem("relay-web.queue:t")!)).toHaveLength(1);
 await act(async()=>{finish(true);});
 expect(sessionStorage.getItem("relay-web.queue:t")).toBeNull();
 view.unmount();
});
