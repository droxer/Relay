import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ExecutionJournal} from "../src/execution-journal.js";
import {TerminalOutbox} from "../src/terminal-outbox.js";

test("restart retains unresolved execution identity; only durable exit evidence clears it", async () => {
 const root=mkdtempSync(join(tmpdir(),"relay-execution-journal-"));
 try {
  const dir=join(root,"executions");
  const command={id:"command",runId:"run",sessionId:"thread",leaseId:"lease",agent:"claude"};
  new ExecutionJournal(dir).record(command);
  const restarted=new ExecutionJournal(dir);
  assert.equal(restarted.has("command"),true);
  assert.equal(restarted.pending()[0].leaseId,"lease");
  const outbox=new TerminalOutbox(join(root,"terminal"),id=>restarted.confirmExit(id));
  outbox.retain({type:"run.output",commandId:"command",leaseId:"lease",sequence:0,text:"saved"});
  assert.equal(restarted.has("command"),true);
  outbox.retain({type:"run.cancelled",commandId:"command",leaseId:"lease",runId:"run"});
  assert.equal(new ExecutionJournal(dir).has("command"),false);
  const replayed: string[]=[];
  await new TerminalOutbox(join(root,"terminal")).replay(async(_url,init)=>{replayed.push(JSON.parse(String(init?.body)).type);return new Response("{}")},"http://backend/events","token");
  assert.deepEqual(replayed,["run.output","run.cancelled"]);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("journal keeps spawn evidence across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-journal-evidence-"));
  try {
    const journal = new ExecutionJournal(dir);
    journal.record({ id: "cmd", runId: "run", sessionId: "ses", agent: "codex" });
    journal.attach("cmd", { processGroup: 4242, bootAt: 1234 });
    const [record] = new ExecutionJournal(dir).pending();
    assert.equal(record?.processGroup, 4242);
    assert.equal(record?.bootAt, 1234);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
