import assert from "node:assert/strict";
import test from "node:test";
import { executionRecoveryGuide } from "../src/lib/executionRecovery.js";

test("online computer with unconfirmed execution gives process inspection guidance",()=>{
 const execution={phase:"unresponsive" as const,executionConfirmed:false,deletionRequested:true,canDelete:false,blockingReason:"execution_unconfirmed",lastConfirmedAt:null,nextRecoveryAt:null,computerOnline:true};
 assert.equal(executionRecoveryGuide(execution)?.key,"online_exit_unconfirmed");
 assert.equal(executionRecoveryGuide({...execution,computerOnline:false})?.key,"execution_unconfirmed");
 assert.equal(executionRecoveryGuide({...execution,phase:"recovery_required",canReportGone:true})?.reportGone,true);
});
