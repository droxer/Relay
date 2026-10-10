import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { GUEST_PROCESS_SUPERVISOR } from "../src/guest-process-supervisor.js";

for (const cancel of [false, true]) {
  test(`guest supervisor removes TERM-ignoring descendants when ${cancel ? "cancelled" : "parent exits"}`, {skip: process.platform === "win32", timeout: 5000}, async () => {
    const childCode = 'process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)';
    const parentCode = `const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:["ignore","inherit","inherit","ipc"]}); c.on("message",()=>{process.stdout.write(String(c.pid)+"\\n");${cancel ? '' : 'process.exit(0);'}});setInterval(()=>{},1000);`;
    const supervisor = spawn(process.execPath, ["-e", GUEST_PROCESS_SUPERVISOR, process.execPath, "-e", parentCode], {env:{...process.env,RELAY_PROCESS_STOP_GRACE_MS:"20"}});
    let pid = 0;
    let stderr = "";
    supervisor.stderr.on("data", chunk => { stderr += chunk; });
    supervisor.stdout.on("data", chunk => { pid = Number(String(chunk).trim()); if (cancel) supervisor.kill("SIGTERM"); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => { supervisor.once("error",reject); supervisor.once("close",resolve); });
      assert.ok(pid > 0, stderr);
      assert.equal(code, cancel ? 130 : 0, stderr);
      assert.throws(() => process.kill(pid,0), /ESRCH/);
    } finally {
      supervisor.kill("SIGKILL");
      if (pid) { try { process.kill(pid,"SIGKILL"); } catch {} }
    }
  });
}

test("guest supervisor retains execution when a detached writer outlives its group", {skip: process.platform === "win32",timeout: 5000}, async () => {
  const childCode = 'process.send("ready");setInterval(()=>{},1000)';
  const parentCode = `const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{detached:true,stdio:["ignore","inherit","inherit","ipc"]});c.on("message",()=>{console.log(c.pid);process.exit(0)});`;
  const supervisor = spawn(process.execPath, ["-e", GUEST_PROCESS_SUPERVISOR, process.execPath, "-e", parentCode], {env:{...process.env,RELAY_PROCESS_STOP_GRACE_MS:"20"}});
  let pid = 0;
  let ready!: () => void;
  const childReady = new Promise<void>(resolve => {ready = resolve;});
  supervisor.stdout.on("data",chunk=>{pid = Number(String(chunk).trim());ready();});
  supervisor.stderr.resume();
  const closed = new Promise<number|null>(resolve=>supervisor.once("close",resolve));
  try {
    await childReady;
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(supervisor.exitCode,null,"an inherited writer needs reconciliation, not fabricated terminal evidence");
    process.kill(pid,"SIGKILL");
    await closed;
  } finally {
    if(pid>0){try{process.kill(pid,"SIGKILL");}catch{}}
    supervisor.kill("SIGKILL");
  }
});


test("Linux guest cleanup excludes zombies but retains live group members and unreadable process evidence", () => {
  const child = new EventEmitter() as EventEmitter & {pid: number; stdout: {pipe: () => void}; stderr: {pipe: () => void}};
  child.pid = 200;
  child.stdout = {pipe: () => {}};
  child.stderr = {pipe: () => {}};
  let tick!: () => void;
  let stat = "201 (child with spaces) S 1 200 200 0 0 0";
  let inaccessible = false;
  const warnings: string[] = [];
  const guest = {
    argv: ["node", "agent"], env: {}, platform: "linux", stdout: {},
    stderr: {write: (message: string) => warnings.push(message)},
    on: () => {}, kill: () => {}, exitCode: undefined as number | undefined,
  };
  runInNewContext(GUEST_PROCESS_SUPERVISOR, {
    process: guest,
    require: (name: string) => name === "node:child_process" ? {spawn: () => child} : {
      readdirSync: () => ["self", "201"],
      readFileSync: () => {if (inaccessible) throw new Error("permission denied"); return stat;},
    },
    setInterval: (callback: () => void) => {tick = callback;return 1;}, clearInterval: () => {},
  });
  child.emit("exit", 0);
  child.emit("close");
  tick();
  assert.equal(guest.exitCode,undefined,"a live member retains execution");
  inaccessible = true;
  tick();
  assert.equal(guest.exitCode,undefined,"missing evidence cannot release execution");
  assert.ok(warnings.some(message=>message.includes("Cannot verify")));
  inaccessible = false;
  stat = "201 (child with spaces) Z 1 200 200 0 0 0";
  tick();
  assert.equal(guest.exitCode,0,"a zombie cannot execute and does not prevent cleanup");
});
