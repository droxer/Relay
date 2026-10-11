import assert from "node:assert/strict";
import test from "node:test";
import { executionRecoveryGuide } from "../src/lib/executionRecovery.js";

test("online computer with unconfirmed execution gives process inspection guidance",()=>{
 const execution={phase:"unresponsive" as const,executionConfirmed:false,deletionRequested:true,canDelete:false,blockingReason:"execution_unconfirmed",lastConfirmedAt:null,nextRecoveryAt:null,computerOnline:true};
 assert.equal(executionRecoveryGuide(execution)?.key,"online_exit_unconfirmed");
 assert.equal(executionRecoveryGuide({...execution,computerOnline:false})?.key,"execution_unconfirmed");
 assert.equal(executionRecoveryGuide({...execution,phase:"recovery_required",canReportGone:true})?.reportGone,true);
});

test("a run Relay gave up on after its computer died offers report gone",()=>{
 for (const blockingReason of ["execution_lost","execution_interrupted"]) {
  const execution={phase:"recovery_required" as const,executionConfirmed:false,deletionRequested:false,canDelete:false,blockingReason,lastConfirmedAt:null,nextRecoveryAt:null,computerOnline:false,canReportGone:true};
  const guide=executionRecoveryGuide(execution);
  assert.equal(guide?.key,blockingReason);
  assert.equal(guide?.destination,"computer");
  assert.equal(guide?.reportGone,true);
 }
});

test("lost exit evidence offers report-gone, not a retry that can only re-mark it",()=>{
 const execution={phase:"recovery_required" as const,executionConfirmed:false,deletionRequested:true,canDelete:false,blockingReason:"missing_terminal_evidence",lastConfirmedAt:null,nextRecoveryAt:null,computerOnline:false,canReportGone:true,canRetrySave:false};
 const guide=executionRecoveryGuide(execution);
 assert.equal(guide?.key,"missing_terminal_evidence");
 assert.equal(guide?.reportGone,true);
 assert.equal(guide?.retrySave,undefined);
});
